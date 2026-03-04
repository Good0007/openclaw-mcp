# OpenClaw MCP Server

将 [OpenClaw](https://openclaw.ai) Gateway WebSocket API 封装为 [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) 服务，让任何支持 MCP 的宿主（Claude Desktop、Cursor、VS Code Copilot Chat 等）可以直接与 OpenClaw 交互。

## 功能特性

- 连接本地或远程 OpenClaw Gateway（支持 `ws://` 和 `wss://`）
- 启动时自动握手连接，断线后自动重连
- 12 个内置 MCP 工具，覆盖对话、渠道、配置、模型管理
- 单文件 CJS bundle，无需本地 `node_modules`

## 前提条件

- Node.js 22+
- [OpenClaw](https://openclaw.ai) Gateway 已在运行（本地默认 `ws://127.0.0.1:18789`，或远程 `wss://`）

## 环境变量

通过 MCP 宿主配置的 `env` 字段注入：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENCLAW_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket 地址 |
| `OPENCLAW_TOKEN` | — | 认证 token（对应 `gateway.auth.token`） |
| `OPENCLAW_PASSWORD` | — | 认证密码（对应 `gateway.auth.password`） |
| `OPENCLAW_SESSION` | `main` | 默认会话 key（`main` = `agent:main:main`） |
| `OPENCLAW_AGENT_NAME` | `OpenClaw` | 工具描述中显示的 AI 角色名称 |

> **查看本地 token**
>
> ```bash
> openclaw config get gateway.auth.token
> ```

## 快速开始（npx）

无需克隆仓库，直接通过 `npx` 使用，首次运行自动安装，后续使用缓存。

### 在 Claude Desktop 中配置

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）：

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "npx",
      "args": ["-y", "openclaw-mcp-server"],
      "env": {
        "OPENCLAW_URL": "ws://127.0.0.1:18789",
        "OPENCLAW_TOKEN": "your-gateway-token",
        "OPENCLAW_SESSION": "agent:xiaozhi",
        "OPENCLAW_AGENT_NAME": "小龙虾"
      }
    }
  }
}
```

### 在 Cursor 中配置

编辑 `~/.cursor/mcp.json`（或通过 Cursor Settings → MCP）：

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "npx",
      "args": ["-y", "openclaw-mcp-server"],
      "env": {
        "OPENCLAW_TOKEN": "your-token"
      }
    }
  }
}
```

### 在 VS Code Copilot Chat 中配置

编辑 `.vscode/mcp.json`（工作区级）或用户 `settings.json`（`mcp.servers`）：

```json
{
  "servers": {
    "openclaw": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "openclaw-mcp-server"],
      "env": {
        "OPENCLAW_TOKEN": "your-token"
      }
    }
  }
}
```

> `-y` 表示首次运行时自动安装，后续调用直接使用缓存，无额外开销。

### 固定版本（推荐生产使用）

```json
"args": ["-y", "openclaw-mcp-server@1.0.0"]
```

## 远程 Gateway（wss://）

若 Gateway 在远程机器上，直接传入 `wss://` 地址即可：

```json
"env": {
  "OPENCLAW_URL": "wss://your-gateway.example.com",
  "OPENCLAW_TOKEN": "your-token"
}
```

或者使用 SSH 隧道将远程端口转发到本地：

```bash
ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
```

然后保持 `OPENCLAW_URL=ws://127.0.0.1:18789`。

## 可用工具

| 工具 | 说明 |
|---|---|
| `chat_send` | 向 AI agent 发送消息，等待完整回复（内部自动处理流式） |
| `chat_history` | 获取会话历史记录 |
| `chat_abort` | 中止当前正在运行的 AI 回复 |
| `send_message` | 通过指定渠道（Telegram / Discord / Slack 等）直接发送消息 |
| `channels_status` | 检查所有消息渠道连接状态 |
| `health` | 获取 Gateway 健康状态 |
| `sessions_list` | 列出所有会话 |
| `session_reset` | 清空会话历史（需要 `confirm=true`） |
| `agents_list` | 列出所有已配置的 AI agents |
| `config_get` | 读取 Gateway 配置项 |
| `config_set` | 写入 Gateway 配置项 |
| `models_list` | 列出可用 AI 模型及当前激活的模型 |

## 本地构建使用（node）

如需从源码构建或二次开发，可本地安装后使用 `node` 直接运行。

### 安装

```bash
cd mcp-server
npm install
npm run build
```

构建产物为 `dist/index.cjs`（单文件，已打包全部依赖）。

### 在 Claude Desktop 中配置

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）：

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "node",
      "args": ["/path/to/openclaw/mcp-server/dist/index.cjs"],
      "env": {
        "OPENCLAW_URL": "ws://127.0.0.1:18789",
        "OPENCLAW_TOKEN": "your-gateway-token"
      }
    }
  }
}
```

### 在 Cursor 中配置

编辑 `~/.cursor/mcp.json`（或通过 Cursor Settings → MCP）：

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "node",
      "args": ["/path/to/openclaw/mcp-server/dist/index.cjs"],
      "env": {
        "OPENCLAW_TOKEN": "your-token"
      }
    }
  }
}
```

### 在 VS Code Copilot Chat 中配置

编辑 `.vscode/mcp.json`（工作区级）或用户 `settings.json`（`mcp.servers`）：

```json
{
  "servers": {
    "openclaw": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/openclaw/mcp-server/dist/index.cjs"],
      "env": {
        "OPENCLAW_TOKEN": "your-token"
      }
    }
  }
}
```

## 开发模式

```bash
npm run dev   # 直接运行 TypeScript，无需编译
npm run build # 编译为 dist/index.cjs
```

## 常见问题

**连接失败 / 认证错误**

1. 确认 OpenClaw Gateway 正在运行：`openclaw channels status`
2. 确认 token 正确：`openclaw config get gateway.auth.token`
3. 若提示 `missing scope`，检查 token 是否具有 `operator.admin` 权限

**MCP 宿主显示 `[warning] [server stderr]`**

正常现象。MCP 协议规定 stdout 专用于 JSON-RPC，所有状态日志必须写 stderr，宿主会统一标记为 `[server stderr]`。

## 发布到 npm

本包已完整配置 `bin` 入口与单文件 CJS bundle，维护者可按以下步骤发布新版本：

```bash
# 首次登录
npm login

# 构建并发布（已在 prepublishOnly 中自动执行 build）
npm run release
# 等价于：npm publish --access public
```

## License

[MIT](./LICENSE) © OpenClaw Contributors
