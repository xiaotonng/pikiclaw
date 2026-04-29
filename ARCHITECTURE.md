# Architecture

This document describes the `pikiclaw` source layout and how the layers compose.

`pikiclaw` is a layered, open Agent orchestrator. Four conceptual layers — terminals, agents, models, tools — sit on top of a foundation of cross-cutting infrastructure. The `src/` directory implements that stack with strict downward dependencies.

## Directory Structure

```text
src/
  core/                              Foundation layer — no business logic
    constants.ts                     Centralized timeout, retry, and numeric constants grouped by domain
    logging.ts                       Structured logging with scoped writers and file retention
    platform.ts                      Cross-platform OS primitives (path, which, IS_WIN, …)
    version.ts                       Reads the package version from package.json at startup
    process-control.ts               Process lifecycle: restart coordination, watchdog, process tree termination
    utils.ts                         Pure utility functions shared across all layers (no state dependencies)
    config/
      user-config.ts                 Persistent user configuration (~/.pikiclaw/setting.json) load/save/sync
      runtime-config.ts              Runtime resolution of agent model and effort preferences
      validation.ts                  Channel credential validation for Telegram, Feishu, and WeChat

  catalog/                           Data-only manifests for the Extensions page
    index.ts                         Barrel export of MCP / CLI / skill manifests
    mcp-servers.ts                   Recommended MCP servers (Extensions → MCP)
    cli-tools.ts                     Recommended CLI tools (Extensions → CLI)
    skill-repos.ts                   Recommended skill repositories (Extensions → Skills)

  agent/                             Agent abstraction layer — CLI drivers, sessions, MCP tools
    types.ts                         Shared type definitions for the agent subsystem
    utils.ts                         Pure utility functions for the agent layer
    session.ts                       Session workspace management, metadata, classification, export/import
    stream.ts                        CLI spawn framework, stream orchestration, agent detection, driver delegation
    index.ts                         Barrel export: loads drivers (side-effect) and re-exports public API
    driver.ts                        AgentDriver interface and pluggable driver registry
    skills.ts                        Project skill discovery from .pikiclaw/skills and .claude/commands
    skill-installer.ts               Wrapper around `npx skills` for global / workspace skill installation
    auto-update.ts                   Background agent CLI version checking and update prompts
    npm.ts                           NPM helper for agent package management
    drivers/
      claude.ts                      Claude Code CLI driver: stream parsing, session reads, model listing, usage
      codex.ts                       Codex CLI driver: HTTP server management, streaming, human-in-the-loop
      gemini.ts                      Gemini CLI driver: stream parsing, session reads, model listing
    cli/                             External CLI tools (Claude / Codex / Gemini binaries) management
      index.ts                       Barrel export
      registry.ts                    Recommended CLI registry — type definitions and reference data
      detector.ts                    Live detection of installed CLI versions and auth state
      catalog.ts                     Merge recommended-registry entries with detected status
      auth.ts                        OAuth-web auth sessions for CLIs that need browser-based login
    mcp/
      bridge.ts                      Per-stream MCP bridge: localhost callback server + agent config
      session-server.ts              Stdio MCP server spawned by agent CLIs for tool access
      registry.ts                    Recommended MCP server registry — types, transport / auth specs
      extensions.ts                  MCP extension management: CRUD, catalog merge, session merge
      oauth.ts                       MCP OAuth 2.1 + Dynamic Client Registration flow
      playwright-proxy.ts            Playwright MCP proxy for browser automation integration
      tools/
        types.ts                     MCP tool result types and helper utilities
        workspace.ts                 im_list_files / im_send_file workspace tools
        desktop.ts                   Desktop GUI automation via Appium Mac2
        ask-user.ts                  im_ask_user tool — block agent until user replies via IM / dashboard

  bot/                               Shared bot runtime — channel-agnostic business logic
    bot.ts                           Bot base class: chat state, session lifecycle, task queue, streaming bridge
    host.ts                          Host system data collection: battery, CPU, memory, display name
    commands.ts                      Channel-agnostic command data layer for bot commands
    command-ui.ts                    Shared selection UI models and action executor for interactive commands
    orchestration.ts                 Session and message orchestration helpers shared across channels
    menu.ts                          Menu command definitions and skill-to-command mapping
    streaming.ts                     Stream preview parsing helpers for live message updates
    render-shared.ts                 Shared rendering utilities used by channel-specific renderers
    human-loop.ts                    Human-in-the-loop prompt state machine (covers Codex + im_ask_user)
    session-hub.ts                   Cross-agent session querying and updates
    session-status.ts                Runtime session status helpers for dashboard polling

  channels/                          Channel transports and per-IM bot implementations
    base.ts                          Abstract Channel transport: lifecycle, outgoing primitives, capability flags
    states.ts                        Channel validation state caching
    telegram/
      channel.ts                     Telegram transport: send, edit, delete, callbacks, uploads, downloads
      bot.ts                         Telegram bot orchestration: commands, callbacks, streaming lifecycle
      render.ts                      Telegram-specific message rendering and formatting
      live-preview.ts                Channel-agnostic live preview controller for streaming updates
      directory.ts                   Telegram workdir browser for interactive directory navigation
    feishu/
      channel.ts                     Feishu (Lark) transport: card messages, uploads, event handling
      bot.ts                         Feishu bot orchestration: commands, events, streaming lifecycle
      render.ts                      Feishu-specific message card rendering
      markdown.ts                    Feishu markdown adaptation helpers
    weixin/
      channel.ts                     WeChat channel transport
      api.ts                         WeChat official account API integration
      bot.ts                         WeChat bot orchestration

  dashboard/                         Web dashboard — config UI and runtime monitoring
    server.ts                        Hono-based dashboard HTTP server: static files and API routes
    runtime.ts                       Dashboard runtime singleton: bot ref, preferences, channel state cache
    platform.ts                      macOS permission checks, Appium management, desktop helpers
    session-control.ts               Public session task control surface for dashboard and API routes
    routes/
      config.ts                      Configuration, channels, permissions, browser API endpoints
      agents.ts                      Agent detection, model listing, installation API endpoints
      sessions.ts                    Session CRUD, workspace, streaming state API endpoints
      extensions.ts                  Extensions API: MCP servers + skills, OAuth flow, install/uninstall
      cli.ts                         Extensions API: CLI tool detection, auth sessions, token entry, logout

  cli/                               CLI entry point and terminal flows
    main.ts                          CLI entry point: daemon mode, argument parsing, setup flow, channel launch
    channels.ts                      Channel resolution helpers for CLI startup
    setup-wizard.ts                  Interactive terminal setup wizard
    onboarding.ts                    Setup/doctor state assessment and messaging
    run.ts                           Standalone local inspection commands (run without daemon)

  browser-profile.ts                 Managed browser profile directory for Playwright integration
  browser-supervisor.ts              Process-level managed-browser singleton — singleflight ensure / probe / invalidate
```

