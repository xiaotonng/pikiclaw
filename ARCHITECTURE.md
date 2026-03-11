# Architecture

## File Structure

```
src/
  cli.ts                 CLI entry point: arg parsing, env mapping, channel dispatch
  bot.ts                 Shared bot base: config, state, data methods, streaming, keep-alive
  bot-menu.ts            Telegram menu composition: welcome copy + skill command mapping
  bot-streaming.ts       Stream preview summarizers: prompt cleanup, plan/activity summaries
  bot-commands.ts        Channel-agnostic command data layer (structured data, no rendering)
  bot-handler.ts         Channel-agnostic message handling pipeline (MessagePipeline interface)
  bot-telegram.ts        Telegram bot orchestration: commands, callbacks, lifecycle
  bot-telegram-render.ts Telegram HTML/render helpers: markdown, status/final reply formatting
  bot-telegram-directory.ts Telegram workdir browser state + inline keyboards
  bot-telegram-live-preview.ts Telegram live preview controller: throttled edits + typing pulses
  channel-base.ts        Transport abstraction: lifecycle + outgoing primitives + capability helpers
  channel-telegram.ts    Telegram transport: API, polling, file download, message dispatch
  agent-driver.ts        AgentDriver interface + registry (registerDriver / getDriver / allDrivers)
  code-agent.ts          Shared agent layer: types, session management, artifact helpers, CLI spawn
  driver-claude.ts       Claude CLI driver: stream, sessions, tail, models, usage
  driver-codex.ts        Codex CLI driver: app-server RPC, stream, sessions, tail, models, usage
  driver-gemini.ts       Gemini CLI driver: stream, sessions, tail, models, usage (skeleton)
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
│  ├ Session state  resetChatConversation(), adoptSession()    │
│  ├ Keep-alive     caffeinate / systemd-inhibit               │
│  └ Helpers        fmtTokens, fmtUptime, thinkLabel, ...     │
├──────────────────────────────────────────────────────────────┤
│  bot-telegram.ts  (Telegram orchestration, extends Bot)      │
│  ├ Commands       cmdStart/Status/Host/Sessions/Switch/Agents│
│  ├ Callbacks      sw:/sess:/ag:/mod: routing                 │
│  ├ Artifacts      upload after final reply                   │
│  └ Lifecycle      run() → connect, drain, menu, poll, signal│
├──────────────────────────────────────────────────────────────┤
│  bot-telegram-render.ts  (Telegram rendering helpers)        │
│  ├ HTML           escapeHtml(), mdToTgHtml()                 │
│  ├ Status/menu    formatMenuLines(), formatProviderUsageLines│
│  ├ Preview        buildInitialPreviewHtml(), buildStreamPreviewHtml() │
│  └ Final reply    buildFinalReplyRender()                    │
├──────────────────────────────────────────────────────────────┤
│  bot-telegram-directory.ts  (Telegram workdir browser)       │
│  ├ Registry       compact callback-data path registry        │
│  ├ View           buildSwitchWorkdirView()                   │
│  └ Lookup         resolveRegisteredPath()                    │
├──────────────────────────────────────────────────────────────┤
│  bot-telegram-live-preview.ts  (stream UI controller)        │
│  ├ Timing         throttle edits + stalled heartbeats        │
│  ├ Feedback       typing pulse lifecycle                     │
│  ├ State          latest text / thinking / activity / plan   │
│  └ Flush          settle() / dispose()                       │
├──────────────────────────────────────────────────────────────┤
│  channel-base.ts  (transport abstraction)                    │
│  ├ Channel        connect / listen / disconnect              │
│  ├ Outgoing       send / editMessage / deleteMessage         │
│  └ Helpers        splitText, sleep, supportsChannelCapability│
├──────────────────────────────────────────────────────────────┤
│  channel-telegram.ts  (Telegram transport, extends Channel)  │
│  ├ Telegram API   getMe, getUpdates, sendMessage, ...        │
│  ├ Dispatch       command/message/callback routing to hooks  │
│  ├ File download  photo/document → local path                │
│  ├ File upload    sendPhoto/sendDocument/sendFile routing    │
│  ├ Group filter   @mention / reply-to-bot detection          │
│  └ Smart behavior parseMode fallback, message splitting      │
├──────────────────────────────────────────────────────────────┤
│  agent-driver.ts  (driver interface + registry)                │
│  ├ AgentDriver    interface: doStream, getSessions, etc.      │
│  ├ registerDriver register a driver implementation            │
│  ├ getDriver      look up driver by id, throw if unknown      │
│  └ allDrivers     list all registered drivers                 │
├──────────────────────────────────────────────────────────────┤
│  code-agent.ts  (shared agent layer)                          │
│  ├ Types          StreamOpts, StreamResult, SessionInfo, ...  │
│  ├ Session mgmt   workspace creation, index, staging, migrate │
│  ├ Artifacts      collectArtifacts, buildArtifactPrompt       │
│  ├ CLI spawn      run() — shared spawn+readline framework     │
│  └ Dispatch       doStream/getSessions/... → getDriver(agent) │
├──────────────────────────────────────────────────────────────┤
│  driver-claude.ts / driver-codex.ts / driver-gemini.ts        │
│  Each implements AgentDriver:                                 │
│  ├ doStream       agent-specific streaming logic              │
│  ├ getSessions    session listing from local index            │
│  ├ getSessionTail read conversation history                   │
│  ├ listModels     discover available models                   │
│  ├ getUsage       rate limit / usage telemetry                │
│  └ shutdown       cleanup (e.g. codex app-server)             │
└──────────────────────────────────────────────────────────────┘
```

