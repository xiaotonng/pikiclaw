# Testing Guide

`pikiclaw` uses Vitest for all automated tests. Live runtime validation goes through `npm run dev`.

## Test Commands

```sh
# Run all unit tests
npm test

# Watch mode
npm run test:watch

# Single file
npx vitest run test/code-agent.unit.test.ts

# Manual runtime / startup validation (preferred for anything that launches pikiclaw)
npm run dev

# Manual end-to-end interaction verification (real dashboard + bot + human loop)
npx tsx test/verify-interaction-e2e.ts
```

There is a single Vitest configuration (`vitest.config.ts`); every `test/*.unit.test.ts` file is picked up automatically.

## Startup Rule

If a test or validation step needs to launch `pikiclaw` itself, use `npm run dev`.

- `npm run dev` is the local-only startup path
- It runs with `--no-daemon`, so it stays on the checked-out source tree
- It rewrites `~/.pikiclaw/dev/dev.log` on each launch
- Do not kill or reuse the long-lived production/self-bootstrap `npx pikiclaw@latest` process on this machine as part of dev testing

## Environment Setup

For tests that hit live IM transports or live agent CLIs, load `.env` first:

```sh
set -a && source .env && set +a
```

Useful environment variables:

| Variable | Used by |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram channel and bot tests |
| `TELEGRAM_TEST_CHAT_ID` | Telegram live test target chat |
| `TELEGRAM_INTERACTIVE` | Interactive Telegram bot scenarios |
| `FEISHU_APP_ID` | Feishu runtime when testing locally |
| `FEISHU_APP_SECRET` | Feishu runtime when testing locally |

Agent live tests also require the corresponding CLI to be installed and authenticated.

## Current Test Files

| File | Scope |
|---|---|
| `test/bot.unit.test.ts` | Shared `Bot` base class behavior, chat state, runStream wiring |
| `test/bot-telegram.unit.test.ts` | Telegram bot orchestration (commands, callbacks, streaming lifecycle) |
| `test/channel-telegram.unit.test.ts` | Telegram transport (send / edit / delete / upload / download) |
| `test/code-agent.unit.test.ts` | Shared agent layer, stream handling, session workspace |
| `test/driver-claude.unit.test.ts` | Claude Code driver — stream parsing, model listing |
| `test/driver-codex.unit.test.ts` | Codex driver — HTTP server, streaming, human-in-the-loop |
| `test/driver-gemini.unit.test.ts` | Gemini driver — stream parsing, session reads |
| `test/mcp-bridge.unit.test.ts` | MCP bridge — path resolution, validation, callback wiring |
| `test/interaction.unit.test.ts` | Unified human-in-the-loop interaction flow (Codex + im_ask_user) |
| `test/session-control.unit.test.ts` | Dashboard session-control surface |
| `test/session-messages-window.unit.test.ts` | Session message windowing for dashboard streaming |
| `test/dashboard-live-session-state.unit.test.ts` | Dashboard live session state tracking |
| `test/dashboard-assistant-content.unit.test.ts` | Dashboard assistant content rendering |
| `test/project-skills.unit.test.ts` | Project skill discovery + `.claude/commands` compat |
| `test/process-control.unit.test.ts` | Restart, watchdog, process tree termination |
| `test/browser-supervisor.unit.test.ts` | Managed-browser singleton: probe / ensure / invalidate |

## Manual Verification Scripts

| File | Scope |
|---|---|
| `test/verify-interaction-e2e.ts` | Spins up a real dashboard + bot, submits a task that triggers human-in-the-loop, and answers via REST — mirrors the dashboard frontend flow. Run with `npx tsx test/verify-interaction-e2e.ts`. |

For any IM-driven manual end-to-end validation, start the local runtime with `npm run dev` and inspect `~/.pikiclaw/dev/dev.log`.

## Common Runs

```sh
# Local startup validation with fresh dev log
npm run dev

# One unit file
npx vitest run test/mcp-bridge.unit.test.ts

# One Telegram unit file
npx vitest run test/bot-telegram.unit.test.ts

# Manual interaction verification (full real path)
npx tsx test/verify-interaction-e2e.ts
```

## Testing Rules

### Unit tests

- Mocks are allowed and encouraged for transport / external-CLI boundaries
- Prefer focused coverage around one module or behavior
- Good fit for parsers, renderers, config logic, transport branching, state machines

### Live / interaction verification

- Do not mock the system being verified
- Use real CLIs, real transports, and real files where applicable
- Skip cleanly when the required runtime is unavailable
- Keep these as scripts (`test/verify-*.ts`) or run them through `npm run dev`, not in the default `vitest run` path — they consume tokens and send real messages

## Suggested Workflow

1. Run `npm test`
2. Run the specific unit file for the area you changed
3. If your change touches channels, drivers, the dashboard, or process control, run the relevant interaction verification with real credentials when possible
4. If your change affects docs only, a build or test run is optional but still useful for quick sanity

## Notes

- `test/support/` contains shared helpers (Telegram harness, stream assertions, env, e2e helpers)
- Some interaction-style tests are now consolidated as unit tests with mocked transports — for example `test/interaction.unit.test.ts` covers the human-in-the-loop flow that previously lived in a separate live-bot E2E
- For full real-environment validation, prefer `npm run dev` plus the manual verification scripts under `test/verify-*.ts`
