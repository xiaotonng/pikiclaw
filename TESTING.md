# Testing Guide

## Environment Setup

E2E tests require environment variables loaded from `.env`. Use `set -a` to auto-export:

```sh
set -a && source .env && set +a
```

Required variables by test:

| Variable | Used by | Required? |
|----------|---------|-----------|
| `TELEGRAM_BOT_TOKEN` | channel-telegram e2e, bot-telegram e2e | Yes (tests skip if unset) |
| `TELEGRAM_TEST_CHAT_ID` | channel-telegram e2e, bot-telegram e2e | No (auto-detected from recent messages or first poll) |
| `TELEGRAM_INTERACTIVE` | bot-telegram e2e | No (set `=1` to enable interactive scenarios) |

Additionally:
- **code-agent e2e** and **bot-telegram e2e** require `claude` and/or `codex` CLI installed and authenticated. Tests auto-skip for unavailable agents.
- **getSessions e2e** requires real session files on disk (`~/.claude`, `~/.codex`).

## Quick Reference

```sh
# Run ALL tests (unit + e2e, needs env vars + CLI auth)
set -a && source .env && set +a && npx vitest run

# Run all unit tests only (no API calls, fast, no env vars needed)
npx vitest run test/channel-telegram.unit.test.ts test/code-agent.unit.test.ts

# Run code-agent e2e (requires CLI auth, costs tokens)
npx vitest run test/code-agent.e2e.test.ts

# Run switch-workdir e2e (requires CLI auth, costs tokens)
npx vitest run test/switch-workdir.e2e.test.ts

# Run restart e2e (requires TELEGRAM_BOT_TOKEN, standalone script)
set -a && source .env && set +a && npx tsx test/restart.e2e.test.ts

# Run getSessions e2e (requires real session files on disk)
npx vitest run test/getSessions.e2e.test.ts

# Run Telegram channel e2e (requires TELEGRAM_BOT_TOKEN, interactive)
set -a && source .env && set +a && npx vitest run test/channel-telegram.e2e.test.ts

# Run bot-telegram e2e — automated (requires TELEGRAM_BOT_TOKEN + claude/codex)
set -a && source .env && set +a && npx vitest run test/bot-telegram.e2e.test.ts

# Run bot-telegram e2e — interactive (user clicks buttons / types commands in Telegram)
set -a && source .env && set +a && \
  TELEGRAM_INTERACTIVE=1 npx vitest run test/bot-telegram.e2e.test.ts

# Run a single interactive scenario
set -a && source .env && set +a && TELEGRAM_INTERACTIVE=1 \
  npx vitest run test/bot-telegram.e2e.test.ts -t "interactive: agent switch"

# Watch mode
npx vitest
```

## Test Files

| File | Type | What it tests | API calls? |
|------|------|---------------|------------|
| `test/channel-telegram.unit.test.ts` | Unit | TelegramChannel: mocked API, dispatch, handlers, filtering, send/edit/delete | No |
| `test/code-agent.unit.test.ts` | Unit | Code agent (`code-agent.ts`): codex/claude stream parsing, routing, attachments, edge cases | No |
| `test/channel-telegram.e2e.test.ts` | E2E (live) | TelegramChannel: real Telegram Bot API, send/receive/edit/photo/file/keyboard/callback | **Yes** (Telegram) |
| `test/code-agent.e2e.test.ts` | E2E (live) | Code agent against real codex/claude CLIs: single/multi-turn, attachments, browser automation | **Yes** (AI) |
| `test/bot-telegram.e2e.test.ts` | E2E (live) | TelegramBot: commands, real agent calls, callbacks, session/agent switch, directory browser | **Yes** (Telegram + AI) |
| `test/switch-workdir.e2e.test.ts` | E2E (live) | `/switch` workdir: switch to `src/`, verify agent sees correct files via real CLI | **Yes** (AI) |
| `test/restart.e2e.test.ts` | E2E (live) | `/restart`: spawn → SIGUSR2 → new process with different PID | **Yes** (Telegram) |
| `test/getSessions.e2e.test.ts` | E2E (local) | `getSessions()`: reads real claude/codex session files from disk | No (disk only) |

