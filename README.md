# codeclaw

One binary. Zero config. Bridge your local AI coding agents to any IM.

```
cd your-project/
codeclaw -c telegram -t BOT_TOKEN
```

That's it. Your AI coding agent is now accessible from your phone.

## What it does

codeclaw runs in your project directory, connects to your IM, and pipes every message to a local AI coding agent (Claude Code / Codex CLI). The agent reads your codebase, writes code, runs commands — and streams the output back to your chat in real time.

```
IM (Telegram/Slack/Discord/...)
  ↕ long poll / websocket
codeclaw (your machine, your project dir)
  ↕ subprocess
claude / codex CLI
  ↕ reads & writes
your codebase
```

No server. No Docker. No config files. Just one process bridging your IM to your local agent.

## Features

- **Any IM** — Telegram now; Slack, Discord, DingTalk, Feishu/Lark coming next
- **Dual engine** — Claude Code + Codex CLI, hot-switch with `/engine`
- **Streaming** — real-time token-by-token output via message edits
- **Battle mode** — `/battle <prompt>` runs both engines, compare side-by-side
- **Sessions** — per-chat multi-session with thread resume
- **Full access** — let the agent run freely, or lock it down with safe mode
- **Zero dependencies** — pure Python stdlib, single file, single binary

## Quick start

### From source

```bash
cd your-project/
python3 codeclaw.py -c telegram -t YOUR_BOT_TOKEN
```

### From binary

```bash
cd your-project/
curl -fsSL https://github.com/user/codeclaw/releases/latest/download/codeclaw -o codeclaw
chmod +x codeclaw
./codeclaw -c telegram -t YOUR_BOT_TOKEN
```

## CLI

```
codeclaw [options]
```

### Core

| Flag | Env | Description |
|------|-----|-------------|
| `-c, --channel` | `CODECLAW_CHANNEL` | IM channel: `telegram`, `slack`, `discord`, `dingtalk`, `feishu` |
| `-t, --token` | `CODECLAW_TOKEN` | Bot token for the IM |
| `-e, --engine` | `DEFAULT_ENGINE` | AI engine: `claude` (default) or `codex` |
| `-w, --workdir` | `CODECLAW_WORKDIR` | Working directory (default: `.`) |
| `-m, --model` | `CLAUDE_MODEL` / `CODEX_MODEL` | Model override |

### Access control

| Flag | Env | Description |
|------|-----|-------------|
| `--full-access` | `CODECLAW_FULL_ACCESS` | Agent can read, write, and execute without confirmation (default) |
| `--safe-mode` | `CODECLAW_SAFE_MODE` | Agent asks for confirmation before destructive ops |
| `--allowed-ids` | `CODECLAW_ALLOWED_IDS` | Comma-separated user/chat IDs allowed to interact |
| `--timeout` | `CODECLAW_TIMEOUT` | Max seconds per request (default: `300`) |

### Engine-specific

| Env | Description |
|-----|-------------|
| `CLAUDE_MODEL` | Claude model (e.g. `sonnet`, `opus`) |
| `CLAUDE_PERMISSION_MODE` | Permission mode: `bypassPermissions`, `default`, etc. |
| `CLAUDE_EXTRA_ARGS` | Extra CLI args passed to `claude` |
| `CODEX_MODEL` | Codex model (e.g. `o3`, `o4-mini`) |
| `CODEX_REASONING_EFFORT` | Reasoning effort: `low`, `medium`, `high`, `xhigh` |
| `CODEX_EXTRA_ARGS` | Extra CLI args passed to `codex` |

### Examples

```bash
# Telegram + Claude, full access
codeclaw -c telegram -t $BOT_TOKEN

# Slack + Codex, safe mode, restricted users
codeclaw -c slack -t $SLACK_TOKEN -e codex --safe-mode --allowed-ids U123,U456

# Discord + Claude, custom model
codeclaw -c discord -t $DISCORD_TOKEN -m sonnet

# DingTalk + Claude
codeclaw -c dingtalk -t $DINGTALK_TOKEN

# Feishu/Lark + Claude
codeclaw -c feishu -t $FEISHU_TOKEN

# Override working directory
codeclaw -c telegram -t $BOT_TOKEN -w ~/projects/my-app
```

## Bot commands

These work across all IM channels:

| Command | Description |
|---------|-------------|
| `/ask <prompt>` | Ask the AI agent |
| `/engine [codex\|claude]` | Show or switch engine |
| `/battle <prompt>` | Run both engines, compare results |
| `/new [prompt]` | Reset session (optionally start a new one) |
| `/session list\|use\|new\|del` | Multi-session management |
| `/status` | Show current session / engine / thread info |
| `/clear [N]` | Delete bot's recent messages (default 50) |
| `/help` | Show all commands |

In private/DM chats, just send text directly — no command prefix needed.

On startup, codeclaw sends an online notice to all known chats with engine and workdir info.

## Build

```bash
pip install pyinstaller
./build.sh        # outputs dist/codeclaw (~7 MB)
```

## How it works

1. codeclaw starts a long-poll (or websocket) loop against your IM's bot API
2. When a message arrives, it spawns `claude -p --output-format stream-json` or `codex exec --json` as a subprocess in your working directory
3. It reads the JSONL output line by line and edits the chat message every 1.5s with accumulated text
4. Thread IDs are persisted to `~/.codeclaw/state.json` for session continuity

The AI agent has full access to your local filesystem and tools — same as running it in your terminal.

## Why codeclaw

| | codeclaw | OpenClaw | cc-connect |
|-|----------|----------|------------|
| Install | 10 sec | 20+ min | 5 min |
| Dependencies | 0 | Node.js ecosystem | Node.js + config |
| Config files | 0 | YAML + plugins | YAML |
| Binary size | 7 MB | ~200 MB | N/A |
| IM channels | 5+ | 20+ | 1 |
| AI engines | Claude + Codex | 20+ providers | 4 agents |
| Battle mode | Yes | No | No |

codeclaw does less, on purpose. One binary that bridges your IM to your local coding agent. If you need 20 providers and a plugin system, use OpenClaw. If you want something that just works, use codeclaw.

## License

MIT