## Design Principles

**Data / render split** — bot.ts provides data methods (`getStatusData`, `getHostData`,
`fetchSessions`, `fetchAgents`), while Telegram HTML and preview assembly live in
`bot-telegram-render.ts`. Adding a new IM means writing bot-xxx.ts plus renderer/view
helpers for that channel, not re-embedding shared state logic.

**Channel = transport only** — channel-telegram.ts handles Telegram API communication
(polling, sending, file download/upload routing, message dispatch). It knows nothing
about commands, sessions, or agents. It is independently testable.

**Bot = business logic** — bot.ts holds shared state and session mutation helpers.
bot-telegram.ts is now primarily orchestration: command/callback routing, channel calls,
and composition of smaller Telegram-specific helpers.

**Stream UI controller** — live preview timing, typing pulses, and throttled edits are
stateful UI concerns, so they live in `bot-telegram-live-preview.ts` instead of being
inlined inside `handleMessage()`.

**Env var scoping** — bot.ts only reads channel-agnostic env vars (`CODECLAW_*`).
Channel-specific env vars (`TELEGRAM_*`, `FEISHU_*`) are read in the corresponding
bot-xxx.ts constructor.

## Adding a New AI Agent (CLI)

To integrate a new CLI agent (e.g. `aider`, `cursor`, `gemini`):

### 1. Create the driver file

Create `src/driver-xxx.ts`. Implement the `AgentDriver` interface and call `registerDriver()`:

```typescript
// src/driver-xxx.ts
import { registerDriver, type AgentDriver } from './agent-driver.js';
import {
  type AgentInfo, type StreamOpts, type StreamResult,
  type SessionListResult, type SessionTailOpts, type SessionTailResult,
  type ModelListOpts, type ModelListResult,
  type UsageOpts, type UsageResult,
  run, detectAgentBin, listCodeclawSessions, emptyUsage,
} from './code-agent.js';

function xxxCmd(o: StreamOpts): string[] {
  const args = ['xxx-cli'];
  if (o.xxxModel) args.push('--model', o.xxxModel);
  if (o.sessionId) args.push('--resume', o.sessionId);
  return args;
}

function xxxParse(ev: any, s: any) {
  // Parse the CLI's JSON stream events into s.text, s.thinking, s.sessionId, etc.
  // See driver-claude.ts (claudeParse) for a line-by-line parsing example.
}

class XxxDriver implements AgentDriver {
  readonly id = 'xxx';
  readonly cmd = 'xxx-cli';
  readonly thinkLabel = 'Thinking';

  detect(): AgentInfo { return detectAgentBin('xxx-cli', 'xxx'); }

  async doStream(opts: StreamOpts): Promise<StreamResult> {
    // Option A: CLI spawn (like Claude) — use the shared run() framework
    return run(xxxCmd(opts), opts, xxxParse);
    // Option B: RPC/WebSocket — see driver-codex.ts for an app-server example
  }

  async getSessions(workdir: string, limit?: number): Promise<SessionListResult> {
    // Session workspace is managed by code-agent.ts; just read the local index
    const sessions = listCodeclawSessions(workdir, 'xxx', limit).map(r => ({
      sessionId: r.engineSessionId, localSessionId: r.localSessionId,
      engineSessionId: r.engineSessionId, agent: 'xxx' as const,
      workdir: r.workdir, workspacePath: r.workspacePath,
      model: r.model, createdAt: r.createdAt, title: r.title,
      running: Date.now() - Date.parse(r.updatedAt) < 10_000,
    }));
    return { ok: true, sessions, error: null };
  }

  async getSessionTail(_opts: SessionTailOpts): Promise<SessionTailResult> {
    return { ok: true, messages: [], error: null }; // implement when protocol is known
  }

  async listModels(_opts: ModelListOpts): Promise<ModelListResult> {
    return { agent: 'xxx', models: [{ id: 'xxx-default', alias: null }], sources: [], note: null };
  }

  getUsage(_opts: UsageOpts): UsageResult {
    return emptyUsage('xxx', 'Usage not yet implemented.');
  }

  shutdown() {}
}

registerDriver(new XxxDriver());
```

### 2. Register the driver

Add a single import line in `src/code-agent.ts`:

```typescript
import './driver-xxx.js';
```

This triggers `registerDriver()` at startup. All dispatch points (`doStream`, `getSessions`,
`getSessionTail`, `listModels`, `getUsage`, `listAgents`) automatically pick up the new agent.

### 3. Add bot config

In `src/bot.ts`, add a config entry in the `agentConfigs` initializer:

```typescript
this.agentConfigs = {
  // ... existing entries
  xxx: {
    model: (process.env.XXX_MODEL || 'xxx-default').trim(),
    extraArgs: shellSplit(process.env.XXX_EXTRA_ARGS || ''),
  },
};
```

### 4. Add StreamOpts fields (if needed)

If the agent needs custom options beyond `model` and `extraArgs`, add optional fields to
`StreamOpts` in `code-agent.ts`:

```typescript
export interface StreamOpts {
  // ... existing fields
  xxxModel?: string;
  xxxExtraArgs?: string[];
}
```

And populate them in `Bot.runStream()`:

```typescript
xxxModel: cs.agent === 'xxx' ? resolvedModel : (this.agentConfigs.xxx?.model || ''),
```

### What you don't need to touch

- **Other driver files** — driver-claude.ts, driver-codex.ts are unchanged
- **bot-telegram.ts** — commands, callbacks, live preview all work automatically
- **bot-commands.ts** — agent listing, model switching, usage display work via registry
- **Tests** — existing tests remain unaffected; add `driver-xxx.unit.test.ts` for yours

### Key shared infrastructure

| Function / Module | What it provides |
|---|---|
| `run(cmd, opts, parseLine)` | Spawn CLI, readline stdout, timeout, parse JSON events |
| `detectAgentBin(cmd, id)` | `which` + `--version` detection |
| `listCodeclawSessions(workdir, agent)` | Read local session index |
| `findCodeclawSessionByLocalId(...)` | Lookup by local ID |
| `collectArtifacts(workspacePath)` | Read return manifest, validate files |
| `buildArtifactSystemPrompt(...)` | Artifact return instructions for system prompt |
| `buildStreamPreviewMeta(s)` | Token usage → preview metadata |
| `pushRecentActivity(lines, line)` | Activity feed accumulation |
| `emptyUsage(agent, error)` | Empty usage result |

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
