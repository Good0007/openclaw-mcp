/**
 * OpenClaw MCP Server
 *
 * Exposes the OpenClaw Gateway WebSocket API as MCP tools, allowing any
 * MCP-compatible host (Claude Desktop, Cursor, VS Code Copilot, etc.) to
 * interact with OpenClaw directly.
 *
 * Configuration via environment variables:
 *   OPENCLAW_URL      Gateway WS URL (default: ws://127.0.0.1:18789)
 *   OPENCLAW_TOKEN    Auth token (gateway.auth.token)
 *   OPENCLAW_PASSWORD Auth password (gateway.auth.password)
 *   OPENCLAW_SESSION  Default session key  (default: "default")
 *
 * Usage in Claude Desktop / Cursor mcpServers config:
 *   {
 *     "openclaw": {
 *       "command": "node",
 *       "args": ["/path/to/mcp-server/dist/index.js"],
 *       "env": {
 *         "OPENCLAW_URL": "ws://127.0.0.1:18789",
 *         "OPENCLAW_TOKEN": "YOUR_TOKEN"
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GatewayClient, GatewayRpcError, chatSend } from "./gateway-client.js";

// ── Config ──────────────────────────────────────────────────────────────────

const GATEWAY_URL = process.env["OPENCLAW_URL"] ?? "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env["OPENCLAW_TOKEN"];
const GATEWAY_PASSWORD = process.env["OPENCLAW_PASSWORD"];
// "main" is the canonical alias for the gateway's primary session (agent:main:main).
// It is the same session used by the OpenClaw macOS/iOS app and WebChat UI.
// You can override with OPENCLAW_SESSION=<your-session-key>.
const DEFAULT_SESSION = process.env["OPENCLAW_SESSION"] ?? "main";
/** Branding name used in tool descriptions. Override with OPENCLAW_AGENT_NAME. */
const AGENT_NAME = process.env["OPENCLAW_AGENT_NAME"] ?? "OpenClaw";

function resolveAuth() {
  if (GATEWAY_TOKEN) return { type: "token" as const, token: GATEWAY_TOKEN };
  if (GATEWAY_PASSWORD) return { type: "password" as const, password: GATEWAY_PASSWORD };
  return { type: "none" as const };
}

// ── Gateway client (singleton, reconnects automatically) ────────────────────

const gateway = new GatewayClient({
  url: GATEWAY_URL,
  auth: resolveAuth(),
  clientId: "gateway-client",
  clientName: "openclaw-mcp-server",
  clientVersion: "1.0.0",
  reconnect: true,
});

// Forward errors to stderr so MCP host can observe them
gateway.on("error", (err: Error) => {
  process.stderr.write(`[openclaw-mcp] gateway error: ${err.message}\n`);
});
gateway.on("disconnected", ({ code }: { code: number }) => {
  process.stderr.write(`[openclaw-mcp] gateway disconnected (code ${code}), reconnecting…\n`);
});

// ── Helper ───────────────────────────────────────────────────────────────────

async function rpc<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  if (!gateway.isConnected) {
    throw new Error("Not connected to OpenClaw gateway. Check OPENCLAW_URL and auth settings.");
  }
  return gateway.request<T>(method, params, timeoutMs);
}

