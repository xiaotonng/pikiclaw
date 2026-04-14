<div align="center">

# pikiclaw

**Put the world's smartest AI agents in your pocket. Command local Claude, Codex & Gemini via IM.**

*Turn Telegram, Feishu, or WeChat into a full-featured Agent console on your computer*

```
npx pikiclaw@latest
```

<p>
<a href="https://www.npmjs.com/package/pikiclaw"><img src="https://img.shields.io/npm/v/pikiclaw" alt="npm"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-18+-green.svg" alt="Node.js 18+"></a>
</p>

<img src="docs/workspace.png" alt="Workspace" width="700">

</div>

## Demo

> Real task: ask pikiclaw to gather and summarize today's AI news — the agent reads, writes, and sends results back through Telegram, all from your phone.

<img src="docs/promo-demo.gif" alt="Demo" width="700">

> Basic operations: send a message, watch the agent stream, receive files back.

<img src="docs/promo-basic-ops.gif" alt="Basic operations" width="700">

> Web Dashboard: multi-panel workspace with session list, conversation view, tool-use traces, and input composer (1 / 2 / 3 / 6 pane layouts).

<img src="docs/promo-dashboard-workspace.png" alt="Workspace" width="700">

<details>
<summary>More dashboard pages</summary>

**IM Access** — Telegram, Feishu, WeChat channel status and configuration

<img src="docs/promo-dashboard-im.png" alt="IM Access" width="700">

**Agent Config** — Default agent / model / reasoning effort, available agents overview

<img src="docs/promo-dashboard-agents.png" alt="Agent Config" width="700">

**System Permissions** — macOS accessibility, screen recording, disk access

<img src="docs/promo-dashboard-permissions.png" alt="Permissions" width="700">

**Extensions** — Global MCP servers, community skills, and built-in browser & desktop automation

<img src="docs/promo-dashboard-extensions.png" alt="Extensions" width="700">

**System Info** — Working directory, CPU / memory / disk monitoring

<img src="docs/promo-dashboard-system.png" alt="System Info" width="700">

</details>

---

## Why pikiclaw?

Most "IM + Agent" solutions either reinvent the agent (worse than official CLIs), run in remote sandboxes (not your environment), or only support short conversations (unusable for real tasks).

pikiclaw takes a different approach:

- **Official Agent CLIs** — Claude Code, Codex, Gemini CLI as-is, not a home-grown wrapper
- **Your own machine** — local files, local tools, local environment
- **Your existing IM** — Telegram, Feishu, or WeChat, no new app to learn
- **Community extensions** — install MCP servers and skills from the ecosystem with one click

```
  You (Telegram / Feishu / WeChat)
          |
          v
       pikiclaw  <--  MCP servers & community skills
          |
          v
  Claude Code / Codex / Gemini CLI
          |
          v
     Your Computer
```

It's designed for the moment you walk away from your desk — the agent keeps working locally, and you stay in control from your phone.

---

## Quick Start

### Prerequisites