## Layered Architecture

The codebase is organized into layers with a strict downward dependency direction:

```text
┌─────────────────────────────────────────────────────────────┐
│  cli/            CLI entry point, terminal setup            │
│  dashboard/      Web server, API routes, runtime singleton  │
├─────────────────────────────────────────────────────────────┤
│  channels/       Per-IM transport + bot orchestration       │
├─────────────────────────────────────────────────────────────┤
│  bot/            Shared bot runtime, commands, streaming    │
├─────────────────────────────────────────────────────────────┤
│  agent/          Agent drivers, sessions, MCP tools, CLI    │
├─────────────────────────────────────────────────────────────┤
│  catalog/        Data-only extension manifests              │
│  core/           Constants, logging, config, utilities      │
└─────────────────────────────────────────────────────────────┘
```

### Dependency direction rule

Each layer may import from any layer below it and from `core/` / `catalog/`. Arrows point downward only:

- `cli/` and `dashboard/` import from `channels/`, `bot/`, `agent/`, `catalog/`, `core/`
- `channels/` imports from `bot/`, `agent/`, `core/`
- `bot/` imports from `agent/`, `core/`
- `agent/` imports from `catalog/`, `core/`
- `catalog/` and `core/` import from nothing inside `src/`

No layer imports from a layer above it. This keeps the lower layers testable in isolation and prevents circular dependencies.

## Layer Details

### core/ — Foundation

Pure infrastructure with zero business logic. Every other layer depends on it.

