<div align="center">

# codeclaw

**The best IM-driven remote coding experience. Period.**

IM 交互体验最好的远程编程工具。没有之一。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/codeclaw)](https://www.npmjs.com/package/codeclaw)

[English](#english) | [中文](#中文)

</div>

---

<a id="english"></a>

## Why codeclaw?

Most "AI + IM" bridges just forward messages. codeclaw is built from scratch for **the best possible remote coding experience over instant messaging**:

- **Real-time streaming** — token-by-token output via Telegram message edits; you see the AI thinking live, not a wall of text after 2 minutes
- **System-level keep-alive** — triggers OS-level power assertions to prevent your laptop from sleeping, so long-running tasks finish even when you walk away
- **Multi-agent hot-switch** — Claude Code + Codex CLI, switch with a single `/agents` command
- **True multi-session** — named sessions with persistent thread IDs; restart codeclaw, resume exactly where you left off
- **One command** — `npx codeclaw` and you're running

```
Telegram (your phone / desktop)
  ↕ long poll
codeclaw (your machine, your project dir)
  ↕ subprocess
claude / codex CLI
  ↕ reads & writes
your codebase
```

No server. No Docker. No config files. Just one process bridging Telegram to your local AI agent.

## Features

- **Multi-agent** — Claude Code + Codex CLI, hot-switch via `/agents` inline keyboard
- **Streaming** — real-time token-by-token output via Telegram message edits
- **Multi-session** — per-chat session management with named sessions, pagination, and resume
- **Keep-alive** — OS-level sleep prevention (macOS `caffeinate`, Linux `systemd-inhibit`)
- **Directory browser** — switch working directory interactively via `/switch` with inline navigation
- **Image input** — send photos to the bot for visual context (screenshots, diagrams)
- **Artifact return** — agent can write screenshots/files to a per-turn manifest and codeclaw uploads them back to Telegram
- **Quick replies** — auto-detects yes/no questions and numbered options, shows inline buttons
- **Long output** — responses exceeding Telegram limits are split with a full `.md` file attachment
- **Thinking display** — shows agent thinking/reasoning process in collapsible blocks
- **Token tracking** — per-turn and cumulative input/output/cached token counts
- **Provider usage** — `/status` shows recent Codex/Claude usage windows and reset timing when local telemetry is available
- **Access control** — restrict by chat/user ID whitelist
- **Startup notice** — sends online status to all known chats on startup
- **Full access / safe mode** — let the agent run freely, or require confirmation before destructive actions

## Quick Start

### Using npx (recommended)

```bash
cd your-project/
npx codeclaw -t YOUR_BOT_TOKEN
```

### Global install

```bash
npm install -g codeclaw
cd your-project/
codeclaw -t YOUR_BOT_TOKEN
```

> **Prerequisites:** Node.js 18+, `claude` CLI and/or `codex` CLI installed, a Telegram Bot Token from [@BotFather](https://t.me/BotFather).

## CLI Options

```
codeclaw [options]
```

### Core

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `-c, --channel` | `CODECLAW_CHANNEL` | `telegram` | IM channel: `telegram` (feishu, whatsapp planned) |
| `-t, --token` | `CODECLAW_TOKEN` | — | Bot token (or channel-specific env below) |
| `-a, --agent` | `DEFAULT_AGENT` | `claude` | AI agent: `claude` or `codex` |
| `-m, --model` | — | `claude-opus-4-6` / `gpt-5.4` | Model override (maps to agent-specific env) |
| `-w, --workdir` | `CODECLAW_WORKDIR` | `.` | Working directory for the agent |

### Access Control

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--full-access` | `CODECLAW_FULL_ACCESS` | `true` | Agent can read/write/execute without confirmation |
| `--safe-mode` | — | `false` | Require confirmation before destructive operations |
| `--allowed-ids` | `TELEGRAM_ALLOWED_CHAT_IDS` | — | Comma-separated chat/user ID whitelist |
| `--timeout` | `CODECLAW_TIMEOUT` | `900` | Max seconds per agent request |

### Channel-specific Environment Variables

| Env | Description |
|-----|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (from @BotFather) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated allowed Telegram chat IDs |

### Agent-specific Environment Variables

| Env | Default | Description |
|-----|---------|-------------|
| `CLAUDE_MODEL` | `claude-opus-4-6` | Claude model name |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | `bypassPermissions` or `default` |
| `CLAUDE_EXTRA_ARGS` | — | Extra CLI args passed to `claude` |
| `CODEX_MODEL` | `gpt-5.4` | Codex model name |
| `CODEX_REASONING_EFFORT` | `xhigh` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `CODEX_FULL_ACCESS` | `true` | Bypass sandbox and approval prompts |
| `CODEX_EXTRA_ARGS` | — | Extra CLI args passed to `codex` |

### Examples

```bash
# Basic: Telegram + Claude Code, full access
npx codeclaw -t $BOT_TOKEN

# Codex agent, safe mode, restricted users
npx codeclaw -t $BOT_TOKEN -a codex --safe-mode --allowed-ids 123456,789012

# Custom model, custom working directory
npx codeclaw -t $BOT_TOKEN -m sonnet -w ~/projects/my-app

# Using environment variables
TELEGRAM_BOT_TOKEN=xxx CODEX_MODEL=o3 npx codeclaw -a codex
```

## Bot Commands

Once running, these commands are available in Telegram:

| Command | Description |
|---------|-------------|
| `/sessions` | List, switch, or create sessions (paginated inline keyboard) |
| `/agents` | List installed agents, switch between them |
| `/switch` | Browse and change working directory (interactive file browser) |
| `/status` | Bot status: uptime, memory, agent, session, provider usage, token usage |
| `/host` | Host machine info: CPU, memory, disk, top processes |
| `/restart` | Restart with latest version via `npx --yes codeclaw@latest` |
| `/start` | Welcome message with command list |

> In private chats, just send text directly — no command prefix needed. Any unrecognized `/command` is forwarded to the agent as a prompt.

## Development

```bash
# 1. Install dependencies
npm install

# 2. Create .env file with your tokens
echo "TELEGRAM_BOT_TOKEN=your_token_here" > .env

# 3. Run locally
set -a && source .env && npx tsx src/cli.ts

# 4. Run tests
npm test
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the layered design:

```
cli.ts → bot-telegram.ts → bot.ts → code-agent.ts
                ↓
         channel-telegram.ts
```

- **bot.ts** — channel-agnostic business logic, state, streaming bridge
- **bot-telegram.ts** — Telegram-specific rendering, keyboards, callbacks, artifact upload flow
- **channel-telegram.ts** — pure Telegram API transport (polling, sending, file download/upload routing)
- **code-agent.ts** — AI agent abstraction (spawn CLI, parse JSONL stream, inspect local usage telemetry)

Adding a new IM channel means creating `channel-xxx.ts` + `bot-xxx.ts` without touching shared logic.

## License

[MIT](LICENSE)

---

<a id="中文"></a>

<div align="center">

# codeclaw

**IM 交互体验最好的远程编程工具。没有之一。**

</div>

## 为什么选 codeclaw？

大多数「AI + IM」桥接工具只是转发消息。codeclaw 从零开始为 **即时通讯上最好的远程编程体验** 而构建：

- **实时流式输出** — 通过 Telegram 消息编辑逐 token 推送；你能实时看到 AI 的思考过程，而不是等 2 分钟后收到一大段文字
- **系统级保活** — 触发操作系统级电源断言，防止笔记本休眠，确保长时间任务在你离开后依然完整执行
- **多 Agent 热切换** — Claude Code + Codex CLI，一条 `/agents` 命令即可切换
- **真正的多会话** — 命名会话 + 持久化线程 ID；重启 codeclaw 后可以无缝恢复之前的对话
- **一条命令启动** — `npx codeclaw` 即可运行

```
Telegram（手机 / 桌面端）
  ↕ 长轮询
codeclaw（你的机器，你的项目目录）
  ↕ 子进程
claude / codex CLI
  ↕ 读写
你的代码库
```

不需要服务器，不需要 Docker，不需要配置文件。一个进程把 Telegram 桥接到你本地的 AI 编程助手。

## 功能特性

- **多 Agent** — Claude Code + Codex CLI，通过 `/agents` 内联键盘热切换
- **流式输出** — 通过 Telegram 消息编辑实时逐 token 输出
- **多会话** — 每个聊天支持命名会话管理、分页浏览和线程恢复
- **系统保活** — 操作系统级防休眠（macOS `caffeinate`、Linux `systemd-inhibit`）
- **目录浏览器** — 通过 `/switch` 交互式切换工作目录，内联导航
- **图片输入** — 向机器人发送图片提供视觉上下文（截图、设计图）
- **产物回传** — Agent 可按每轮 manifest 写出截图/文件，codeclaw 会自动回传到 Telegram
- **快捷回复** — 自动检测是/否问题和编号选项，显示内联按钮
- **长文本处理** — 超出 Telegram 限制的回复自动拆分，并附带完整 `.md` 文件
- **思考展示** — 在可折叠区块中显示 Agent 的思考/推理过程
- **Token 统计** — 每轮和累计的输入/输出/缓存 token 计数
- **Provider 用量** — `/status` 可展示最近的 Codex/Claude 用量窗口和重置时间（本地遥测可用时）
- **访问控制** — 按聊天/用户 ID 白名单限制
- **启动通知** — 启动时向所有已知聊天发送在线状态
- **完全访问 / 安全模式** — 让 AI 自由运行，或限制危险操作需确认

## 快速开始

### 使用 npx（推荐）

```bash
cd your-project/
npx codeclaw -t YOUR_BOT_TOKEN
```

### 全局安装

```bash
npm install -g codeclaw
cd your-project/
codeclaw -t YOUR_BOT_TOKEN
```

> **前置条件：** Node.js 18+，`claude` CLI 和/或 `codex` CLI 已安装，从 [@BotFather](https://t.me/BotFather) 获取 Telegram Bot Token。

## 命令行选项

```
codeclaw [选项]
```

### 核心参数

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `-c, --channel` | `CODECLAW_CHANNEL` | `telegram` | IM 渠道：`telegram`（feishu、whatsapp 规划中） |
| `-t, --token` | `CODECLAW_TOKEN` | — | Bot token（或下方渠道专属环境变量） |
| `-a, --agent` | `DEFAULT_AGENT` | `claude` | AI Agent：`claude` 或 `codex` |
| `-m, --model` | — | `claude-opus-4-6` / `gpt-5.4` | 模型覆盖（映射到 Agent 专属环境变量） |
| `-w, --workdir` | `CODECLAW_WORKDIR` | `.` | 工作目录 |

### 访问控制

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `--full-access` | `CODECLAW_FULL_ACCESS` | `true` | Agent 可以无需确认地读写执行 |
| `--safe-mode` | — | `false` | 执行危险操作前需确认 |
| `--allowed-ids` | `TELEGRAM_ALLOWED_CHAT_IDS` | — | 允许交互的聊天/用户 ID，逗号分隔 |
| `--timeout` | `CODECLAW_TIMEOUT` | `900` | 每次请求最大秒数 |

### 渠道专属环境变量

| 环境变量 | 说明 |
|---------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（来自 @BotFather） |
| `TELEGRAM_ALLOWED_CHAT_IDS` | 允许的 Telegram 聊天 ID，逗号分隔 |

### Agent 专属环境变量

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `CLAUDE_MODEL` | `claude-opus-4-6` | Claude 模型名 |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | `bypassPermissions` 或 `default` |
| `CLAUDE_EXTRA_ARGS` | — | 传递给 `claude` CLI 的额外参数 |
| `CODEX_MODEL` | `gpt-5.4` | Codex 模型名 |
| `CODEX_REASONING_EFFORT` | `xhigh` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `CODEX_FULL_ACCESS` | `true` | 跳过沙箱和确认提示 |
| `CODEX_EXTRA_ARGS` | — | 传递给 `codex` CLI 的额外参数 |

### 使用示例

```bash
# 基本用法：Telegram + Claude Code，完全访问
npx codeclaw -t $BOT_TOKEN

# Codex Agent，安全模式，限制用户
npx codeclaw -t $BOT_TOKEN -a codex --safe-mode --allowed-ids 123456,789012

# 自定义模型和工作目录
npx codeclaw -t $BOT_TOKEN -m sonnet -w ~/projects/my-app

# 使用环境变量
TELEGRAM_BOT_TOKEN=xxx CODEX_MODEL=o3 npx codeclaw -a codex
```

## 机器人命令

运行后，以下命令可在 Telegram 中使用：

| 命令 | 说明 |
|------|------|
| `/sessions` | 列出、切换或创建会话（分页内联键盘） |
| `/agents` | 列出已安装的 Agent，切换使用 |
| `/switch` | 浏览和切换工作目录（交互式文件浏览器） |
| `/status` | 机器人状态：运行时间、内存、Agent、会话、Provider 用量、Token 用量 |
| `/host` | 宿主机信息：CPU、内存、磁盘、进程排行 |
| `/restart` | 通过 `npx --yes codeclaw@latest` 拉取最新版本并重启 |
| `/start` | 欢迎消息和命令列表 |

> 在私聊中直接发送文字即可，无需命令前缀。未识别的 `/命令` 会作为 prompt 转发给 Agent。

## 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 创建 .env 文件写入 token
echo "TELEGRAM_BOT_TOKEN=your_token_here" > .env

# 3. 本地运行
set -a && source .env && npx tsx src/cli.ts

# 4. 运行测试
npm test
```

## 架构

详见 [ARCHITECTURE.md](ARCHITECTURE.md)：

```
cli.ts → bot-telegram.ts → bot.ts → code-agent.ts
                ↓
         channel-telegram.ts
```

- **bot.ts** — 渠道无关的业务逻辑、状态管理、流式桥接
- **bot-telegram.ts** — Telegram 专属渲染、键盘、回调处理
- **channel-telegram.ts** — 纯 Telegram API 传输层（轮询、发送、文件下载）
- **code-agent.ts** — AI Agent 抽象（启动 CLI 子进程、解析 JSONL 流）

添加新 IM 渠道只需创建 `channel-xxx.ts` + `bot-xxx.ts`，无需修改共享逻辑。

## 许可证

[MIT](LICENSE)