- Node.js 18+
- At least one Agent CLI installed and logged in:
  - [`claude`](https://docs.anthropic.com/en/docs/claude-code) (Claude Code)
  - [`codex`](https://github.com/openai/codex) (Codex CLI)
  - [`gemini`](https://github.com/google-gemini/gemini-cli) (Gemini CLI)
- A bot token for your IM channel (Telegram Bot Token, Feishu app credentials, or WeChat account)

### Install & Launch

```bash
cd your-workspace
npx pikiclaw@latest
```

<img src="docs/promo-install.gif" alt="Quick install" width="700">

This opens the **Web Dashboard** at `http://localhost:3939`, where you can:

- Drive agent sessions directly from the browser — full conversation, tool use, streaming
- Connect IM channels (Telegram / Feishu / WeChat)
- Configure agents, models, and reasoning effort
- Browse and install community MCP servers and skills
- Manage macOS system permissions and automation extensions
- Monitor sessions and system resources

<details>
<summary>Alternative: terminal setup wizard</summary>

```bash
npx pikiclaw@latest --setup   # interactive terminal wizard
npx pikiclaw@latest --doctor  # check environment only
```

</details>

---

## Features

### Channels & Agents

- Telegram, Feishu, and WeChat — run one or all simultaneously
- Claude Code, Codex CLI, and Gemini CLI via unified driver registry
- Model listing, session management, and usage tracking through a single interface

### Extensions & Community Plugins

pikiclaw has a two-layer extension system — **global** extensions apply to all projects, **workspace** extensions are project-scoped.

**MCP Servers** — browse recommended servers, search the [MCP Registry](https://registry.modelcontextprotocol.io), or add custom servers (stdio / HTTP):

<img src="docs/promo-dashboard-extensions-add.png" alt="Add MCP Server" width="700">

**Project Extensions** — each workspace has its own MCP servers (`.mcp.json`) and skills (`.pikiclaw/skills/`), managed from the workspace sidebar:

<img src="docs/promo-workspace-extensions.png" alt="Project Extensions" width="700">

- Browse recommended servers (GitHub, Filesystem, PostgreSQL, Slack, Brave Search, Memory, Fetch, SQLite, Git, Sentry)
- Search the MCP Registry for community servers
- Add custom servers with environment variable configuration
- Health check with MCP protocol handshake and tool discovery
- Enable / disable individual servers per scope

**Community Skills**
- Install skills from GitHub repos with one click (`owner/repo`)
- Browse recommended skill repos (Anthropic Official, Vercel Agent Skills, etc.)
- Search community skills via npm
- Skills can declare MCP dependencies via `mcp_requires`
- Global skills (`~/.pikiclaw/skills/`) and project skills (`.pikiclaw/skills/`)

All extensions are merged with priority (global < workspace < built-in) and injected into agent sessions automatically.

### Skills

- Project-level skills at `.pikiclaw/skills/*/SKILL.md`
- Compatible with `.claude/commands/*.md`
- Legacy `.claude/skills` / `.agents/skills` support with migration path
- Install from GitHub or browse recommended repos via the dashboard
- Trigger via `/skills` and `/sk_<name>` in chat

### Runtime

- Streaming preview with continuous message updates
- Session switching, resume, and multi-turn conversations
- Session classification (answer, proposal, implementation, blocked, etc.)
- Task queue with **Steer** — interrupt the running task and let a queued message jump ahead
- Working directory browsing and switching
- File attachments automatically enter the session workspace
- Long-task sleep prevention, watchdog, and auto-restart
- Long text auto-splitting; images and files sent back to IM directly
- Light / dark theme and i18n (Chinese & English)

### MCP Bridge & Automation

Each agent stream launches a session-scoped MCP bridge that injects tools from three sources:

1. **Built-in tools** — `im_list_files`, `im_send_file` (send files back to IM in real time)
2. **User extensions** — all enabled MCP servers (global + workspace) are merged and registered
3. **GUI automation** (optional):
   - **Browser** — managed Chrome profile via `@playwright/mcp`; log in once, reuse across tasks
   - **Desktop** — Appium Mac2 with `desktop_open_app`, `desktop_snapshot`, `desktop_click`, `desktop_type`, `desktop_screenshot`

### Codex Human Loop

When Codex requests additional user input mid-task, pikiclaw surfaces the question as an interactive prompt in your IM. Reply there and the task continues.

---

## Commands

| Command | Description |
|---|---|
| `/start` | Show entry info, current agent, working directory |
| `/sessions` | View, switch, or create sessions |
| `/agents` | Switch agent |
| `/models` | View and switch model / reasoning effort |
| `/mode` | Toggle plan mode (reasoning effort) |
| `/switch` | Browse and switch working directory |
| `/stop` | Stop current session |
| `/status` | Runtime status, tokens, usage, session info |
| `/host` | Host CPU / memory / disk / battery |
| `/skills` | Browse project skills |
| `/ext` | Extensions overview |
| `/restart` | Restart and re-launch bot |
| `/sk_<name>` | Run a project skill |

Plain text messages are forwarded directly to the current agent.

---

## Configuration

- Persistent config lives in `~/.pikiclaw/setting.json`
- The Dashboard is the primary configuration interface
- Global MCP extensions are stored in `~/.pikiclaw/setting.json` under `extensions.mcp`
- Workspace MCP extensions use the standard `.mcp.json` format

<details>
<summary>GUI automation setup</summary>

**Browser automation** is managed by the dashboard — a dedicated Chrome profile is created and reused automatically. Log in to the sites you need once in that browser and every future agent session can reuse those credentials.

**macOS desktop automation** requires Appium Mac2:

```bash
npm install -g appium
appium driver install mac2
appium
```

Then grant macOS Accessibility permission to your terminal app.

Relevant environment variables:
- `PIKICLAW_DESKTOP_GUI`
- `PIKICLAW_DESKTOP_APPIUM_URL`

</details>

---

## Roadmap

- **ACP (Agent Client Protocol) adoption** — unified driver for any ACP-compatible agent, replacing per-agent CLI output parsing. See [ACP Migration Plan](docs/acp-migration.md)
- Expand extension ecosystem — more recommended MCP servers, skill templates, and community tooling
- Improve GUI automation, especially browser + desktop tool coordination
- More IM channels (WhatsApp, etc.)

---

## Development

```bash
git clone https://github.com/xiaotonng/pikiclaw.git
cd pikiclaw
npm install
npm run build
npm test
```

```bash
npm run dev          # local dev (--no-daemon, logs to ~/.pikiclaw/dev/dev.log)
npm run build        # production build
npm test             # unit tests
npm run test:e2e     # end-to-end tests
npx pikiclaw@latest --doctor  # environment check
```

See also: [ARCHITECTURE.md](ARCHITECTURE.md) · [INTEGRATION.md](INTEGRATION.md) · [TESTING.md](TESTING.md)

---

## Contributing

Contributions are welcome! Whether it's a bug fix, new feature, or documentation improvement — we appreciate your help.

- Read the **[Contributing Guide](CONTRIBUTING.md)** to get started
- Check out [`good first issue`](https://github.com/xiaotonng/pikiclaw/labels/good%20first%20issue) and [`help wanted`](https://github.com/xiaotonng/pikiclaw/labels/help%20wanted) labels for contribution ideas
- Open an issue first for larger changes so we can discuss the approach

Common contribution areas:

| Task | Where to start |
|------|----------------|
| Add an agent driver | `src/agent/driver.ts`, `src/agent/drivers/*.ts` |
| Add an IM channel | `src/channels/base.ts`, any `src/channels/*/` |
| Add a dashboard route | `src/dashboard/routes/*.ts` |
| Change MCP tools | `src/agent/mcp/tools/*.ts`, `src/agent/mcp/bridge.ts` |

---

## License

[MIT](LICENSE)
