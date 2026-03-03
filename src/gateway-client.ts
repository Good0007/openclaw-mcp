/**
 * OpenClaw Gateway WebSocket client.
 *
 * Protocol summary:
 *  1. Server sends   { type:"event", event:"connect.challenge", payload:{ nonce, ts } }
 *  2. Client sends   { type:"req", id, method:"connect", params: ConnectParams }
 *  3. Server replies { type:"res", id, ok:true, payload: HelloOk }  (type:"hello-ok")
 *  4. After that, any { type:"req", id, method, params } → { type:"res", id, ok, payload/error }
 *     and server pushes { type:"event", event, payload } asynchronously.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PROTOCOL_VERSION = 3;
const DEFAULT_URL = "ws://127.0.0.1:18789";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_PAYLOAD = 25 * 1024 * 1024;

export type GatewayAuthOptions =
  | { type: "token"; token: string }
  | { type: "password"; password: string }
  | { type: "none" };

export interface GatewayClientConfig {
  url?: string;
  auth?: GatewayAuthOptions;
  /** Client identifier - use "gateway-client" for custom integrations */
  clientId?: string;
  /** Client display name (shown in gateway logs) */
  clientName?: string;
  clientVersion?: string;
  platform?: string;
  /** Auto-reconnect on unexpected close (default: true) */
  reconnect?: boolean;
  reconnectDelayMs?: number;
}

export interface RpcError {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}

export class GatewayRpcError extends Error {
  constructor(public readonly rpc: RpcError) {
    super(`[${rpc.code}] ${rpc.message}`);
    this.name = "GatewayRpcError";
  }
}

export type ChatEventState = "delta" | "final" | "aborted" | "error";

export interface ChatEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  state: ChatEventState;
  message?: unknown;
  errorMessage?: string;
  usage?: unknown;
  stopReason?: string;
}

/**
 * Low-level gateway client. Manages reconnection, handshake, pending RPC calls,
 * and event emission.
 *
 * Usage:
 *   const client = new GatewayClient({ auth: { type:"token", token:"xxx" } });
 *   await client.connect();
 *   const result = await client.request("health", {});
 *   client.on("chat", (payload) => { ... });
 */
