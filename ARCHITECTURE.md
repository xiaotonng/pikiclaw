# Architecture

## File Structure

```
src/
  cli.ts                 CLI entry point: arg parsing, env mapping, channel dispatch
  bot.ts                 Shared bot base: config, state, data methods, streaming, keep-alive
  bot-telegram.ts        Telegram bot: HTML rendering, keyboards, callbacks, lifecycle
  channel-base.ts        Transport abstraction: lifecycle + outgoing primitives
  channel-telegram.ts    Telegram transport: API, polling, file download, message dispatch
  code-agent.ts          AI agent abstraction: spawn claude/codex CLI, parse JSON stream
```

## Layering

```
┌──────────────────────────────────────────────────────────────┐
│  cli.ts                                                      │
│  Parse args → resolve channel → map env → dispatch bot       │
├──────────────────────────────────────────────────────────────┤
│  bot.ts  (shared base, channel-agnostic)                     │
│  ├ Config         workdir, agent, model, timeout             │
│  ├ State          chats, activeTasks, stats                  │
│  ├ Data methods   getStatusData(), getHostData()             │
│  ├ Actions        switchWorkdir(), runStream()               │
│  ├ Data access    fetchSessions(), fetchAgents()             │
│  ├ Keep-alive     caffeinate / systemd-inhibit               │
│  └ Helpers        fmtTokens, fmtUptime, thinkLabel, ...     │
├──────────────────────────────────────────────────────────────┤
│  bot-telegram.ts  (Telegram presentation, extends Bot)       │
│  ├ HTML rendering escapeHtml, mdToTgHtml, fmtSeg             │
│  ├ Keyboards      PathRegistry, buildDirKeyboard, quickReply │
│  ├ Commands       cmdStart/Status/Host/Sessions/Switch/Agents│
│  ├ Streaming UI   placeholder → throttled editMessage        │
│  ├ Artifacts      per-turn dir, manifest validation, uploads │
│  ├ Callbacks      sw:/sess:/ag:/qr: routing                  │
│  └ Lifecycle      run() — connect, drain, menu, poll, signal │
├──────────────────────────────────────────────────────────────┤
│  channel-base.ts  (transport abstraction)                    │
│  ├ Channel        connect / listen / disconnect              │
│  ├ Outgoing       send / editMessage / deleteMessage         │
│  └ Helpers        splitText, sleep                           │
├──────────────────────────────────────────────────────────────┤
│  channel-telegram.ts  (Telegram transport, extends Channel)  │
│  ├ Telegram API   getMe, getUpdates, sendMessage, ...        │
│  ├ Dispatch       command/message/callback routing to hooks  │
│  ├ File download  photo/document → local path                │
│  ├ File upload    sendPhoto/sendDocument/sendFile routing    │
│  ├ Group filter   @mention / reply-to-bot detection          │
│  └ Smart behavior parseMode fallback, message splitting      │
├──────────────────────────────────────────────────────────────┤
│  code-agent.ts  (AI agent abstraction)                       │
│  ├ doStream()     spawn claude/codex CLI, parse JSONL        │
│  ├ getSessions()  list local sessions by engine + workdir    │
│  ├ getUsage()     inspect local Codex/Claude usage telemetry │
│  └ listAgents()   detect installed CLIs + versions           │
└──────────────────────────────────────────────────────────────┘
```

## Design Principles

**Data / render split** — bot.ts provides data methods (`getStatusData`, `getHostData`,
`fetchSessions`, `fetchAgents`), bot-telegram.ts only renders to Telegram HTML.
Adding a new IM means writing bot-xxx.ts that calls the same data methods with
different rendering (Lark cards, WhatsApp interactive messages, etc.).

**Channel = transport only** — channel-telegram.ts handles Telegram API communication
(polling, sending, file download/upload routing, message dispatch). It knows nothing
about commands, sessions, or agents. It is independently testable.

**Bot = business logic** — bot.ts holds all shared state and logic. bot-telegram.ts
extends it to add Telegram-specific presentation. The split point: if the logic would
be identical for another IM, it belongs in bot.ts.

**Env var scoping** — bot.ts only reads channel-agnostic env vars (`CODECLAW_*`).
Channel-specific env vars (`TELEGRAM_*`, `FEISHU_*`) are read in the corresponding
bot-xxx.ts constructor.

## Adding a New IM Channel

1. Create `channel-xxx.ts` extending `Channel` from channel-base.ts
2. Create `bot-xxx.ts` extending `Bot` from bot.ts
   - Render commands using `this.getStatusData()`, `this.getHostData()`, etc.
   - Implement channel-specific interaction (cards, buttons, menus)
   - Read channel-specific env vars in constructor
3. Add dispatch case in `cli.ts`

## Bot Commands

| Command     | Description                          |
|-------------|--------------------------------------|
| `/start`    | Welcome + command list               |
| `/sessions` | List / switch sessions (inline keys) |
| `/agents`   | List / switch AI agents              |
| `/status`   | Bot status, uptime, provider usage, token usage |
| `/host`     | Host machine info (CPU, memory, disk, battery) |
| `/switch`   | Browse and change working directory   |
| `/restart`  | Restart with latest version via non-interactive `npx --yes` |

Direct messages (no command prefix) are forwarded to the current AI agent.

## Test Files

| File                              | Tests                              | API calls? |
|-----------------------------------|------------------------------------|------------|
| `test/e2e/codeclaw.e2e.test.ts`       | Bot commands + callbacks (real fs)  | No         |
| `test/e2e/channel-telegram.e2e.test.ts` | Telegram channel (real API)       | Yes        |
| `test/channel-telegram.unit.test.ts` | Telegram channel (mocked)        | No         |
| `test/e2e/code-agent.e2e.test.ts`     | Real claude/codex CLI              | Yes        |
| `test/code-agent.unit.test.ts`    | Stream parsing (fake scripts)      | No         |
| `test/e2e/restart.e2e.test.ts`        | Restart: PID change (standalone)   | Yes        |
