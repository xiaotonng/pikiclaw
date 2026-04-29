# Pikiclaw

A layered, open Agent orchestrator for the era when creators no longer need to read code. Four pluggable layers stacked top → bottom:

- **Terminal layer** — IM channels (Telegram / Feishu / WeChat) and the Web Dashboard are co-equal entry points. IM is one terminal, not the product.
- **Agent layer** — Claude Code, Codex, Gemini CLI today; Hermes and future agents plug in via `agent/driver.ts`.
- **Model layer** — Claude / GPT / Gemini, domestic Chinese series (DeepSeek, 豆包, MiMo, MiniMax), plus OpenRouter and any third-party model proxy; supports running an agent on top of arbitrary models.
- **Tool layer** — Skills, MCP servers, CLI tools, merged across global / workspace scopes.

The orchestrator — not any single channel or agent — is the core. The notes below describe the source layout that implements those layers.

## Project Structure

```text
src/
  core/                       Foundation: constants, logging, config, process, platform
    constants.ts              Centralized timeout / retry / numeric constants
    logging.ts                Scoped log writers and retained sinks
    platform.ts               Cross-platform OS primitives (IS_WIN, path, which)
    process-control.ts        Restart / watchdog / process-tree termination
    utils.ts                  Pure helpers (truncation, escaping, ChatId)
    version.ts                Package version
    config/
      user-config.ts          ~/.pikiclaw/setting.json load/save/sync
      runtime-config.ts       Effective agent / model / effort resolution
      validation.ts           Channel credential validation

  catalog/                    Data-only manifests for the Extensions page
    mcp-servers.ts            Recommended MCP servers
    cli-tools.ts              Recommended CLIs
    skill-repos.ts            Recommended skill repositories

  agent/                      Agent abstraction: drivers, sessions, MCP, CLI mgmt
    driver.ts                 AgentDriver interface + registry
    drivers/{claude,codex,gemini}.ts
    session.ts                Session workspace management
    stream.ts                 CLI spawn / streaming / detection
    skills.ts                 Project skill discovery
    skill-installer.ts        `npx skills add` wrapper
    auto-update.ts            Background CLI version checks
    cli/                      External CLI binary management
      registry.ts             Recommended CLI types and reference data
      detector.ts             Live CLI detection + auth status
      catalog.ts              Merge registry with detection
      auth.ts                 OAuth-web auth sessions
    mcp/
      bridge.ts               Per-stream MCP bridge orchestration
      session-server.ts       Stdio MCP server spawned by agent CLIs
      registry.ts             Recommended MCP server types
      extensions.ts           MCP extension CRUD + session merge
      oauth.ts                MCP OAuth 2.1 + Dynamic Client Registration
      playwright-proxy.ts     Playwright MCP proxy
      tools/{workspace,desktop,ask-user,types}.ts

  bot/                        Channel-agnostic bot runtime
    bot.ts                    Bot base class: chat state, session lifecycle, runStream()
    commands.ts               Structured command data
    command-ui.ts             Selection UI models and action executor
    orchestration.ts          Message pipeline helpers
    streaming.ts              Stream preview parsing
    render-shared.ts          Shared rendering utilities
    human-loop.ts             Human-in-the-loop state machine (Codex + im_ask_user)
    session-hub.ts / session-status.ts
    host.ts / menu.ts

  channels/                   Physically isolated IM implementations
    base.ts                   Abstract Channel transport + capability flags
    states.ts                 Channel validation caching
    telegram/{channel,bot,render,live-preview,directory}.ts
    feishu/{channel,bot,render,markdown}.ts
    weixin/{channel,api,bot}.ts

  dashboard/                  Hono HTTP server + React SPA
    server.ts                 App setup, static files, route mounting
    runtime.ts                Runtime singleton (bot ref, prefs, cache)
    platform.ts               macOS permission / Appium helpers
    session-control.ts        Dashboard-initiated task control
    routes/{config,agents,sessions,extensions,cli}.ts

  cli/                        CLI entry point
    main.ts                   --daemon / --no-daemon / --setup / MCP serve
    channels.ts               Channel resolution from config + flags
    setup-wizard.ts           Interactive terminal wizard
    onboarding.ts             Doctor / setup state assessment
    run.ts                    Standalone inspection commands

  browser-profile.ts          Managed Chromium profile dir for Playwright
  browser-supervisor.ts       Process-level browser singleton (probe / ensure / invalidate)
```