function fmtError(err: unknown): string {
  if (err instanceof GatewayRpcError) {
    return `Gateway error [${err.rpc.code}]: ${err.rpc.message}${err.rpc.details ? `\nDetails: ${JSON.stringify(err.rpc.details, null, 2)}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(obj: unknown) {
  return textResult(JSON.stringify(obj, null, 2));
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "openclaw",
  version: "1.0.0",
});

// ── Tool: chat_send ──────────────────────────────────────────────────────────

server.registerTool("chat_send", {
  description:
    `Send a message to ${AGENT_NAME} and wait for the complete AI response. ` +
    `Streams internally and returns the full assistant reply. ` +
    `Use this to have a conversation with the AI agent running inside ${AGENT_NAME}.`,
  inputSchema: {
    message: z.string().describe("The message to send to the AI agent"),
    session_key: z
      .string()
      .optional()
      .describe(`Session key (default: "${DEFAULT_SESSION}")`),
    thinking: z
      .enum(["auto", "low", "medium", "high"])
      .optional()
      .describe("AI thinking budget (default: auto)"),
    timeout_seconds: z
      .number()
      .int()
      .min(5)
      .max(600)
      .optional()
      .describe("Max wait time in seconds (default: 300)"),
  },
}, async ({ message, session_key, thinking, timeout_seconds }) => {
    try {
      const result = await chatSend(gateway, {
        sessionKey: session_key ?? DEFAULT_SESSION,
        message,
        thinking: thinking ?? undefined,
        timeoutMs: (timeout_seconds ?? 300) * 1000,
      });

      let reply = result.text || "(no text response)";
      if (result.aborted) reply = `[Aborted]\n${reply}`;
      if (result.errorMessage) reply = `[Error: ${result.errorMessage}]\n${reply}`;

      return textResult(reply);
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: chat_history ───────────────────────────────────────────────────────

server.registerTool("chat_history", {
  description:
    "Retrieve recent conversation history for a session. " +
    "Returns messages in chronological order.",
  inputSchema: {
    session_key: z
      .string()
      .optional()
      .describe(`Session key (default: "${DEFAULT_SESSION}")`),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max number of messages to return (default: 20)"),
  },
}, async ({ session_key, limit }) => {
    try {
      const result = await rpc<{ messages?: unknown[] }>("chat.history", {
        sessionKey: session_key ?? DEFAULT_SESSION,
        limit: limit ?? 20,
      });

      const messages = result?.messages ?? [];
      if (messages.length === 0) return textResult("No messages in history.");

      const lines: string[] = [];
      for (const msg of messages) {
        const m = msg as Record<string, unknown>;
        const role = String(m["role"] ?? "?").padEnd(9);
        let content = m["content"];
        if (Array.isArray(content)) {
          content = content
            .map((p) => {
              const part = p as Record<string, unknown>;
              return part["type"] === "text" ? String(part["text"] ?? "") : `[${part["type"]}]`;
            })
            .join("");
        }
        const text = typeof content === "string" ? content : JSON.stringify(content);
        const truncated = text.length > 500 ? text.slice(0, 500) + "…" : text;
        lines.push(`[${role}] ${truncated}`);
      }
      return textResult(lines.join("\n\n"));
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: chat_abort ─────────────────────────────────────────────────────────

server.registerTool("chat_abort", {
  description: "Abort a currently running AI response in a session.",
  inputSchema: {
    session_key: z
      .string()
      .optional()
      .describe(`Session key (default: "${DEFAULT_SESSION}")`),
    run_id: z.string().optional().describe("Specific run ID to abort (optional)"),
  },
}, async ({ session_key, run_id }) => {
    try {
      await rpc("chat.abort", {
        sessionKey: session_key ?? DEFAULT_SESSION,
        ...(run_id ? { runId: run_id } : {}),
      });
      return textResult("Aborted.");
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: send_message ───────────────────────────────────────────────────────

server.registerTool("send_message", {
  description:
    `Send a message through a specific ${AGENT_NAME} channel (Telegram, Discord, Slack, etc.) ` +
    "to a recipient. This sends the message directly without triggering AI.",
  inputSchema: {
    channel: z
      .string()
      .describe('Channel name, e.g. "telegram", "discord", "slack", "signal", "whatsapp"'),
    to: z.string().describe("Recipient identifier (phone number, user ID, channel name, etc.)"),
    message: z.string().describe("Message text to send"),
  },
}, async ({ channel, to, message }) => {
    try {
      await rpc("send", { channel, to, message });
      return textResult(`Message sent to ${to} via ${channel}.`);
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: channels_status ────────────────────────────────────────────────────

server.registerTool("channels_status", {
  description:
    "Check the connection status of all configured messaging channels " +
    "(Telegram, Discord, Slack, iMessage, WhatsApp, etc.).",
  inputSchema: {
    probe: z
      .boolean()
      .optional()
      .describe("Whether to actively probe each channel (slower but more accurate)"),
  },
}, async ({ probe }) => {
    try {
      const result = await rpc<{ channels?: unknown[] }>("channels.status", {
        probe: probe ?? false,
      });
      const channels = result?.channels ?? [];
      if (channels.length === 0) return textResult("No channels configured.");

      const lines = channels.map((ch) => {
        const c = ch as Record<string, unknown>;
        const name = String(c["channel"] ?? c["name"] ?? "?");
        const status = String(c["status"] ?? "?");
        const detail = c["detail"] ? ` — ${c["detail"]}` : "";
        return `• ${name}: ${status}${detail}`;
      });
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: health ─────────────────────────────────────────────────────────────

server.registerTool("health", {
  description:
    `Get the ${AGENT_NAME} gateway health status, including server version, ` +
    "uptime, active connections, and AI provider status.",
}, async () => {
    try {
      const result = await rpc<Record<string, unknown>>("health", {});
      return jsonResult(result);
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: sessions_list ──────────────────────────────────────────────────────

server.registerTool("sessions_list", {
  description:
    "List all available chat sessions, including their session keys, " +
    "message counts, and last activity timestamps.",
  inputSchema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max number of sessions (default: 50)"),
  },
}, async ({ limit }) => {
    try {
      const result = await rpc<{ sessions?: unknown[] }>("sessions.list", {
        limit: limit ?? 50,
      });
      const sessions = result?.sessions ?? [];
      if (sessions.length === 0) return textResult("No sessions found.");

      const lines = sessions.map((s) => {
        const sess = s as Record<string, unknown>;
        const key = String(sess["key"] ?? sess["sessionKey"] ?? "?");
        const count = sess["messageCount"] != null ? ` (${sess["messageCount"]} msgs)` : "";
        const active = sess["active"] ? " [active]" : "";
        const agent = sess["agentId"] ? ` agent=${sess["agentId"]}` : "";
        return `• ${key}${count}${active}${agent}`;
      });
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: agents_list ────────────────────────────────────────────────────────

server.registerTool("agents_list", {
  description: "List all configured AI agents with their IDs, names, default models, and descriptions.",
}, async () => {
    try {
      const result = await rpc<{ agents?: unknown[] }>("agents.list", {});
      const agents = result?.agents ?? [];
      if (agents.length === 0) return textResult("No agents configured.");

      const lines = agents.map((a) => {
        const ag = a as Record<string, unknown>;
        const id = String(ag["id"] ?? "?");
        const name = ag["name"] ? ` — ${ag["name"]}` : "";
        const model = ag["model"] ? ` [${ag["model"]}]` : "";
        const desc = ag["description"] ? `\n  ${ag["description"]}` : "";
        return `• ${id}${name}${model}${desc}`;
      });
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: config_get ─────────────────────────────────────────────────────────

server.registerTool("config_get", {
  description:
    `Read a configuration value from the ${AGENT_NAME} gateway. ` +
    'Pass an optional dot-notation key like "gateway.port" or "session.main" ' +
    "to read a specific value, or leave empty to get the full config.",
  inputSchema: {
    key: z
      .string()
      .optional()
      .describe('Config key in dot notation, e.g. "gateway.port", "session.main"'),
  },
}, async ({ key }) => {
    try {
      const result = await rpc<Record<string, unknown>>("config.get", key ? { key } : {});
      return jsonResult(result);
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: config_set ─────────────────────────────────────────────────────────

server.registerTool("config_set", {
  description:
    `Set a configuration value on the ${AGENT_NAME} gateway. ` +
    "The value is parsed as JSON, so use quoted strings for string values.",
  inputSchema: {
    key: z.string().describe('Config key in dot notation, e.g. "session.main"'),
    value: z.string().describe("JSON-encoded value, e.g. \"my-session\" or 18789 or true"),
  },
}, async ({ key, value }) => {
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        // treat as plain string if not valid JSON
        parsed = value;
      }
      await rpc("config.set", { key, value: parsed });
      return textResult(`Config ${key} updated.`);
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: models_list ────────────────────────────────────────────────────────

server.registerTool("models_list", {
  description:
    `List all available AI models configured in ${AGENT_NAME}, ` +
    "including provider information and which model is currently active.",
}, async () => {
    try {
      const result = await rpc<{ models?: unknown[]; active?: string }>("models.list", {});
      const models = result?.models ?? [];
      const active = result?.active;

      if (models.length === 0) return textResult("No models found.");
      const lines = models.map((m) => {
        const mo = m as Record<string, unknown>;
        const id = String(mo["id"] ?? mo["name"] ?? "?");
        const provider = mo["provider"] ? ` (${mo["provider"]})` : "";
        const isActive = id === active ? " ✓ [active]" : "";
        return `• ${id}${provider}${isActive}`;
      });
      if (active) lines.unshift(`Active: ${active}\n`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Tool: session_reset ──────────────────────────────────────────────────────

server.registerTool("session_reset", {
  description:
    "Reset (clear) the conversation history of a session. " +
    "This creates a fresh conversation context.",
  inputSchema: {
    session_key: z
      .string()
      .optional()
      .describe(`Session key to reset (default: "${DEFAULT_SESSION}")`),
    confirm: z
      .boolean()
      .describe("Must be true to confirm the destructive reset operation"),
  },
}, async ({ session_key, confirm }) => {
    if (!confirm) {
      return textResult("Aborted: set confirm=true to reset the session history.");
    }
    try {
      await rpc("sessions.reset", {
        sessionKey: session_key ?? DEFAULT_SESSION,
      });
      return textResult(`Session "${session_key ?? DEFAULT_SESSION}" has been reset.`);
    } catch (err) {
      return textResult(`Error: ${fmtError(err)}`);
    }
  },
);

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write(`[openclaw-mcp] connecting to ${GATEWAY_URL}…\n`);

  try {
    await gateway.connect();
    process.stderr.write("[openclaw-mcp] connected to gateway ✓\n");
  } catch (err) {
    process.stderr.write(
      `[openclaw-mcp] WARNING: initial gateway connection failed: ${err instanceof Error ? err.message : String(err)}\n` +
        "[openclaw-mcp] Will retry automatically. Tools will return errors until connected.\n",
    );
    // Don't exit — let the client background-reconnect.
    // Kick a reconnect manually since we exhausted the connect() promise.
    gateway.destroy();
    const reconnecting = new GatewayClient({
      url: GATEWAY_URL,
      auth: resolveAuth(),
      clientId: "gateway-client",
      clientName: "openclaw-mcp-server",
      clientVersion: "1.0.0",
      reconnect: true,
    });
    Object.assign(gateway, reconnecting);
    reconnecting.connect().catch(() => {
      /* retry loop handles it */
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[openclaw-mcp] MCP server ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`[openclaw-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