## Unit Tests

### `test/channel-telegram.unit.test.ts` — TelegramChannel

Uses `vi.fn()` to mock the Telegram Bot API. No real HTTP calls.

- **connect** — getMe, bot info
- **send / edit / delete** — API payload construction, parseMode, replyTo
- **onCommand** — /command dispatch, args parsing, @botname stripping, ctx.reply
- **onMessage** — text, group mention filtering, photo aggregation with downloadFile mock
- **onCallback** — callback data dispatch, ctx.answerCallback
- **filtering** — allowedChatIds, group requireMention, reply-to-bot
- **setMenu / drain / onError** — menu commands, update drain, error propagation
- **full echo bot scenario** — command -> message -> callback full flow

### `test/code-agent.unit.test.ts` — Code Agent

Uses fake shell scripts that emit JSONL to simulate CLI output. No real API calls.

- **codex stream** — Single-turn parsing, reasoning, incremental `onText`, resume command
- **claude stream** — `stream-json` events, thinking deltas, `assistant` fallback, expired session retry, error handling
- **doStream** — Unified routing to codex/claude
- **attachments** — Verifies `--image` flags (codex), `--input-format stream-json` multimodal stdin (claude), empty/undefined cases
- **edge cases** — Process crash, empty output, non-JSON noise, preserving initial model/thinkingEffort

## E2E Tests

### `test/channel-telegram.e2e.test.ts` — TelegramChannel (Live Telegram)

Real Telegram Bot API, interactive. Requires `TELEGRAM_BOT_TOKEN`.

```sh
set -a && source .env && set +a && npx vitest run test/channel-telegram.e2e.test.ts
```

- **SEND** — plain text, HTML rich text, photo (generated PNG), file, inline keyboard, streaming simulation (send + edit + edit), set bottom menu
- **RECEIVE** — text, photo, file, inline button click (callback), bottom menu command, batch (5 rapid messages)
- **CLEANUP** — drain pending updates

### `test/bot-telegram.e2e.test.ts` — TelegramBot (Live Telegram + Agent)

Full end-to-end: real Telegram API + real code agent (claude/codex). Interactive.
Requires `TELEGRAM_BOT_TOKEN` and at least one of `claude` / `codex` installed.

```sh
# Automated (no user interaction needed, CHAT_ID auto-detected):
set -a && source .env && set +a && npx vitest run test/bot-telegram.e2e.test.ts

# Interactive (user clicks buttons / types commands in Telegram):
set -a && source .env && set +a && \
  TELEGRAM_INTERACTIVE=1 npx vitest run test/bot-telegram.e2e.test.ts

# Run a single interactive scenario:
set -a && source .env && set +a && TELEGRAM_INTERACTIVE=1 \
  npx vitest run test/bot-telegram.e2e.test.ts -t "interactive: agent switch"
# also: "interactive: session", "interactive: directory",
#        "interactive: command", "interactive: free text"
```

#### Automated (default)
- **Commands** — /start, /status, /host, /agents, /sessions, /switch — real Telegram send, verified content + inline keyboards
- **Callbacks** — agent switch + session management via `handleCallback` directly
- **Message -> Agent** — real agent call, streamed reply, multi-turn session resume

#### Interactive (`TELEGRAM_INTERACTIVE=1`)
Each scenario is an independent describe block, runnable individually via `-t`:
- **interactive: agent switch** — user clicks agent button from /agents
- **interactive: session** — user clicks session/new-session button from /sessions
- **interactive: directory** — user browses and selects directory from /switch
- **interactive: command** — user types /status in Telegram
- **interactive: free text** — user sends text, bot calls real agent

Agent-dependent tests auto-skip if neither `claude` nor `codex` is installed.