| Module | Purpose |
|---|---|
| `constants.ts` | All magic numbers organized by domain (timeouts, limits, intervals) |
| `logging.ts` | Scoped log writers, retained log sinks, log levels |
| `platform.ts` | Cross-platform OS primitives — `IS_WIN`, path helpers, binary lookup |
| `version.ts` | Package version string, read once at startup |
| `process-control.ts` | Restart exit codes, watchdog process, `terminateProcessTree()` |
| `utils.ts` | Pure helpers: truncation, escaping, path resolution, ChatId type |
| `config/user-config.ts` | Load/save/watch `~/.pikiclaw/setting.json`, workspace resolution |
| `config/runtime-config.ts` | Resolve effective agent, model, and reasoning effort from config |
| `config/validation.ts` | Validate Telegram tokens, Feishu app credentials, WeChat credentials |

**When to look here:** Changing default timeouts, adding a new config field, fixing a logging format, or adjusting process lifecycle behavior.

### catalog/ — Extension Manifests

Plain TypeScript arrays describing every recommended MCP server, CLI, and skill repo the dashboard offers. Editing one of these files is the only step required to add or remove a recommendation.

| Module | Purpose |
|---|---|
| `index.ts` | Barrel re-exports for all manifests |
| `mcp-servers.ts` | Recommended MCP servers shown under Extensions → MCP |
| `cli-tools.ts` | Recommended CLIs shown under Extensions → CLI |
| `skill-repos.ts` | Recommended skill repositories shown under Extensions → Skills |

**When to look here:** Adding or removing a recommended server / CLI / skill.

### agent/ — Agent Abstraction

Everything related to agent CLI interaction: spawning, streaming, session management, the MCP tool bridge, and the management surface for external CLI binaries.

| Module | Purpose |
|---|---|
| `types.ts` | `StreamOpts`, `StreamResult`, `SessionInfo`, `Agent` union, etc. |
| `utils.ts` | Agent-specific pure helpers (log formatting, error normalization) |
| `session.ts` | Session workspace creation, metadata persistence, classification |
| `stream.ts` | CLI spawn, readline streaming, agent binary detection |
| `index.ts` | Barrel: imports drivers for side effects, re-exports public API |
| `driver.ts` | `AgentDriver` interface + `registerDriver()` / `getDriver()` registry |
| `skills.ts` | Discover `.pikiclaw/skills` and `.claude/commands` project skills |
| `skill-installer.ts` | Wrapper around `npx skills add` for global / workspace install |
| `auto-update.ts` | Background version check and npm update prompts per agent |
| `npm.ts` | Agent package names, labels, install commands |
| `drivers/claude.ts` | Claude Code CLI driver |
| `drivers/codex.ts` | Codex CLI driver (HTTP server mode + human-in-the-loop) |
| `drivers/gemini.ts` | Gemini CLI driver |
| `cli/registry.ts` | Recommended CLI definitions, install / auth specs |
| `cli/detector.ts` | Detect installed CLI version and auth state |
| `cli/catalog.ts` | Merge recommended registry with detected status |
| `cli/auth.ts` | OAuth-web auth sessions (interactive login flows for CLIs) |
| `mcp/bridge.ts` | Per-stream MCP orchestrator: localhost callback server + agent config |
| `mcp/session-server.ts` | Stdio MCP server spawned by agent CLIs |
| `mcp/registry.ts` | Recommended MCP server registry — types, transport specs, auth specs |
| `mcp/extensions.ts` | MCP extension CRUD, catalog merge, session merge |
| `mcp/oauth.ts` | MCP OAuth 2.1 + Dynamic Client Registration |
| `mcp/playwright-proxy.ts` | Playwright MCP proxy with managed browser profile |
| `mcp/tools/types.ts` | MCP tool result types and logging helpers |
| `mcp/tools/workspace.ts` | `im_list_files` and `im_send_file` |
| `mcp/tools/desktop.ts` | Desktop GUI automation tools via Appium Mac2 |
| `mcp/tools/ask-user.ts` | `im_ask_user` — block until user replies in IM / dashboard |

**When to look here:** Adding a new agent driver, changing how sessions are stored, modifying MCP tool behavior, adjusting stream parsing, or working on CLI / MCP extension management.

### bot/ — Shared Bot Runtime

Channel-agnostic business logic. The `Bot` base class owns chat state, session routing, and the streaming bridge. Everything here is consumed by channel-specific bot implementations in `channels/`.

