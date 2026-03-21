# Architecture

This document describes the current `pikiclaw` architecture as of the multi-channel, multi-agent, MCP-enabled implementation.

## File Structure

```text
src/
  cli.ts                        Main entry: daemon mode, dashboard bootstrap, channel launch
  cli-channels.ts               Resolve configured channels from setting.json / env

  bot.ts                        Shared bot base: config, sessions, runStream(), keep-alive
  bot-commands.ts               Channel-agnostic command data
  bot-command-ui.ts             Shared command selection model + action executor
  bot-handler.ts                Generic message pipeline with live preview + MCP hook
  bot-menu.ts                   Menu command definitions and skill command mapping
  bot-streaming.ts              Stream preview parsing helpers
  human-loop.ts                 Shared human-loop prompt state and answer helpers
  human-loop-codex.ts           Map Codex user-input requests into IM prompts

  bot-telegram.ts               Telegram orchestration
  bot-telegram-render.ts        Telegram rendering helpers
  bot-telegram-live-preview.ts  Channel-agnostic live preview controller
  bot-telegram-directory.ts     Telegram workdir browser state

  bot-feishu.ts                 Feishu orchestration
  bot-feishu-render.ts          Feishu rendering helpers

  channel-base.ts               Transport abstraction and capability flags
  channel-telegram.ts           Telegram transport
  channel-feishu.ts             Feishu transport

  agent-driver.ts               AgentDriver interface + registry
  code-agent.ts                 Shared agent layer and session workspace management
  driver-claude.ts              Claude Code driver
  driver-codex.ts               Codex CLI driver
  driver-gemini.ts              Gemini CLI driver

  mcp-bridge.ts                 Per-stream MCP bridge orchestration
  mcp-session-server.ts         Stdio MCP server launched by agent CLIs
  tools/
    workspace.ts                im_list_files / im_send_file
    desktop.ts                  Optional macOS desktop GUI tools via Appium Mac2
    types.ts                    MCP tool types and helpers

  dashboard.ts                  Web dashboard server and API
  dashboard-ui.ts               Bundled dashboard frontend
  session-status.ts             Runtime session status helpers
  channel-states.ts             Channel validation caching
  config-validation.ts          Telegram / Feishu credential checks

  process-control.ts            Restart, watchdog, process tree termination
  user-config.ts                ~/.pikiclaw/setting.json load/save/sync
  onboarding.ts                 Doctor/setup state and messaging
  setup-wizard.ts               Interactive terminal setup
  run.ts                        Standalone local inspection commands
```

## Runtime Layers

```text
CLI / Dashboard
  cli.ts
    ├ startDashboard()
    ├ loadUserConfig() / applyUserConfig()
    └ launch channel bot(s)

Shared Bot Layer
  bot.ts
    ├ chat/session state
    ├ workdir + model resolution
    ├ runStream()
    └ keep-alive / restart integration

Channel Bot Layer
  bot-telegram.ts / bot-feishu.ts
    ├ commands -> bot-commands.ts + renderer
    ├ callbacks -> bot-command-ui.ts
    └ messages -> bot-handler.ts pipeline

Transport Layer
  channel-telegram.ts / channel-feishu.ts
    └ send, edit, delete, callbacks, uploads, downloads

Agent Layer
  code-agent.ts
    ├ per-session workspace creation
    ├ staged files / skill discovery
    ├ MCP bridge setup
    └ dispatch to AgentDriver

Driver Layer
  driver-claude.ts / driver-codex.ts / driver-gemini.ts
    └ CLI-specific stream/session/model/usage behavior

Tool Layer
  mcp-session-server.ts
    └ src/tools/*
```

## Core Design

### 1. Shared logic first, channel rendering second

Business logic lives in shared modules:

- `bot.ts` owns runtime state
- `bot-commands.ts` returns structured command data
- `bot-command-ui.ts` builds shared selection UIs for sessions, agents, models, and skills
- `bot-handler.ts` runs the generic message lifecycle

Telegram and Feishu mostly differ in:

- transport details
- rendering format
- callback payload format
- channel capabilities

