<div align="center">

# pikiclaw

## Put the world's smartest AI agents in your pocket.

##### *The open Agent orchestrator for the era when creators no longer need to read code.*

*Plug in any agent (Claude · Codex · Gemini · Hermes · …), any model (Claude · GPT · Gemini · DeepSeek · 豆包 · MiMo · MiniMax · OpenRouter · or any third-party proxy), any tool (Skills · MCP · CLI). Drive them from any terminal — IM, Web, or future. Pikiclaw is built using pikiclaw.*

```bash
npx pikiclaw@latest
```

<p>
<a href="https://www.npmjs.com/package/pikiclaw"><img src="https://img.shields.io/npm/v/pikiclaw?label=npm&color=cb3837" alt="npm"></a>
<a href="https://www.npmjs.com/package/pikiclaw"><img src="https://img.shields.io/npm/dm/pikiclaw?label=downloads&color=success" alt="npm downloads"></a>
<a href="https://github.com/xiaotonng/pikiclaw/stargazers"><img src="https://img.shields.io/github/stars/xiaotonng/pikiclaw?style=flat&color=yellow" alt="GitHub stars"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520-green.svg" alt="Node 20+"></a>
</p>

<p>
<b>English</b> | <a href="README.zh-CN.md">简体中文</a>
</p>

<img src="docs/workspace.png" alt="Workspace" width="780">

</div>

---

## What is pikiclaw?

**Most "AI dev tool" projects pick one slice — one IDE, one agent, one model vendor — and stop there.** pikiclaw is built around a different bet: the next era of building does not happen inside a single editor. It happens through an **orchestrator** that lets a creator drive a *swarm* of agents — in parallel, from one console — on the best models, through whatever terminal is closest at hand. And never open a code file.

The product is the orchestrator. Everything else plugs in. **And the orchestrator is built using itself** — pikiclaw is what we use to build pikiclaw.

```
   Terminal layer    Telegram · Feishu · WeChat · Slack · Discord · DingTalk · WeCom · Web Dashboard
                              \__________________________|__________________________/
                                                         v
                                          ┌──────────────────────────────┐
                                          │     pikiclaw orchestrator    │
                                          └──────────────────────────────┘
                                                         |
                ┌────────────────────────────────────────┼────────────────────────────────────────┐
                v                                        v                                        v
         Agent layer                              Model layer                               Tool layer
   Claude Code · Codex · Gemini · Hermes    Claude · GPT · Gemini · DeepSeek           Skills · MCP · CLI
   (driver registry · ACP · any agent)      豆包 · MiMo · MiniMax · OpenRouter         (global × workspace)
                                            · any OpenAI-compatible proxy · …
                                                         |
                                                         v
                                                   Your computer
```

- **Terminal layer** — Telegram, Feishu, WeChat, Slack, Discord, DingTalk, WeCom, and the Web Dashboard are co-equal entry points. New terminals plug in here.
- **Agent layer** — Official Claude Code / Codex / Gemini / Hermes CLIs as drivers. Hermes speaks ACP (Agent Client Protocol); the registry takes any agent.
- **Model layer** — Claude / GPT / Gemini, the domestic Chinese series (DeepSeek, 豆包, MiMo, MiniMax), plus OpenRouter and any OpenAI-compatible proxy. Providers + Profiles are a first-class layer with their own credential vault, models.dev catalog, and per-agent injection.
- **Tool layer** — Skills, MCP servers, and CLI tools merged across global and workspace scopes, injected into every session.

---

## Built with itself

> The most credible test of an Agent orchestrator is whether it can build itself. pikiclaw can. We use pikiclaw to develop, test, release, and operate pikiclaw — every commit, every release.

A typical day-of-development inside pikiclaw:

- A Claude Code session in window 1 implements a new dashboard route.
- A Codex session in window 2 writes the matching unit tests, against the same workspace.
- A Gemini session in window 3 reviews the diff and drafts the changelog.
- A skill (`/sk_promote`) sweeps GitHub for relevant issues and replies in a fourth thread.
- All four streams run in parallel; one human steers them from a phone in a coffee shop.