| Module | Purpose |
|---|---|
| `bot.ts` | `Bot` base class: chat map, session states, `runStream()`, workdir |
| `host.ts` | System info collection (battery, CPU, memory, display name) |
| `commands.ts` | Structured command data (sessions list, agents list, etc.) |
| `command-ui.ts` | Selection UI models, action dispatch for interactive commands |
| `orchestration.ts` | Message pipeline helpers, shutdown coordination |
| `menu.ts` | Menu command definitions, skill-to-command mapping |
| `streaming.ts` | Stream preview parsing, activity summary extraction |
| `render-shared.ts` | Rendering types and helpers shared across all renderers |
| `human-loop.ts` | Human-in-the-loop prompt state machine (Codex user-input + `im_ask_user`) |
| `session-hub.ts` | Cross-agent session queries, metadata updates, session operations |
| `session-status.ts` | Runtime session status lookups for dashboard polling |

**When to look here:** Changing command behavior, modifying the streaming pipeline, adjusting session lifecycle logic, or adding a new command that works the same across all channels.

### channels/ — Channel Transports and Bot Implementations

Each IM channel has a transport layer (`channel.ts`) and a bot orchestration layer (`bot.ts`). The transport handles raw API calls; the bot wires up commands, callbacks, and streaming using shared `bot/` modules.

| Module | Purpose |
|---|---|
| `base.ts` | Abstract `Channel` class, capability flags, `SendOpts` |
| `states.ts` | Channel validation state caching |
| `telegram/channel.ts` | Telegram Bot API: send, edit, delete, upload, download, polling |
| `telegram/bot.ts` | Telegram command routing, callback handling, streaming lifecycle |
| `telegram/render.ts` | Telegram HTML rendering for all command responses |
| `telegram/live-preview.ts` | Live preview controller (heartbeat, stall detection, edits) |
| `telegram/directory.ts` | Workdir browser with inline keyboard navigation |
| `feishu/channel.ts` | Feishu SDK transport: WebSocket events, card messages, uploads |
| `feishu/bot.ts` | Feishu command routing, event handling, streaming lifecycle |
| `feishu/render.ts` | Feishu interactive card rendering |
| `feishu/markdown.ts` | GFM-to-Feishu markdown adaptation |
| `weixin/channel.ts` | WeChat transport |
| `weixin/api.ts` | WeChat official account API |
| `weixin/bot.ts` | WeChat bot orchestration |

**When to look here:** Adding a new IM channel, fixing channel-specific rendering, changing how a specific channel handles callbacks, or debugging transport-level issues.

### dashboard/ — Web Dashboard

The Hono-based HTTP server that serves the React SPA and API routes. It is the primary local control plane for configuration, monitoring, session browsing, and extension management.

| Module | Purpose |
|---|---|
| `server.ts` | Hono app setup, static file serving, route mounting |
| `runtime.ts` | Singleton: bot ref, runtime prefs, channel state cache |
| `platform.ts` | macOS permission checks, Appium management, desktop helpers |
| `session-control.ts` | Task queuing and session control for dashboard-initiated runs |
| `routes/config.ts` | Config, channels, permissions, browser API endpoints |
| `routes/agents.ts` | Agent detection, model listing, installation API endpoints |
| `routes/sessions.ts` | Session CRUD, workspace, streaming state API endpoints |
| `routes/extensions.ts` | MCP servers + skills: catalog, install, OAuth, enable/disable |
| `routes/cli.ts` | CLI tools: catalog, refresh, auth sessions, token entry, logout |

**When to look here:** Adding a new dashboard API endpoint, changing how the dashboard discovers agents / extensions, or modifying session control behavior.

### cli/ — CLI Entry Point

The command-line interface: argument parsing, daemon/watchdog mode, setup wizard, and channel launch orchestration.

| Module | Purpose |
|---|---|
| `main.ts` | Entry point: `--daemon`, `--no-daemon`, `--setup`, MCP serve |
| `channels.ts` | Resolve which channels to launch from config and CLI flags |
| `setup-wizard.ts` | Interactive terminal wizard for first-time configuration |
| `onboarding.ts` | Doctor/setup state assessment and user-facing messaging |
| `run.ts` | Standalone inspection commands (`status`, `claude-models`, etc.) |

**When to look here:** Changing CLI flags, adding a new standalone command, or modifying the startup sequence.

### Top-level src/ files