### `test/code-agent.e2e.test.ts` — Code Agent (Live CLI)

Hits real `codex` and `claude` CLIs. Requires authentication and costs tokens. Tests are auto-skipped if the CLI is not installed.

Run by category with `-t`:

```sh
# Basic: single turn, multi-turn, routing
npx vitest run test/code-agent.e2e.test.ts -t "codex e2e|claude e2e|doStream e2e"

# Attachments: image recognition, file summarization
npx vitest run test/code-agent.e2e.test.ts -t "attachments"

# Browser: open Chrome, run JS, take screenshot
npx vitest run test/code-agent.e2e.test.ts -t "browser"
```

#### Basic

- **codex/claude single turn** — Send prompt, verify response + sessionId
- **codex/claude multi-turn** — Remember a word, resume session, verify recall
- **claude expired session** — Fake sessionId triggers auto-retry as new conversation
- **doStream routing** — Unified entry routes to correct engine

#### Attachments

- **Image recognition** — Generates a 2x2 red PNG, asks the model to identify the color
- **File summarization** — Creates a text file about pangrams, asks the model to summarize

#### Browser Automation

- **Screenshot** — Opens Chrome via shell, runs JS via AppleScript, captures screenshot

### `test/restart.e2e.test.ts` — Restart (Standalone Script)

Standalone executable script (not vitest). Verifies that `/restart` spawns a new process with a different PID and the old process exits cleanly. Uses `SIGUSR2` to trigger the same code path as the `/restart` Telegram command. Requires `TELEGRAM_BOT_TOKEN`.

```sh
set -a && source .env && set +a && npx tsx test/restart.e2e.test.ts
```

- **Step 1–2** — Spawn bot, wait for "polling started"
- **Step 3–4** — Send SIGUSR2, extract new PID from spawn log
- **Step 5–6** — Assert PIDs differ, old process exits with code 0
- **Step 7–8** — New process starts polling, verify it is alive
- **Step 9** — Clean up (SIGTERM new process)

### `test/switch-workdir.e2e.test.ts` — Switch Workdir (Live CLI)

Verifies that after `switchWorkdir()`, the agent truly operates inside the new directory. Uses real project subdirectories (`src/`) — no temp dirs, no mocking.

Requires `claude` or `codex` CLI installed and authenticated. Auto-skips if neither is available.

```sh
npx vitest run test/switch-workdir.e2e.test.ts
```

- **switchWorkdir updates bot.workdir and resets all sessions** — workdir changes, all chat sessions reset to null
- **agent lists src/ files after switching workdir to src/** — real agent call, response contains `code-agent.ts`, `bot.ts`, `cli.ts`
- **runStream also respects switched workdir** — same verification through `bot.runStream()` full chain

### `test/getSessions.e2e.test.ts` — getSessions (Local Disk)

Reads real session files from `~/.claude` and `~/.codex` directories. No network calls — only disk I/O. Requires that you have previously used `claude` or `codex` in the target workdir so session files exist.

```sh
npx vitest run test/getSessions.e2e.test.ts
```

- **claude sessions** — Reads session list, verifies `sessionId`, `workdir`, `model`, `createdAt`, `title`
- **codex sessions** — Reads session list, verifies fields + at least some sessions have a title

## Adding Tests

- **Unit tests**: Add to the appropriate `describe` block. Use `createTestChannel()` for channel tests, `writeFakeScript()` for code-agent tests.
- **Channel E2E**: Follow `channel-telegram.e2e.test.ts` pattern — `prompt()` to instruct the user, `waitMessages()` / `waitCallback()` to capture response.
- **Bot E2E**: Follow `bot-telegram.e2e.test.ts` pattern — `makeRealCtx()` for direct handler calls, `waitMessages()` / `waitCommand()` for interactive tests.
- **Agent E2E**: Wrap with `describe.skipIf(!HAS_CLAUDE)` or `it.skipIf(!HAS_CODEX)`. Use `baseOpts()` helper.