## Architecture Layers

```text
cli/  →  dashboard/  →  channels/*  →  bot/  →  agent/  →  catalog/, core/
```

- `core/` and `catalog/` have zero business-logic dependencies
- `agent/` depends only on `catalog/` and `core/`
- `bot/` depends on `agent/` and `core/`
- `channels/` depend on `bot/`, `agent/`, and `core/`
- `dashboard/` and `cli/` sit at the top

Within a stream:

```
channels/*/bot.ts
  -> bot/orchestration.ts (handleIncomingMessage)
  -> bot/bot.ts runStream()
  -> agent/stream.ts doStream()
  -> agent/drivers/*.ts (chosen via agent/driver.ts registry)
  -> agent/mcp/bridge.ts (injects session-scoped MCP tools)
```

- `bot/bot.ts` is the shared runtime: workdir, agent/model config, sessions, `runStream()`, keep-alive.
- `bot/commands.ts` returns structured command data with no rendering.
- `bot/command-ui.ts` builds shared UI models for sessions, agents, models, and skills.
- `bot/orchestration.ts` runs the generic message pipeline, including MCP-backed file send callbacks.
- `agent/stream.ts` manages session workspaces, staged files, skills, MCP bridge setup, and driver dispatch.
- `agent/driver.ts` keeps agent integration pluggable.

## Current Capabilities

- **Channels:** Telegram, Feishu, WeChat
- **Agents:** Claude Code, Codex CLI, Gemini CLI
- **Project skills:** `.pikiclaw/skills/*/SKILL.md` plus `.claude/commands/*.md` compatibility; install via `agent/skill-installer.ts`
- **Session-scoped MCP tools:** `im_list_files`, `im_send_file`, `im_ask_user`, plus optional macOS desktop tools
- **Browser automation:** managed Chromium profile via `@playwright/mcp`, supervised by `browser-supervisor.ts`
- **Extension management:** dashboard catalog (recommended + installed) for MCP servers, CLIs, and skill repos; OAuth flows for both MCP servers and CLI tools
- **Dashboard:** Hono server + React SPA at `http://localhost:3939` for setup, monitoring, and extension management

## Important Notes

- Persistent config lives in `~/.pikiclaw/setting.json`
- The dashboard is the main config surface; env vars still work, but docs and code assume config-first
- MCP tools are injected per stream; `agent/mcp/extensions.ts` resolves disabled flags and OAuth bearer headers before spawning
- The machine always has a production/self-bootstrap communication path via `npx pikiclaw@latest`; do not kill, replace, or "clean up" that chain when working on dev-only changes
- `npm run dev` is a local-only development path: it runs with `--no-daemon`, stays on the checked-out source tree, and writes a fresh log file to `~/.pikiclaw/dev/dev.log` on each launch

## Testing Rules

- Unit tests: `npm test`
- Live E2E: `npm run test:e2e`
- E2E tests should not mock the external system being tested
- If a test or validation step needs to launch `pikiclaw`, use `npm run dev`; that is the only approved local startup path for dev/test work on this machine
- The one explicit daemon exception is `test/e2e/restart.e2e.test.ts`; it still must stay on the local source chain and never use the production `npx pikiclaw@latest` runtime

## Common Commands

```bash
npm run dev
npm run build
npm test
npm run test:e2e
npx pikiclaw@latest --doctor
npx pikiclaw@latest --setup
```

When validating `npm run dev`, only observe the dev chain. Do not touch the long-lived production `npx pikiclaw@latest` process that keeps IM connectivity alive on this machine.