| Module | Purpose |
|---|---|
| `browser-profile.ts` | Managed Chromium profile directory for Playwright MCP integration |
| `browser-supervisor.ts` | Process-level singleton: `probe()` / `ensure()` / `invalidate()` for the managed browser, replacing per-stream relaunches |

## Core Design Principles

### 1. Shared logic first, channel rendering second

Business logic lives in shared `bot/` modules:

- `bot.ts` owns runtime state
- `commands.ts` returns structured command data
- `command-ui.ts` builds shared selection UIs
- `orchestration.ts` owns session/message orchestration primitives
- `runtime-config.ts` (in `core/config/`) centralizes model and effort resolution

Telegram, Feishu, and WeChat differ only in transport details, rendering format, callback payload format, and channel capabilities. This keeps new IM integrations thin.

### 2. Agent support is registry-based

`agent/driver.ts` exposes a small `AgentDriver` interface:

- `doStream()`
- `getSessions()`
- `getSessionTail()`
- `listModels()`
- `getUsage()`
- `shutdown()`

`agent/index.ts` imports all drivers for side effects. All higher-level code talks to the registry, never to a specific driver directly. Binary detection stays in the shared agent layer; drivers focus on stream/session behavior.

### 3. Session workspaces are first-class

Each conversation runs against a pikiclaw-managed session workspace used for:

- Staged attachments
- Session metadata and indexes
- Project skill discovery via `agent/skills.ts`
- MCP tool visibility

This is why file return, project skills, and per-session tool visibility work consistently across agents.

### 4. MCP is injected per stream

When a stream starts and an IM callback is available:

1. `agent/stream.ts` starts `agent/mcp/bridge.ts`
2. The bridge launches a localhost callback server
3. `agent/mcp/extensions.ts` merges global + workspace MCP config (resolving disabled flags and OAuth bearer headers from the token store)
4. The agent CLI launches `agent/mcp/session-server.ts`
5. MCP tools call back into the parent process
6. Pikiclaw sends files, asks the user, or logs activity back to the IM chat in real time

### 5. Human-in-the-loop is a first-class flow

`bot/human-loop.ts` is a single state machine that handles two sources of user prompts:

- Codex's structured `user-input` requests mid-run
- The `im_ask_user` MCP tool (callable from any agent)

The machine renders an IM card or dashboard prompt, waits for the answer, and resumes the same task.

### 6. Catalog data is plain manifests

`catalog/*.ts` files are arrays of TypeScript objects. The dashboard, registries, and extension managers all consume those arrays. Adding a recommended server or CLI is a one-file PR.

### 7. Managed browser is a process singleton

`browser-supervisor.ts` owns the managed Chrome profile across all streams in this pikiclaw process. Streams `ensure()` it (singleflight-ed); `invalidate()` is called only on confirmed failure. This replaces the old per-stream relaunch.

### 8. Dashboard is config + runtime surface

The dashboard is not just a setup page. It is the main local control plane for channel validation, agent detection, model discovery, session browsing, workdir switching, runtime bot status, extension management, and macOS permission checks.

All persistent config lives in `~/.pikiclaw/setting.json`.

## Main Message Flow

```text
Incoming IM message
  -> channels/*/channel.ts normalizes text/files/context
  -> channels/*/bot.ts resolves command vs free text
  -> free text goes to bot/orchestration.ts handleIncomingMessage()
  -> placeholder message is created
  -> channels/telegram/live-preview.ts (or Feishu equivalent) updates the placeholder while streaming
  -> bot/bot.ts runStream() prepares agent options + MCP bridge
  -> agent/stream.ts dispatches to AgentDriver
  -> if Codex requests user input, or im_ask_user is invoked, bot/human-loop.ts renders the prompt in-channel
  -> final reply is rendered via channels/*/render.ts
  -> artifacts / im_send_file callbacks are delivered back to IM
```

## Current MCP Tool Surface

Registered by `agent/mcp/session-server.ts`:

- `im_list_files`
- `im_send_file`
- `im_ask_user`
- Optional macOS desktop tools from `agent/mcp/tools/desktop.ts`:
  - `desktop_status`
  - `desktop_open_app`
  - `desktop_snapshot`
  - `desktop_click`
  - `desktop_type`
  - `desktop_screenshot`
  - `desktop_close_session`