This keeps new IM integrations thin.

### 2. Agent support is registry-based

`agent-driver.ts` exposes a small `AgentDriver` interface:

- `detect()`
- `doStream()`
- `getSessions()`
- `getSessionTail()`
- `listModels()`
- `getUsage()`
- `shutdown()`

`code-agent.ts` imports all drivers for side effects, and all higher-level bot code talks to the registry instead of talking to a specific CLI directly.

### 3. Session workspaces are first-class

Each conversation runs against a pikiclaw-managed session workspace. That workspace is used for:

- staged attachments
- session metadata and indexes
- project skill discovery
- MCP tool visibility

This is why file return, project skills, and per-session tool visibility can work consistently across agents.

### 4. MCP is injected per stream

When a stream starts and an IM callback is available:

1. `code-agent.ts` starts `mcp-bridge.ts`
2. the bridge launches a localhost callback server
3. the bridge prepares agent-specific MCP registration
4. the agent CLI launches `mcp-session-server.ts`
5. MCP tools call back into the parent process
6. pikiclaw sends files or logs activity back to the IM chat in real time

This keeps the tool lifecycle tightly scoped to the active run.

### 5. Codex human loop is handled in-channel

Codex can request structured user input mid-run. pikiclaw translates those requests into Telegram / Feishu prompts, waits for the answer, and resumes the same task instead of forcing the user back to the terminal.

### 6. Dashboard is config + runtime surface

The dashboard is not just a setup page. It is the main local control plane for:

- channel validation
- agent detection and model discovery
- session browsing
- workdir switching
- runtime bot status
- macOS permission checks

All persistent config lives in `~/.pikiclaw/setting.json`.

## Main Message Flow

```text
Incoming IM message
  -> channel transport normalizes text/files/context
  -> bot-xxx.ts resolves command vs free text
  -> free text goes to handleIncomingMessage()
  -> placeholder message is created
  -> LivePreview updates the placeholder while streaming
  -> Bot.runStream() prepares agent options + MCP bridge
  -> AgentDriver streams output
  -> if Codex requests user input, human-loop prompt is rendered in-channel
  -> final reply is rendered
  -> artifacts / send_file callbacks are delivered back to IM
```

## Current MCP Tool Surface

Registered by `mcp-session-server.ts`:

- `im_list_files`
- `im_send_file`
- optional macOS desktop tools from `src/tools/desktop.ts`
  - `desktop_status`
  - `desktop_open_app`
  - `desktop_snapshot`
  - `desktop_click`
  - `desktop_type`
  - `desktop_screenshot`
  - `desktop_close_session`

Supplemental browser automation can also be registered from `mcp-bridge.ts` via `@playwright/mcp`, using a pikiclaw-managed persistent Chrome profile so the same automation browser state can be reused across runs.

## Adding a New Agent

1. Create `src/driver-xxx.ts` implementing `AgentDriver`
2. Import it from `src/code-agent.ts`
3. Add model / extra-args config handling in `bot.ts` if needed
4. Add unit tests and, if possible, live E2E coverage

What you usually do not need to touch:

- `bot-telegram.ts`
- `bot-feishu.ts`
- `bot-commands.ts`
- `bot-command-ui.ts`

Those layers already consume the driver registry generically.

## Adding a New IM Channel

1. Implement `channel-xxx.ts`
2. Implement `bot-xxx-render.ts`
3. Implement `bot-xxx.ts`
4. Register it from `cli.ts`
5. Extend validation / setup surfaces if the channel has its own credentials

See [INTEGRATION.md](INTEGRATION.md) for the channel integration guide.

## Adding a New MCP Tool

1. Create or extend a module in `src/tools/`
2. Export `tools` definitions and a `handle()` implementation
3. Register the module in `mcp-session-server.ts`
4. Keep tool results text-based and JSON-serializable
5. If the tool needs IM side effects, use the callback URL path exposed by the bridge

## Related Docs

- [README.md](README.md)
- [INTEGRATION.md](INTEGRATION.md)
- [TESTING.md](TESTING.md)
