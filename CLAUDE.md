# Pikiclaw

A layered, open Agent orchestrator built for the era when creators no longer need to read code. Pikiclaw is **not** "an IM bridge for coding agents" — IM is one of several pluggable terminals.

**Four layers (top → bottom):**

1. **Terminal / frontend** — IM channels (Telegram / Feishu / WeChat) and the Web Dashboard are equal, pluggable entry points. IM is *one* terminal, not the core.
2. **Agent / scheduling** — wraps and dispatches across best-in-class agent systems: Claude Code, Codex, Gemini CLI today; Hermes and future agents plug in via the driver registry.
3. **Model** — routes across model series (Claude, GPT/Codex, Gemini), domestic Chinese series (DeepSeek, 豆包, MiMo, MiniMax), and OpenRouter / any third-party model proxy. Provides agent-on-arbitrary-model wrappers.
4. **Tool** — mainstream ecosystems: Skills, MCP servers, CLI tools, merged across global / workspace scopes.

The orchestrator — not any single channel or agent — is the product. When describing or extending pikiclaw, lead with the layered framing.

## Project Structure

```text
src/
  core/                              # Zero-business-logic infrastructure
    constants.ts                     Centralized timeouts, retries, numeric constants
    logging.ts                       Structured logging with scoped writers
    platform.ts                      Cross-platform OS primitives (IS_WIN, path, which)
    version.ts                       Package version from package.json
    process-control.ts               Restart coordination, watchdog, process tree kill
    utils.ts                         Pure utilities: env parsing, formatting, shell helpers
    config/
      user-config.ts                 ~/.pikiclaw/setting.json load/save/sync
      runtime-config.ts              Runtime agent model and effort resolution
      validation.ts                  Channel credential validation

  catalog/                           # Data-only manifests for the Extensions page
    index.ts                         Barrel for all manifests
    mcp-servers.ts                   Recommended MCP servers (Extensions → MCP)
    cli-tools.ts                     Recommended CLIs (Extensions → CLI)
    skill-repos.ts                   Recommended skill repos (Extensions → Skills)

  agent/                             # Agent abstraction layer
    index.ts                         Barrel re-export (loads drivers, exposes public API)
    types.ts                         All shared type definitions (StreamOpts, SessionInfo, …)
    utils.ts                         Agent utilities: logging, error normalization, tool summaries
    session.ts                       Session workspace CRUD, classification, export/import
    stream.ts                        CLI spawn framework, stream orchestration, detection
    driver.ts                        AgentDriver interface + pluggable registry
    skills.ts                        Project skill discovery (.pikiclaw/skills)
    skill-installer.ts               Wrapper around `npx skills add` for global / workspace install
    auto-update.ts                   Background agent CLI version checking
    npm.ts                           NPM helpers for agent package management
    drivers/
      claude.ts                      Claude Code CLI driver
      codex.ts                       Codex CLI driver
      gemini.ts                      Gemini CLI driver
    cli/                             External CLI tool management (binaries users install)
      index.ts                       Barrel
      registry.ts                    Recommended CLI types and reference data
      detector.ts                    Live detection of installed CLI version + auth state
      catalog.ts                     Merge recommended registry with detected status
      auth.ts                        OAuth-web auth sessions for browser-based CLI login
    mcp/
      bridge.ts                      Per-stream MCP bridge orchestration
      session-server.ts              Stdio MCP server for agent CLIs
      registry.ts                    Recommended MCP server registry — types, transport / auth specs
      extensions.ts                  MCP extension CRUD, catalog merge, session merge
      oauth.ts                       MCP OAuth 2.1 + Dynamic Client Registration flow
      playwright-proxy.ts            Playwright MCP proxy for browser automation
      tools/
        workspace.ts                 im_list_files / im_send_file
        desktop.ts                   Desktop GUI automation via Appium
        ask-user.ts                  im_ask_user — block until user replies in IM / dashboard
        types.ts                     MCP tool type definitions

  bot/                               # Channel-agnostic bot orchestration
    bot.ts                           Bot base class: chat state, task queue, streaming
    host.ts                          Host system data: battery, CPU, memory
    commands.ts                      Channel-agnostic command data layer
    command-ui.ts                    Interactive selection UI and action executor
    orchestration.ts                 Session/message orchestration helpers
    menu.ts                          Menu command definitions, skill mapping
    streaming.ts                     Stream preview parsing
    render-shared.ts                 Shared rendering utilities
    human-loop.ts                    Human-in-the-loop state machine (Codex + im_ask_user)
    session-hub.ts                   Cross-agent session querying
    session-status.ts                Runtime session status for dashboard

  channels/                          # IM channel implementations (physically isolated)
    base.ts                          Abstract Channel transport + capability flags
    states.ts                        Channel validation caching
    telegram/
      channel.ts                     Telegram transport layer
      bot.ts                         Telegram bot orchestration
      render.ts                      Telegram message rendering
      live-preview.ts                Live preview controller
      directory.ts                   Workdir browser
    feishu/
      channel.ts                     Feishu transport layer
      bot.ts                         Feishu bot orchestration
      render.ts                      Feishu card rendering
      markdown.ts                    Feishu markdown helpers
    weixin/
      channel.ts                     WeChat transport layer
      api.ts                         WeChat API integration
      bot.ts                         WeChat bot orchestration

  dashboard/                         # Dashboard server + API
    server.ts                        Hono HTTP server
    runtime.ts                       Runtime singleton (bot ref, prefs, cache)
    platform.ts                      macOS permission checks, Appium management, desktop helpers
    session-control.ts               Public session task control surface
    routes/
      config.ts                      Config / channel / permission / browser API routes
      agents.ts                      Agent / model API routes
      sessions.ts                    Session / workspace API routes
      extensions.ts                  MCP servers + skills: catalog, install, OAuth, enable/disable
      cli.ts                         CLI tools: catalog, refresh, auth sessions, token entry, logout

  cli/                               # CLI entry points
    main.ts                          Entry point: daemon, args, setup, channel launch
    channels.ts                      Channel resolution helpers
    setup-wizard.ts                  Interactive terminal setup
    onboarding.ts                    Setup/doctor state assessment
    run.ts                           Standalone local commands

  browser-profile.ts                 Managed Chromium profile directory for Playwright
  browser-supervisor.ts              Process-singleton: probe / ensure / invalidate the managed Chrome
```