export class GatewayClient extends EventEmitter {
  private config: Required<GatewayClientConfig>;
  private ws: WebSocket | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }
  >();
  private connected = false;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectNonce: string | null = null;
  private readyPromise: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(config: GatewayClientConfig = {}) {
    super();
    this.config = {
      url: config.url ?? DEFAULT_URL,
      auth: config.auth ?? { type: "none" },
      clientId: config.clientId ?? "gateway-client",
      clientName: config.clientName ?? "openclaw-mcp",
      clientVersion: config.clientVersion ?? "1.0.0",
      platform: config.platform ?? process.platform,
      reconnect: config.reconnect ?? true,
      reconnectDelayMs: config.reconnectDelayMs ?? 3000,
    };
  }

  /** Connect and wait for handshake to complete. */
  async connect(): Promise<void> {
    if (this.closed) throw new Error("GatewayClient has been destroyed");
    return new Promise<void>((resolve, reject) => {
      this.readyPromise = { resolve, reject };
      this._open();
    });
  }

  /** Destroy the client, no reconnect. */
  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this._closeWs();
  }

  /** Send an RPC request and wait for the response. */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.connected) throw new Error("Not connected to gateway");
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this._send({ type: "req", id, method, params });
    });
  }

  /** Whether the client is currently connected and past the handshake. */
  get isConnected(): boolean {
    return this.connected;
  }

  // ── private ──────────────────────────────────────────────────────────────

  private _open(): void {
    if (this.closed) return;

    const ws = new WebSocket(this.config.url, {
      maxPayload: MAX_PAYLOAD,
    });
    this.ws = ws;

    // Handshake timeout
    const handshakeTimer = setTimeout(() => {
      if (!this.connected) {
        ws.terminate();
        this.readyPromise?.reject(new Error("Gateway handshake timeout"));
        this.readyPromise = null;
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on("open", () => {
      // nothing to do; wait for server challenge
    });

    ws.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = frame["type"];

      // ── event frame ──────────────────────────────────────────────────────
      if (type === "event") {
        const event = frame["event"] as string | undefined;
        const payload = frame["payload"] as Record<string, unknown> | undefined;

        if (event === "connect.challenge") {
          // Server challenge received - send connect request
          clearTimeout(handshakeTimer);
          this.connectNonce = (payload?.["nonce"] as string | undefined) ?? null;
          this._sendConnect();
          return;
        }

        // Broadcast all other events to listeners
        if (event) {
          this.emit(event, payload);
          this.emit("*", { event, payload });
        }
        return;
      }

      // ── response frame ───────────────────────────────────────────────────
      if (type === "res") {
        const id = frame["id"] as string | undefined;
        if (!id) return;
        const ok = frame["ok"] as boolean;
        const payload = frame["payload"];
        const error = frame["error"] as RpcError | undefined;

        // Check if this is the connect response
        if (payload && typeof payload === "object" && (payload as Record<string, unknown>)["type"] === "hello-ok") {
          this.connected = true;
          this.readyPromise?.resolve();
          this.readyPromise = null;
          this.pending.delete(id); // clean up if tracked
          return;
        }

        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);

        if (ok) {
          pending.resolve(payload);
        } else {
          pending.reject(
            error ? new GatewayRpcError(error) : new Error("RPC request failed"),
          );
        }
        return;
      }
    });

    ws.on("close", (code, reason) => {
      clearTimeout(handshakeTimer);
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;

      // Reject all pending requests
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`Gateway disconnected (code ${code})`));
      }
      this.pending.clear();

      this.emit("disconnected", { code, reason: reason.toString() });

      if (!wasConnected && this.readyPromise) {
        this.readyPromise.reject(
          new Error(`Gateway connection closed before handshake (code ${code}): ${reason}`),
        );
        this.readyPromise = null;
      }

      if (!this.closed && this.config.reconnect) {
        this.reconnectTimer = setTimeout(() => {
          if (!this.closed) this._open();
        }, this.config.reconnectDelayMs);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(handshakeTimer);
      if (!this.connected && this.readyPromise) {
        this.readyPromise.reject(err);
        this.readyPromise = null;
      }
      this.emit("error", err);
    });
  }

  private _sendConnect(): void {
    const { auth, clientId, clientName, clientVersion, platform } = this.config;
    const authParam =
      auth.type === "token"
        ? { token: auth.token }
        : auth.type === "password"
          ? { password: auth.password }
          : undefined;

    this._send({
      type: "req",
      id: randomUUID(),
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        role: "operator",
        scopes: ["operator.admin"],
        client: {
          id: clientId,
          displayName: clientName,
          version: clientVersion,
          platform,
          mode: "backend",
        },
        ...(authParam ? { auth: authParam } : {}),
      },
    });
  }

  private _send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private _closeWs(): void {
    try {
      this.ws?.terminate();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}

// ── Convenience: collect full chat response ────────────────────────────────

export interface ChatSendResult {
  /** Full assembled text content */
  text: string;
  /** Last message object from "final" event */
  message?: unknown;
  usage?: unknown;
  stopReason?: string;
  runId: string;
  aborted: boolean;
  errorMessage?: string;
}

/**
 * Send a chat message and wait for the complete response (collects all delta+final events).
 */
export async function chatSend(
  client: GatewayClient,
  params: {
    sessionKey: string;
    message: string;
    thinking?: string;
    timeoutMs?: number;
  },
): Promise<ChatSendResult> {
  const idempotencyKey = randomUUID();
  const timeoutMs = params.timeoutMs ?? 5 * 60 * 1000;

  return new Promise<ChatSendResult>((resolve, reject) => {
    let runId: string | null = null;
    let textParts: string[] = [];
    let lastMessage: unknown;
    let usage: unknown;
    let stopReason: string | undefined;

    const timer = setTimeout(() => {
      client.off("chat", handler);
      reject(new Error(`chat.send timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (payload: ChatEvent) => {
      if (!payload || typeof payload !== "object") return;

      // Match by runId once we know it, or accept any event initially
      if (runId && payload.runId !== runId) return;

      if (!runId) runId = payload.runId;

      const { state } = payload;

      if (state === "delta" || state === "final") {
        // Extract text from message content
        const msg = payload.message as Record<string, unknown> | undefined;
        if (msg) {
          const content = msg["content"];
          if (typeof content === "string") {
            textParts.push(content);
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part === "object" && (part as Record<string, unknown>)["type"] === "text") {
                const t = (part as Record<string, unknown>)["text"];
                if (typeof t === "string") textParts.push(t);
              }
            }
          }
          lastMessage = msg;
        }
        if (payload.usage) usage = payload.usage;
        if (payload.stopReason) stopReason = payload.stopReason;
      }

      if (state === "final") {
        clearTimeout(timer);
        client.off("chat", handler);
        resolve({
          text: textParts.join(""),
          message: lastMessage,
          usage,
          stopReason,
          runId: runId!,
          aborted: false,
        });
      } else if (state === "aborted") {
        clearTimeout(timer);
        client.off("chat", handler);
        resolve({
          text: textParts.join(""),
          message: lastMessage,
          usage,
          runId: runId!,
          aborted: true,
        });
      } else if (state === "error") {
        clearTimeout(timer);
        client.off("chat", handler);
        reject(new Error(payload.errorMessage ?? "Chat run error"));
      }
    };

    client.on("chat", handler as (...args: unknown[]) => void);

    // Send the request (fire-and-forget the RPC ack; we wait for events instead)
    client
      .request("chat.send", {
        sessionKey: params.sessionKey,
        message: params.message,
        thinking: params.thinking,
        idempotencyKey,
        timeoutMs,
      })
      .catch((err) => {
        clearTimeout(timer);
        client.off("chat", handler);
        reject(err);
      });
  });
}
