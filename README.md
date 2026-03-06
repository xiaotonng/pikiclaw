<div align="center">

# codeclaw

**The best IM-driven remote coding experience. Period.**

IM 交互体验最好的远程编程工具。没有之一。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-green.svg)](https://www.python.org)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen.svg)]()

[English](#english) | [中文](#中文)

</div>

---

<a id="english"></a>

## Why codeclaw?

Most "AI + IM" bridges just forward messages. codeclaw is built from scratch for **the best possible remote coding experience over instant messaging**:

- **Real-time streaming** — token-by-token output via Telegram message edits; you see the AI thinking live, not a wall of text after 2 minutes
- **System-level keep-alive** — triggers OS-level power assertions to prevent your laptop from sleeping, so long-running tasks finish even when you walk away
- **Dual engine hot-switch** — Claude Code + Codex CLI in one binary, switch with a single command
- **Battle mode** — run both engines in parallel on the same prompt, compare side-by-side
- **True multi-session** — named sessions with persistent thread IDs; restart codeclaw, resume exactly where you left off
- **Zero dependencies, single binary** — pure Python stdlib, ~7 MB, runs anywhere Python runs

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

## Comparison with Alternatives

### vs. Claude Code + Telegram Projects

| Feature | codeclaw | claude-code-telegram | claudecode-telegram | claude-telegram-bot-bridge | ccbot | claudegram |
|---------|----------|---------------------|--------------------|-----------------------------|-------|------------|
| Streaming output (live edits) | **Yes** | Yes | Partial | Partial | No | No |
| Dual engine (Claude + Codex) | **Yes** | No | No | No | No | No |
| Battle mode (parallel compare) | **Yes** | No | No | No | No | No |
| Multi-session management | **Yes** | Yes | No | No | Partial (tmux) | No |
| Session persistence (resume after restart) | **Yes** | Yes | No | No | Partial | No |
| Keep-alive (prevent system sleep) | **Yes** | No | No | No | No | No |
| Zero dependencies | **Yes** | No (Node.js) | No | No | No (tmux) | No |
| Single binary distribution | **Yes** | No | No | No | No | No |
| Image/photo input support | **Yes** | Partial | No | No | No | No |
| Paginated long output | **Yes** | No | No | No | N/A | No |
| Access control (user/chat whitelist) | **Yes** | Partial | No | No | No | No |

### vs. Multi-IM / Multi-Engine Platforms

| Feature | codeclaw | cc-connect | OpenClaw | Claude-to-IM-skill | heyagent |
|---------|----------|------------|----------|---------------------|----------|
| IM platforms | Telegram | Telegram, Slack, Discord, 飞书, 钉钉, LINE, 企业微信 | 20+ (Telegram, WhatsApp, Slack, Discord, Signal, iMessage...) | Telegram, Discord, 飞书 | Telegram |
| AI engines | Claude Code, Codex | Claude Code, Codex, Gemini, Cursor | Claude, Codex, local LLM | Claude Code, Codex | Claude Code, Codex |
| Streaming (live token output) | **Yes** | Partial | Partial | No | No |
| Battle mode | **Yes** | No | No | No | No |
| Keep-alive (prevent sleep) | **Yes** | No | No | No | No |
| Zero dependencies | **Yes** | No | No | No | No |
| Single binary (~7 MB) | **Yes** | No | No | No | No |
| Setup time | **~10 seconds** | Minutes | Minutes | Minutes | Minutes |
| Config files needed | **0** | YAML | YAML + plugins | Config | Config |

> **Our philosophy:** codeclaw intentionally focuses on **one IM channel done right** rather than many done poorly. If you need 20 IM platforms, use OpenClaw or cc-connect. If you want **the best Telegram remote coding experience** — the fastest streaming, the smoothest interaction, and zero setup friction — use codeclaw.

### Keep-Alive: Your Laptop Stays Awake

When codeclaw is running, it triggers **OS-level power assertions** to prevent your machine from sleeping. This means:

- Long-running AI tasks (refactoring, large codegen, test suites) **complete reliably** even if you walk away from the keyboard
- No more coming back to find your screen locked, SSH session dropped, or AI agent frozen mid-task due to idle sleep
- Works on **macOS** (caffeinate) and **Linux** (systemd-inhibit)

This is a critical feature for remote coding — you send a task from your phone, the laptop stays awake and keeps working. (Note: closing the lid on most laptops will still trigger hardware-level sleep — keep the lid open for best results.)

## Features

- **Dual engine** — Claude Code + Codex CLI, hot-switch with `/engine`
- **Streaming** — real-time token-by-token output via Telegram message edits
- **Battle mode** — `/battle <prompt>` runs both engines in parallel, compare side-by-side
- **Multi-session** — per-chat session management with named sessions and thread resume
- **Keep-alive** — OS-level sleep prevention ensures long tasks complete uninterrupted
- **Full access / safe mode** — let the agent run freely, or lock it down
- **Zero dependencies** — pure Python stdlib, single file, single binary (~7 MB)
- **Image input** — send photos to the bot for visual context (screenshots, diagrams)
- **Paginated output** — long responses are split into navigable pages with inline buttons
- **Auto-start notice** — sends online status to all known chats on startup
- **Access control** — restrict by chat/user ID whitelist

## Quick Start

### From binary (recommended)

Download the binary for your platform from [Releases](https://github.com/xiaotonng/codeclaw/releases):

```bash
# macOS (Apple Silicon)
curl -fsSL https://github.com/xiaotonng/codeclaw/releases/latest/download/codeclaw-darwin-arm64 -o codeclaw

# macOS (Intel)
curl -fsSL https://github.com/xiaotonng/codeclaw/releases/latest/download/codeclaw-darwin-x86_64 -o codeclaw

# Linux (x86_64)
curl -fsSL https://github.com/xiaotonng/codeclaw/releases/latest/download/codeclaw-linux-x86_64 -o codeclaw

# Then:
chmod +x codeclaw
cd your-project/
./codeclaw -t YOUR_BOT_TOKEN
```

### From source

```bash
cd your-project/
python3 codeclaw.py -t YOUR_BOT_TOKEN
```

> **Prerequisites:** Python 3.10+, `claude` CLI and/or `codex` CLI in PATH, a Telegram Bot Token from [@BotFather](https://t.me/BotFather).

## CLI Options

```
codeclaw [options]
```

### Core

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `-c, --channel` | `CODECLAW_CHANNEL` | `telegram` | IM channel |
| `-t, --token` | `CODECLAW_TOKEN` | — | Bot token |
| `-e, --engine` | `DEFAULT_ENGINE` | `claude` | AI engine: `claude` or `codex` |
| `-w, --workdir` | `CODECLAW_WORKDIR` | `.` | Working directory |
| `-m, --model` | `CLAUDE_MODEL` / `CODEX_MODEL` | — | Model override |

### Access Control

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--full-access` | `CODECLAW_FULL_ACCESS` | `true` | Agent can read/write/execute without confirmation |
| `--safe-mode` | `CODECLAW_SAFE_MODE` | `false` | Agent asks before destructive operations |
| `--allowed-ids` | `CODECLAW_ALLOWED_IDS` | — | Comma-separated user/chat IDs whitelist |
| `--timeout` | `CODECLAW_TIMEOUT` | `300` | Max seconds per request |

### Engine-specific

| Env | Description |
|-----|-------------|
| `CLAUDE_MODEL` | Claude model (e.g. `sonnet`, `opus`) |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` (default) or `default` |
| `CLAUDE_EXTRA_ARGS` | Extra CLI args passed to `claude` |
| `CODEX_MODEL` | Codex model (e.g. `o3`, `o4-mini`) |
| `CODEX_REASONING_EFFORT` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `CODEX_EXTRA_ARGS` | Extra CLI args passed to `codex` |

### Examples

```bash
# Basic: Telegram + Claude Code, full access
codeclaw -t $BOT_TOKEN

# Codex engine, safe mode, restricted users
codeclaw -t $BOT_TOKEN -e codex --safe-mode --allowed-ids 123456,789012

# Custom model, custom working directory
codeclaw -t $BOT_TOKEN -m sonnet -w ~/projects/my-app

# Validate setup without starting
codeclaw -t $BOT_TOKEN --self-check
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/ask <prompt>` | Ask the AI agent |
| `/engine [codex\|claude]` | Show or switch engine |
| `/battle <prompt>` | Run both engines, compare results |
| `/new [prompt]` | Reset session (optionally start new one) |
| `/session list\|use\|new\|del` | Multi-session management |
| `/status` | Show current session / engine / thread info |
| `/stop` | Clear current session thread |
| `/clear [N]` | Delete bot's recent messages (default 50) |
| `/help` | Show all commands |

> In private/DM chats, just send text directly — no command prefix needed.

## Build

```bash
pip install pyinstaller
./build.sh          # outputs dist/codeclaw (~7 MB)
```

For cross-platform builds, see [build-all.sh](build-all.sh).

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
- **双引擎热切换** — Claude Code + Codex CLI 集于一个二进制文件，一条命令即可切换
- **对战模式** — 同一个 prompt 同时跑两个引擎，结果并排对比
- **真正的多会话** — 命名会话 + 持久化线程 ID；重启 codeclaw 后可以无缝恢复之前的对话
- **零依赖、单二进制** — 纯 Python 标准库，~7 MB，有 Python 的地方就能跑

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

## 竞品对比

### vs. Claude Code + Telegram 专项工具

| 特性 | codeclaw | claude-code-telegram | claudecode-telegram | claude-telegram-bot-bridge | ccbot | claudegram |
|------|----------|---------------------|--------------------|-----------------------------|-------|------------|
| 流式输出（实时编辑） | **支持** | 支持 | 部分 | 部分 | 不支持 | 不支持 |
| 双引擎（Claude + Codex） | **支持** | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| 对战模式（并行对比） | **支持** | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| 多会话管理 | **支持** | 支持 | 不支持 | 不支持 | 部分（tmux） | 不支持 |
| 会话持久化（重启恢复） | **支持** | 支持 | 不支持 | 不支持 | 部分 | 不支持 |
| 保活（防止系统休眠） | **支持** | 不支持 | 不支持 | 不支持 | 不支持 | 不支持 |
| 零依赖 | **是** | 否（Node.js） | 否 | 否 | 否（tmux） | 否 |
| 单二进制分发 | **是** | 否 | 否 | 否 | 否 | 否 |
| 图片输入支持 | **支持** | 部分 | 不支持 | 不支持 | 不支持 | 不支持 |
| 长文本分页 | **支持** | 不支持 | 不支持 | 不支持 | N/A | 不支持 |
| 访问控制（白名单） | **支持** | 部分 | 不支持 | 不支持 | 不支持 | 不支持 |

### vs. 多 IM / 多引擎平台

| 特性 | codeclaw | cc-connect | OpenClaw | Claude-to-IM-skill | heyagent |
|------|----------|------------|----------|---------------------|----------|
| IM 平台 | Telegram | Telegram、Slack、Discord、飞书、钉钉、LINE、企业微信 | 20+（Telegram、WhatsApp、Slack、Discord、Signal、iMessage…） | Telegram、Discord、飞书 | Telegram |
| AI 引擎 | Claude Code、Codex | Claude Code、Codex、Gemini、Cursor | Claude、Codex、本地 LLM | Claude Code、Codex | Claude Code、Codex |
| 流式输出（实时 token） | **支持** | 部分 | 部分 | 不支持 | 不支持 |
| 对战模式 | **支持** | 不支持 | 不支持 | 不支持 | 不支持 |
| 保活（防休眠） | **支持** | 不支持 | 不支持 | 不支持 | 不支持 |
| 零依赖 | **是** | 否 | 否 | 否 | 否 |
| 单二进制（~7 MB） | **是** | 否 | 否 | 否 | 否 |
| 部署时间 | **约 10 秒** | 数分钟 | 数分钟 | 数分钟 | 数分钟 |
| 需要配置文件 | **0 个** | YAML | YAML + 插件 | 配置文件 | 配置文件 |

> **我们的理念：** codeclaw 有意专注于 **把一个 IM 渠道做到极致**，而非什么都做但都做不好。如果你需要 20 个 IM 平台，用 OpenClaw 或 cc-connect。如果你想要 **最好的 Telegram 远程编程体验** —— 最快的流式输出、最流畅的交互、零配置摩擦 —— 用 codeclaw。

### 保活：你的笔记本始终亮屏

codeclaw 运行时会触发 **操作系统级电源断言**，防止你的机器进入休眠。这意味着：

- 长时间 AI 任务（重构、大量代码生成、测试套件）即使你 **离开键盘** 也能可靠完成
- 不再出现回来发现屏幕锁定、SSH 断开、AI 跑到一半因空闲休眠而卡住的情况
- 支持 **macOS**（caffeinate）和 **Linux**（systemd-inhibit）

这是远程编程的关键功能 —— 你从手机上发一个任务，笔记本保持唤醒状态持续工作。（注意：合上盖子在大多数笔记本上仍会触发硬件级休眠，建议保持开盖。）

## 功能特性

- **双引擎** — Claude Code + Codex CLI，用 `/engine` 命令热切换
- **流式输出** — 通过 Telegram 消息编辑实时逐 token 输出
- **对战模式** — `/battle <prompt>` 同时运行两个引擎，结果并排对比
- **多会话** — 每个聊天支持命名会话管理和线程恢复
- **系统保活** — 操作系统级防休眠，确保长任务不中断
- **完全访问 / 安全模式** — 让 AI 自由运行，或限制危险操作需确认
- **零依赖** — 纯 Python 标准库，单文件，单二进制（~7 MB）
- **图片输入** — 向机器人发送图片提供视觉上下文（截图、设计图）
- **长文本分页** — 长回复自动分页，内联按钮翻页浏览
- **启动通知** — 启动时向所有已知聊天发送在线状态
- **访问控制** — 按聊天/用户 ID 白名单限制

## 快速开始

### 使用二进制文件（推荐）

从 [Releases](https://github.com/xiaotonng/codeclaw/releases) 下载对应平台的二进制文件：

```bash
# macOS (Apple Silicon)
curl -fsSL https://github.com/xiaotonng/codeclaw/releases/latest/download/codeclaw-darwin-arm64 -o codeclaw

# macOS (Intel)
curl -fsSL https://github.com/xiaotonng/codeclaw/releases/latest/download/codeclaw-darwin-x86_64 -o codeclaw

# Linux (x86_64)
curl -fsSL https://github.com/xiaotonng/codeclaw/releases/latest/download/codeclaw-linux-x86_64 -o codeclaw

# Windows (x86_64)
# 下载 codeclaw-windows-x86_64.exe

# 然后：
chmod +x codeclaw
cd your-project/
./codeclaw -t 你的BOT_TOKEN
```

### 从源码运行

```bash
cd your-project/
python3 codeclaw.py -t 你的BOT_TOKEN
```

> **前置条件：** Python 3.10+，`claude` CLI 和/或 `codex` CLI 在 PATH 中，从 [@BotFather](https://t.me/BotFather) 获取 Telegram Bot Token。

## 命令行选项

```
codeclaw [选项]
```

### 核心参数

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `-c, --channel` | `CODECLAW_CHANNEL` | `telegram` | IM 渠道 |
| `-t, --token` | `CODECLAW_TOKEN` | — | Bot token |
| `-e, --engine` | `DEFAULT_ENGINE` | `claude` | AI 引擎：`claude` 或 `codex` |
| `-w, --workdir` | `CODECLAW_WORKDIR` | `.` | 工作目录 |
| `-m, --model` | `CLAUDE_MODEL` / `CODEX_MODEL` | — | 模型覆盖 |

### 访问控制

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `--full-access` | `CODECLAW_FULL_ACCESS` | `true` | AI 可以无需确认地读写执行 |
| `--safe-mode` | `CODECLAW_SAFE_MODE` | `false` | AI 在执行危险操作前需确认 |
| `--allowed-ids` | `CODECLAW_ALLOWED_IDS` | — | 允许交互的用户/聊天 ID，逗号分隔 |
| `--timeout` | `CODECLAW_TIMEOUT` | `300` | 每次请求最大秒数 |

### 引擎专属配置

| 环境变量 | 说明 |
|---------|------|
| `CLAUDE_MODEL` | Claude 模型（如 `sonnet`、`opus`） |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions`（默认）或 `default` |
| `CLAUDE_EXTRA_ARGS` | 传递给 `claude` CLI 的额外参数 |
| `CODEX_MODEL` | Codex 模型（如 `o3`、`o4-mini`） |
| `CODEX_REASONING_EFFORT` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `CODEX_EXTRA_ARGS` | 传递给 `codex` CLI 的额外参数 |

### 使用示例

```bash
# 基本用法：Telegram + Claude Code，完全访问
codeclaw -t $BOT_TOKEN

# Codex 引擎，安全模式，限制用户
codeclaw -t $BOT_TOKEN -e codex --safe-mode --allowed-ids 123456,789012

# 自定义模型和工作目录
codeclaw -t $BOT_TOKEN -m sonnet -w ~/projects/my-app

# 验证配置（不启动）
codeclaw -t $BOT_TOKEN --self-check
```

## 机器人命令

| 命令 | 说明 |
|------|------|
| `/ask <prompt>` | 向 AI 提问 |
| `/engine [codex\|claude]` | 查看或切换引擎 |
| `/battle <prompt>` | 同时运行两个引擎，对比结果 |
| `/new [prompt]` | 重置会话（可选带 prompt 开始新对话） |
| `/session list\|use\|new\|del` | 多会话管理 |
| `/status` | 查看当前会话/引擎/线程信息 |
| `/stop` | 清除当前会话线程 |
| `/clear [N]` | 删除机器人最近的消息（默认 50 条） |
| `/help` | 显示所有命令 |

> 在私聊中直接发送文字即可，无需命令前缀。

## 构建

```bash
pip install pyinstaller
./build.sh          # 输出 dist/codeclaw (~7 MB)
```

跨平台构建见 [build-all.sh](build-all.sh)。

## 许可证

[MIT](LICENSE)