## Layered Architecture

Dependencies flow strictly downward:

```
cli/  →  dashboard/  →  channels/*  →  bot/  →  agent/  →  catalog/, core/
```

- **core/** and **catalog/** have zero business-logic dependencies
- **agent/** depends only on core/ and catalog/
- **bot/** depends on agent/ and core/
- **channels/** depend on bot/, agent/, and core/
- **dashboard/** and **cli/** sit at the top

## Key Concepts

- `bot/bot.ts` owns shared runtime state and `runStream()`
- `agent/index.ts` is the barrel entry point for all agent functionality
- `agent/session.ts` handles all session workspace CRUD and classification
- `agent/stream.ts` contains the CLI spawn framework and `doStream()` orchestration
- `agent/mcp/bridge.ts` injects session-scoped MCP tools into each stream; `agent/mcp/extensions.ts` merges global + workspace MCP config and resolves OAuth bearers
- `bot/human-loop.ts` is the single state machine for both Codex user-input requests and the `im_ask_user` MCP tool
- `browser-supervisor.ts` is the process-level singleton for the managed Chrome — streams call `ensure()`, never relaunch directly
- Each channel in `channels/*/` is physically isolated — modifying Telegram never requires touching Feishu code
- Dashboard frontend uses react-router-dom (Vite + React SPA served as static files)

## Quick Reference: Where to Look

| Task | Files to read |
|------|---------------|
| Add a new agent driver | `agent/driver.ts`, any `agent/drivers/*.ts` as example |
| Add a recommended MCP / CLI / skill | `catalog/mcp-servers.ts`, `catalog/cli-tools.ts`, `catalog/skill-repos.ts` |
| Modify session management | `agent/session.ts`, `agent/types.ts` |
| Change streaming behavior | `agent/stream.ts`, `bot/bot.ts` (runStream) |
| Add a Telegram command | `channels/telegram/bot.ts`, `bot/commands.ts` |
| Modify Feishu rendering | `channels/feishu/render.ts`, `bot/render-shared.ts` |
| Add a dashboard API route | `dashboard/routes/*.ts`, `dashboard/runtime.ts` |
| Change MCP tool behavior | `agent/mcp/tools/*.ts`, `agent/mcp/bridge.ts` |
| MCP extension CRUD / OAuth | `agent/mcp/extensions.ts`, `agent/mcp/oauth.ts`, `agent/mcp/registry.ts` |
| External CLI detection / auth | `agent/cli/detector.ts`, `agent/cli/auth.ts` |
| Modify user config schema | `core/config/user-config.ts` |
| Cross-platform OS behavior | `core/platform.ts` |
| Managed browser lifecycle | `browser-supervisor.ts`, `browser-profile.ts` |

## Test Commands

```bash
npm run dev
npm test
npx vitest run test/code-agent.unit.test.ts
```

## Notes

- Persistent config is `~/.pikiclaw/setting.json`
- The dashboard is part of the normal runtime, not just a setup helper
- This machine always has a production/self-bootstrap communication path via `npx pikiclaw@latest`; do not kill, replace, or "clean up" that process when the task only concerns dev mode
- `npm run dev` is the local-only development path: it runs with `--no-daemon`, stays on the checked-out source tree, and rewrites `~/.pikiclaw/dev/dev.log` from scratch on each launch
- If a test or validation step needs a running `pikiclaw` process, use `npm run dev`