Browser automation can also be registered from `agent/mcp/bridge.ts` via `@playwright/mcp`, using a pikiclaw-managed persistent Chrome profile (`browser-profile.ts` + `browser-supervisor.ts`).

## Quick Reference

| To modify... | Look at... |
|---|---|
| Default timeouts or limits | `core/constants.ts` |
| Cross-platform OS behavior | `core/platform.ts` |
| How config is loaded/saved | `core/config/user-config.ts` |
| Agent model defaults | `core/config/runtime-config.ts` |
| Recommended MCP / CLI / skill list | `catalog/mcp-servers.ts`, `catalog/cli-tools.ts`, `catalog/skill-repos.ts` |
| How a specific agent CLI is spawned | `agent/drivers/claude.ts`, `codex.ts`, or `gemini.ts` |
| Session workspace structure | `agent/session.ts` |
| Stream output parsing | `agent/stream.ts` + `agent/utils.ts` |
| MCP tool behavior | `agent/mcp/tools/workspace.ts`, `desktop.ts`, `ask-user.ts` |
| MCP bridge lifecycle | `agent/mcp/bridge.ts` |
| MCP extension CRUD | `agent/mcp/extensions.ts`, `agent/mcp/registry.ts` |
| MCP OAuth | `agent/mcp/oauth.ts` |
| External CLI detection / auth | `agent/cli/detector.ts`, `agent/cli/auth.ts` |
| Bot command data | `bot/commands.ts` |
| Interactive selection UIs | `bot/command-ui.ts` |
| Streaming preview logic | `bot/streaming.ts` + `bot/render-shared.ts` |
| Human-in-the-loop | `bot/human-loop.ts` |
| Session queries across agents | `bot/session-hub.ts` |
| Telegram rendering | `channels/telegram/render.ts` |
| Feishu rendering | `channels/feishu/render.ts` |
| Adding a new IM channel | `channels/base.ts` (transport), `bot/bot.ts` (subclass) |
| Dashboard API endpoints | `dashboard/routes/{config,agents,sessions,extensions,cli}.ts` |
| CLI startup sequence | `cli/main.ts` |
| CLI channel resolution | `cli/channels.ts` |
| Browser automation profile | `browser-profile.ts` + `browser-supervisor.ts` |

## Adding a New Agent

1. Create `src/agent/drivers/xxx.ts` implementing `AgentDriver`
2. Import it from `src/agent/index.ts` (side-effect import triggers registration)
3. Add model / extra-args config handling in `core/config/runtime-config.ts` if needed
4. If the agent ships an external CLI users need to install, add an entry to `catalog/cli-tools.ts` and any auth flow under `agent/cli/`
5. Add unit tests and, if possible, live E2E coverage

What you usually do not need to touch: `channels/*/bot.ts`, `bot/commands.ts`, `bot/command-ui.ts`. Those layers already consume the driver registry generically.

## Adding a New IM Channel

1. Implement `channels/xxx/channel.ts` extending `Channel`
2. Implement `channels/xxx/render.ts` for platform-specific rendering
3. Implement `channels/xxx/bot.ts` for command routing and streaming lifecycle
4. Register it from `cli/main.ts`
5. Extend `core/config/validation.ts` and `cli/setup-wizard.ts` if the channel has its own credentials

See [INTEGRATION.md](INTEGRATION.md) for the channel integration guide.

## Adding a New MCP Tool

1. Create or extend a module in `src/agent/mcp/tools/`
2. Export `tools` definitions and a `handle()` implementation
3. Register the module in `agent/mcp/session-server.ts`
4. Keep tool results text-based and JSON-serializable
5. If the tool needs IM side effects, use the callback URL path exposed by the bridge

## Adding a Recommended MCP Server / CLI / Skill

1. Append a new entry to the appropriate `catalog/*.ts` file
2. For MCP servers needing OAuth, declare an `auth` spec in the entry and let `agent/mcp/oauth.ts` handle the flow
3. For CLIs needing browser-based auth, declare an `auth` spec and let `agent/cli/auth.ts` drive the session
4. No other code changes are required — the dashboard picks it up from the catalog

## Related Docs

- [README.md](README.md)
- [CLAUDE.md](CLAUDE.md)
- [AGENTS.md](AGENTS.md)
- [INTEGRATION.md](INTEGRATION.md)
- [TESTING.md](TESTING.md)
