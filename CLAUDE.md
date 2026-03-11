# Codeclaw

IM-driven bridge for AI coding agents (Claude Code, Codex CLI). Users send messages via IM, codeclaw streams them to a local agent and returns results.

## Project Structure

```
src/
  cli.ts                        Entry point, arg parsing, channel dispatch
  bot.ts                        Base class: config, state, sessions, streaming, keep-alive
  bot-commands.ts               Channel-agnostic command data layer (returns structured data, no rendering)
  bot-handler.ts                Generic message handling pipeline (MessagePipeline interface)
  bot-menu.ts                   Menu command definitions, skill indexing
  bot-streaming.ts              Stream preview utilities, activity parsing
  code-agent.ts                 AI agent abstraction (Claude/Codex CLI spawning, JSONL parsing)

  channel-base.ts               Abstract Channel class, ChannelCapabilities
  channel-telegram.ts           Telegram Bot API transport

  bot-telegram.ts               Telegram bot orchestration (commands, callbacks, lifecycle)
  bot-telegram-render.ts        Telegram HTML rendering
  bot-telegram-live-preview.ts  LivePreview controller (channel-agnostic with renderer injection)
  bot-telegram-directory.ts     Telegram workdir browser UI

  user-config.ts                User config persistence (~/.config/codeclaw/config.json)
  onboarding.ts                 Setup checks and guide
  setup-wizard.ts               Interactive setup wizard
  run.ts                        Standalone CLI commands
```

## Architecture Layers

```
cli.ts → bot-{platform}.ts → bot.ts → code-agent.ts
              ↓                 ↑
         channel-{platform}.ts  bot-commands.ts (shared data)
              ↓                 bot-handler.ts  (shared pipeline)
         channel-base.ts
```

- **bot.ts (Bot)** — Channel-agnostic base. Manages config, `ChatId` (number | string), session state, `runStream()`, keep-alive. All IM bots extend this.
- **bot-commands.ts** — Pure data functions: `getStartData()`, `getSessionsPageData()`, `getAgentsListData()`, `getModelsListData()`, `getStatusDataAsync()`, `getHostDataSync()`, `resolveSkillPrompt()`. Returns structured objects, no rendering.
- **bot-handler.ts** — `MessagePipeline<TCtx>` interface + `handleIncomingMessage()` orchestration. Session resolution → placeholder → live preview → stream → final reply → artifacts.
- **bot-telegram-live-preview.ts** — `LivePreview` class accepts a `LivePreviewRenderer` interface. Channel-agnostic timing/throttling; rendering is injected per platform.
- **channel-base.ts** — Abstract `Channel` with `ChannelCapabilities` flags. Each platform implements `connect()`, `listen()`, `disconnect()`, `send()`, `editMessage()`, etc.

## Adding a New IM Platform

Create 3 files + 1 dispatch line:

### 1. `channel-{name}.ts` — Transport
```typescript
import { Channel } from './channel-base.js';
export class XxxChannel extends Channel {
  // implement connect(), listen(), disconnect(), send(), editMessage(), ...
  // define capabilities (editMessages, fileUpload, etc.)
  // add platform-specific hooks: onMessage(), onCommand(), onCallback()
}
```

### 2. `bot-{name}-render.ts` — Rendering
```typescript
import type { StartData, SessionsPageData, StatusData } from './bot-commands.js';
import type { LivePreviewRenderer } from './bot-telegram-live-preview.js';

export function renderStart(d: StartData): string { /* platform markup */ }
export function renderStatus(d: StatusData): string { /* platform markup */ }

export const xxxPreviewRenderer: LivePreviewRenderer = {
  renderInitial(agent) { return `... ${agent} ...`; },
  renderStream(input) { return `... ${input.bodyText} ...`; },
};
```

### 3. `bot-{name}.ts` — Thin Glue Layer
```typescript
import { Bot } from './bot.js';
import { getStartData, getStatusDataAsync, ... } from './bot-commands.js';
import { handleIncomingMessage } from './bot-handler.js';
import { LivePreview } from './bot-telegram-live-preview.js';

export class XxxBot extends Bot {
  // Commands: call bot-commands.ts for data, pass to renderer
  // Messages: implement MessagePipeline, call handleIncomingMessage()
  // Lifecycle: connect channel, register hooks, listen
}
```

### 4. `cli.ts` — Register dispatch
```typescript
case 'xxx':
  const { XxxBot } = await import('./bot-xxx.js');
  await new XxxBot().run();
  break;
```

See [INTEGRATION.md](INTEGRATION.md) for detailed examples.

## Key Types

- `ChatId = number | string` — Telegram uses number, Feishu/Discord use string
- `Agent = 'claude' | 'codex'` — AI backend
- `SessionRuntime` — Live session state (key, workdir, agent, sessionId, runningTaskIds)
- `StreamResult` — Agent response (message, thinking, tokens, artifacts, sessionId)
- `MessagePipeline<TCtx>` — Per-platform message handling hooks

## Testing Rules

- **Unit tests** (`test/*.unit.test.ts`): Can use mocks. Run with `npx vitest run`.
- **E2E tests** (`test/e2e/*.e2e.test.ts`): Must NOT use mocks. Hit real CLIs with real API calls. Use `describe.skipIf(!HAS_CLAUDE)` / `describe.skipIf(!HAS_CODEX)`.
- Framework: Vitest.

## Common Commands

```bash
npm run build          # TypeScript compile
npm test               # Run unit tests
npx vitest run <file>  # Run specific test
npx codeclaw --doctor  # Check setup
npx codeclaw --setup   # Interactive setup wizard
```

## Environment Variables

**Channel-agnostic:** `DEFAULT_AGENT`, `CODECLAW_WORKDIR`, `CODECLAW_TIMEOUT`, `CODECLAW_ALLOWED_IDS`
**Telegram:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`
**Claude agent:** `CLAUDE_MODEL`, `CLAUDE_PERMISSION_MODE`, `CLAUDE_EXTRA_ARGS`
**Codex agent:** `CODEX_MODEL`, `CODEX_REASONING_EFFORT`, `CODEX_FULL_ACCESS`, `CODEX_EXTRA_ARGS`
