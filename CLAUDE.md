# Pikiclaw

IM-driven bridge for local coding agents. Messages arrive from Telegram or Feishu, pikiclaw streams them into a local agent session, and sends output, files, and screenshots back through the chat channel.

## Project Structure

```text
src/
  cli.ts                        Entry point: daemon/watchdog, dashboard, channel launch
  cli-channels.ts               Channel resolution helpers

  bot.ts                        Shared bot runtime and config
  bot-commands.ts               Shared command data layer
  bot-command-ui.ts             Shared selection UI models and action executor
  bot-handler.ts                Generic message pipeline
  bot-menu.ts                   Built-in menu commands and skill command mapping
  bot-streaming.ts              Stream preview parsing helpers

  bot-telegram.ts               Telegram bot orchestration
  bot-telegram-render.ts        Telegram rendering
  bot-telegram-live-preview.ts  Channel-agnostic live preview controller
  bot-telegram-directory.ts     Telegram workdir browser

  bot-feishu.ts                 Feishu bot orchestration
  bot-feishu-render.ts          Feishu rendering

  channel-base.ts               Abstract channel transport
  channel-telegram.ts           Telegram transport
  channel-feishu.ts             Feishu transport

  agent-driver.ts               AgentDriver interface + registry
  code-agent.ts                 Shared agent layer, session workspaces, skills, MCP bridge
  driver-claude.ts              Claude driver
  driver-codex.ts               Codex driver
  driver-gemini.ts              Gemini driver

  mcp-bridge.ts                 Per-stream MCP bridge orchestration
  mcp-session-server.ts         MCP stdio server launched by agent CLIs
  tools/
    workspace.ts                im_list_files / im_send_file
    capture.ts                  take_screenshot
    gui.ts                      Reserved GUI tool module
    types.ts                    MCP tool definitions and helpers

  server.ts                     Hono-based dashboard server
  runtime.ts                    Dashboard runtime singleton (bot ref, prefs, cache)
  routes/
    config.ts                   Config/channel/extension/permission API routes
    agents.ts                   Agent/model API routes
    sessions.ts                 Session/workspace API routes
  config-validation.ts          Channel credential checks
  channel-states.ts             Channel validation caching
  session-status.ts             Runtime session helpers

  user-config.ts                ~/.pikiclaw/setting.json persistence
  onboarding.ts                 setup/doctor state
  setup-wizard.ts               terminal setup flow
  process-control.ts            restart + watchdog helpers
  run.ts                        standalone local commands
```

## Key Concepts

- `bot.ts` owns shared runtime state and `runStream()`
- `bot-commands.ts` returns structured data for command responses
- `bot-command-ui.ts` centralizes session/agent/model/skill selection logic
- `bot-handler.ts` runs the standard placeholder -> preview -> stream -> final reply flow
- `code-agent.ts` dispatches to registered drivers and handles session workspace mechanics
- `mcp-bridge.ts` injects session-scoped MCP tools into each stream
- `server.ts` is the Hono-based dashboard server; `runtime.ts` holds the singleton bot ref and dashboard state
- `routes/*.ts` are modular Hono route handlers for all dashboard API endpoints
- Dashboard frontend uses react-router-dom for page routing (Vite + React SPA served as static files)

## Current Product Surface

- Channels: Telegram and Feishu
- Agents: Claude Code, Codex CLI, Gemini CLI
- Skills: `.pikiclaw/skills` and `.claude/commands`
- Session-scoped MCP tools:
  - `im_list_files`
  - `im_send_file`
  - `take_screenshot`
- Dashboard setup and runtime monitoring

## Test Commands

```bash
npm run dev
npm test
npx vitest run test/code-agent.unit.test.ts
```

## Notes

- Persistent config is `~/.pikiclaw/setting.json`
- The dashboard is part of the normal runtime, not just a setup helper
- GUI automation tools are not fully implemented yet; `src/tools/gui.ts` is still a placeholder
- This machine always has a production/self-bootstrap communication path via `npx pikiclaw@latest`; do not kill, replace, or "clean up" that process when the task only concerns dev mode
- `npm run dev` is the local-only development path: it runs with `--no-daemon`, stays on the checked-out source tree, and rewrites `~/.pikiclaw/dev/dev.log` from scratch on each launch
- If a test or validation step needs a running `pikiclaw` process, use `npm run dev`