The orchestrator is the product. It also happens to be the IDE the orchestrator is built in.

---

## A swarm by default

Most "AI dev tools" assume one user, one agent, one task at a time. pikiclaw assumes the opposite: **N agents, N windows, one operator, one toolkit.**

- **N parallel sessions** — every dashboard pane is an independent agent stream against an independent session workspace; IM threads add even more.
- **Mix-and-match agents** — Claude Code in pane 1, Codex in pane 2, Gemini in pane 3, all on different repos / workspaces.
- **One toolkit** — global skills, global MCP servers, and per-workspace overrides apply uniformly. You configure once; every session inherits.
- **Steer anywhere** — interrupt any running stream, queue a follow-up, hand control to the next agent in line.
- **Group-mode** — drop the orchestrator into a Feishu / Slack / Discord / WeCom group; teammates share the same swarm.

This is the shape that matters: one creator, with a swarm at their fingertips.

---

## See it in action

> **Real task** — ask pikiclaw to gather and summarize today's AI news; the agent reads, writes, and ships the result back through Telegram, all from your phone.

<p align="center"><img src="docs/promo-demo.gif" alt="Demo: ask Telegram, agent works locally, result returns to chat" width="780"></p>

> **Web Dashboard** — multi-pane workspace with session list, conversation, tool-use traces, and input composer (1 / 2 / 3 / 6 pane layouts).

<p align="center"><img src="docs/promo-dashboard-workspace.png" alt="Web Dashboard workspace" width="780"></p>

<details>
<summary><b>More: basic ops · IM access · agents · models · extensions · permissions · system info</b></summary>

> Send a message, watch the agent stream, receive files back.

<img src="docs/promo-basic-ops.gif" alt="Basic operations" width="780">

> **IM Access** — Telegram, Feishu, WeChat, Slack, Discord, DingTalk, WeCom channel status and configuration

<img src="docs/promo-dashboard-im.png" alt="IM Access" width="780">

> **Agents** — installed agent CLIs, default agent, per-agent model / reasoning effort

<img src="docs/promo-dashboard-agents.png" alt="Agents" width="780">

> **Models** — Providers + Profiles vault (Claude, GPT, Gemini, DeepSeek, 豆包, MiMo, MiniMax, OpenRouter, any OpenAI-compatible proxy), validated against models.dev catalog and injected per agent

> **Extensions** — global MCP servers, community skills, managed browser + macOS desktop (Peekaboo) automation

<img src="docs/promo-dashboard-extensions.png" alt="Extensions" width="780">

> **System Permissions** — macOS accessibility, screen recording, disk access

<img src="docs/promo-dashboard-permissions.png" alt="Permissions" width="780">

> **System Info** — working directory, CPU / memory / disk monitoring

<img src="docs/promo-dashboard-system.png" alt="System Info" width="780">

</details>

---

## Quick start

**Prereqs:** Node.js 20+, plus at least one official Agent CLI logged in:

- [`claude`](https://docs.anthropic.com/en/docs/claude-code) (Claude Code)
- [`codex`](https://github.com/openai/codex) (Codex CLI)
- [`gemini`](https://github.com/google-gemini/gemini-cli) (Gemini CLI)
- `hermes` (Hermes — via ACP / Agent Client Protocol)

**Launch:**

```bash
cd your-workspace
npx pikiclaw@latest
```

<p align="center"><img src="docs/promo-install.gif" alt="One-command install" width="780"></p>

That opens the **Web Dashboard** at `http://localhost:3939` — drive sessions in the browser, connect IM channels, configure agents/models, install MCP servers and skills, manage system permissions. Everything else is one click away.

<details>
<summary><b>Prefer the terminal? There's a wizard.</b></summary>

```bash
npx pikiclaw@latest --setup    # interactive terminal wizard
npx pikiclaw@latest --doctor   # environment check only
```

</details>

---

## What people do with it

- **Run a swarm in parallel** — open N sessions in N dashboard panes (or N IM threads), each a different agent on a different workspace, all working at the same time. One person, many agents, one cockpit. Steer any of them at any moment.
- **Self-hosted dev loop** — pikiclaw was built using pikiclaw. The dev workflow *is* the product: drive the orchestrator from your phone, write code, ship a release, iterate.
- **Walk-away coding** — kick off a long refactor, close the laptop, drive it from your phone over Telegram. The agent keeps running locally; results stream back to chat.
- **Multi-agent on one workspace** — let Claude Code draft an implementation, switch to Codex to review, then Gemini for a different perspective. Same files, same session history.
- **Domestic-model routing** — run Claude Code over DeepSeek or 豆包 via a wrapper driver when latency, cost, or compliance demands a non-frontier model.
- **Group-chat agent** — drop pikiclaw into a Feishu / Slack / Discord / WeCom work group; the team shares one orchestrator, one workspace, one set of skills.
- **Computer-use, controlled by you** — toggle on the managed Chrome (Playwright) and macOS desktop (Peekaboo, via Accessibility + ScreenCaptureKit). The agent can `see` the screen, click, type, manage windows / menus / Dock — and you steer it from any phone. Book a meeting, scrape a dashboard, run an end-to-end test, or drive any native macOS app.
- **Skill-driven workflows** — install community skills (`promote`, `snipe`, `review`, `security-review`, …) once and trigger them from any terminal with `/sk_<name>`.

---

## Features

### Terminal layer

- **Seven IM channels** — Telegram, Feishu, WeChat (personal), Slack, Discord, DingTalk, WeCom. Run one, several, or all simultaneously. Each channel is physically isolated; adding a new one (WhatsApp, mobile app, …) doesn't touch the others.
- **Web Dashboard** — drive sessions directly from the browser with the same conversation, tool-use, and streaming surfaces as IM. Multi-pane workspace (1 / 2 / 3 / 6 panes), light / dark theme, EN / 中文 i18n.
- **Live streaming preview** — message updates in place as the agent thinks; long text auto-splits; images and files stream back in real time.

### Agent layer

- **Official CLIs as drivers** — Claude Code, Codex CLI, Gemini CLI, and Hermes (via ACP). No home-grown agent rewrite — you get upstream behavior on day-zero updates.
- **ACP-native** — Hermes integrates through the [Agent Client Protocol](https://agentclientprotocol.com), spawning `hermes acp` over JSON-RPC stdio. Any future ACP-compatible agent plugs in the same way.
- **Pluggable registry** — `src/agent/driver.ts` is the only contract. New CLI- or ACP-based agents drop in alongside the four built-ins.
- **Per-session agent switching** — same workspace, swap the brain.
- **Steer** — interrupt a running task and let a queued message jump ahead in the queue.
- **Codex human-in-the-loop** — when Codex pauses to ask, the question becomes an interactive IM prompt. Reply there; the task continues.
- **Persistent goals** — `/goal` sets a long-running objective per session with token budget and pause/resume; the agent self-terminates when it audits the goal complete.

### Model layer

- **Frontier + domestic + proxies** — Claude (4 family), GPT-5 / Codex, Gemini, DeepSeek, 豆包 (Doubao), MiMo, MiniMax, OpenRouter, and any OpenAI-compatible model proxy.
- **Providers + Profiles vault** — first-class data model with its own credential store under `~/.pikiclaw/setting.json`. Browse a read-only models.dev catalog, validate keys with a real provider probe, then bind a profile to an agent so spawn-time env injection is automatic.
- **Per-session model + reasoning effort** — picked from the dashboard, `/models`, or `/mode`.
- **Per-agent injection** — `resolveAgentInjection(agentId)` applies the active profile's env vars at spawn time, so Claude Code can run on top of DeepSeek or Doubao without touching the upstream client config.

### Tool layer

- **Skills** — project skills in `.pikiclaw/skills/*/SKILL.md`, compatible with `.claude/commands/*.md`. One-click install from GitHub repos (`owner/repo`) or browse recommended packs (Anthropic Official, Vercel Agent Skills, …). Trigger with `/skills` and `/sk_<name>`.
- **MCP servers** — browse the [MCP Registry](https://registry.modelcontextprotocol.io), add custom stdio / HTTP servers, health-check with a real handshake, OAuth 2.1 with Dynamic Client Registration, enable per scope. Recommended catalog includes GitHub, Atlassian, Notion, Linear, Sentry, Cloudflare, Slack, Feishu/Lark, Stripe, Hugging Face, Gamma, Brave Search, Perplexity, Filesystem, SQLite, PostgreSQL — plus two built-in computer-use servers (`pikiclaw-browser` for Chrome via Playwright, `peekaboo` for macOS GUI via Peekaboo).
- **CLI tools** — auto-detected with live version + auth state, OAuth-web login sessions for browser-based CLIs, all invoked through the agent's normal tool surface.
- **Session-scoped MCP bridge** — `im_list_files`, `im_send_file`, `im_ask_user`, the managed-browser tools, and the macOS desktop tools (when enabled) are injected into every session automatically.
- **Two-scope merge** — `global < workspace < built-in`, applied automatically to every session.

<p align="center"><img src="docs/promo-dashboard-extensions-add.png" alt="Add MCP server" width="780"></p>

### Runtime & DX

- **Session workspace** — every session owns a directory; file attachments land there automatically.
- **Resume, switch, classify** — multi-turn conversations, session classification (answer / proposal / implementation / blocked / …).
- **Session-scoped MCP tools** — `im_list_files`, `im_send_file`, `im_ask_user`, and goal-management tools auto-injected into every stream.
- **Computer-use (browser)** — built-in `pikiclaw-browser` MCP wraps `@playwright/mcp` with a shared Chrome profile and a process-level supervisor; log in once, reuse credentials across tasks.
- **Computer-use (macOS desktop)** — built-in `peekaboo` MCP runs [Peekaboo](https://peekaboo.sh/) over Accessibility + ScreenCaptureKit; exposes `see`, `click`, `type`, `scroll`, `window`, `menu`, `app`, `dock`. Opt-in from Extensions; needs Accessibility + Screen Recording permissions. macOS only.
- **Long-task hardening** — sleep prevention, watchdog, auto-restart, daemon mode, channel supervisor.

---

## How is this different?

| | pikiclaw | IDE assistants<br>(Cursor / Windsurf / Aider) | Cloud agents<br>(Devin / web Claude) | Single-agent IM bots |
|---|---|---|---|---|
| **Terminal** | 7 IM channels + Web + future plug-ins | IDE only | Web app | One IM, one bot |
| **Where the agent runs** | Your machine | Your machine | Vendor sandbox | Often vendor |
| **Agent choice** | Claude Code · Codex · Gemini · Hermes (ACP) · … | Bundled | Single | Single |
| **Model choice** | Frontier + domestic Chinese + any OpenAI-compatible | Vendor-controlled | Vendor-controlled | Single |
| **Parallel agents** | **N agents × N windows × N workspaces** | One per IDE | Sequential | One |
| **Files / tools** | Your files, your MCP, your CLIs | Your files | Sandbox | None / limited |
| **Plug new terminal** | Add a `Channel` class | n/a | n/a | Fork |
| **Plug new agent** | Add an `AgentDriver` (CLI or ACP) | n/a | n/a | Fork |
| **Self-bootstrapping** | **Yes — built with itself** | No | No | No |

The shape that matters: **you stay in your environment, you keep your choice of brain, you run a swarm in parallel, and the orchestrator is the same one we use to build the orchestrator.**

---

## Commands

| Command | Description |
|---|---|
| `/start` | Entry info, current agent, working directory |
| `/sessions` | View, switch, or create sessions |
| `/agents` | Switch agent (Claude · Codex · Gemini · Hermes) |
| `/models` | View and switch model / reasoning effort |
| `/mode` | Toggle plan mode (reasoning effort) |
| `/switch` | Browse and switch working directory |
| `/workspaces` | Pick a saved workspace from the Dashboard's quick-pick list |
| `/goal` | Set or inspect a long-running, self-terminating session goal |
| `/stop` | Stop current session |
| `/status` | Runtime status, tokens, usage, session info |
| `/host` | Host CPU / memory / disk / battery |
| `/skills` | Browse project skills |
| `/ext` | Extensions overview |
| `/restart` | Restart and re-launch bot |
| `/sk_<name>` | Run a project skill |

Plain text is forwarded to the current agent.

---

## Configuration

- Persistent config: `~/.pikiclaw/setting.json` — channels, agents, Providers/Profiles, workspaces, MCP extensions
- The Dashboard is the primary configuration surface; the terminal wizard (`--setup`) and `--doctor` exist for headless setups
- Global MCP extensions live under `extensions.mcp` in the setting file
- Workspace MCP extensions: standard `.mcp.json` in the project root
- Project skills: `.pikiclaw/skills/*/SKILL.md` (also picks up `.claude/commands/*.md`)

**Computer-use** is gated by two toggles under Extensions:

- `browserEnabled` — managed Chrome (Playwright). The first time an agent needs Chrome, pikiclaw creates a dedicated profile under `~/.pikiclaw` and reuses it across sessions. Log in to the sites you need once; every future session reuses those credentials.
- `peekabooEnabled` — macOS desktop (Peekaboo). When on (macOS only), pikiclaw spawns `@steipete/peekaboo`'s `peekaboo-mcp` binary and injects its tools. Grant the parent terminal **Accessibility** and **Screen Recording** in System Settings → Privacy & Security before flipping the toggle.

---

## Roadmap

Already shipped: Hermes driver · ACP (Agent Client Protocol) · Provider/Profile model vault · seven IM channels · computer-use (Playwright browser + Peekaboo macOS desktop).

- **More ACP agents** — every new ACP-compatible agent should drop in without a hand-written driver
- **More terminals** — WhatsApp, dedicated mobile app, voice
- **Deeper model layer** — agent-on-arbitrary-model wrappers for more domestic series
- **Better tool ecosystem** — recommended MCP packs, skill templates, marketplace
- **Cross-platform computer-use** — Windows / Linux desktop drivers alongside the macOS Peekaboo bridge

See [ACP Migration Plan](docs/acp-migration.md) for the protocol-side details.

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
npm run dev                       # local dev (--no-daemon, logs to ~/.pikiclaw/dev/dev.log)
npm run build                     # production build (dashboard + tsc)
npm test                          # vitest run
npx pikiclaw@latest --doctor      # environment check
```

Architecture and integration deep dives: [ARCHITECTURE.md](ARCHITECTURE.md) · [INTEGRATION.md](INTEGRATION.md) · [TESTING.md](TESTING.md)

---

## Contributing

The project is built around layers that are *meant* to be extended. New terminals, new agents, new model wrappers, new MCP tools — all are first-class contributions.

- Read the **[Contributing Guide](CONTRIBUTING.md)** to get started
- Browse [`good first issue`](https://github.com/xiaotonng/pikiclaw/labels/good%20first%20issue) and [`help wanted`](https://github.com/xiaotonng/pikiclaw/labels/help%20wanted)
- Open an issue first for larger changes so we can align on approach

| Where | What you'd add |
|---|---|
| `src/agent/driver.ts`, `src/agent/drivers/*.ts`, `src/agent/acp-client.ts` | A new agent driver (CLI- or ACP-based) |
| `src/channels/base.ts`, `src/channels/*/` | A new terminal / IM channel |
| `src/model/`, `src/model/injector.ts` | A new model provider or per-agent injection rule |
| `src/dashboard/routes/*.ts` | A new dashboard API surface |
| `src/agent/mcp/tools/*.ts`, `src/agent/mcp/bridge.ts` | New session-scoped MCP tools |
| `src/catalog/*.ts` | A recommended MCP server / CLI tool / skill repo |

---

## Star history

<a href="https://www.star-history.com/#xiaotonng/pikiclaw&Date">
  <img src="https://api.star-history.com/svg?repos=xiaotonng/pikiclaw&type=Date" alt="Star history" width="640">
</a>

---

## License

[MIT](LICENSE) — built in the open. Use it, fork it, plug your own layer in.
