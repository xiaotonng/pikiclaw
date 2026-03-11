# Integrating a New IM Platform

This guide explains how to add a new IM platform (e.g., Feishu/Lark, Discord, WhatsApp) to codeclaw.

## Architecture Overview

```
cli.ts                          Entry point, dispatches to channel-specific bot
  │
  ├── bot-commands.ts           Shared command data layer (getStartData, getSessionsPageData, ...)
  ├── bot-handler.ts            Generic message handling pipeline (MessagePipeline interface)
  ├── bot.ts (Bot)              Base class: config, state, sessions, streaming, keep-alive
  ├── code-agent.ts             AI agent abstraction (Claude/Codex CLI)
  │
  ├── bot-telegram.ts           Telegram: orchestration (thin glue)
  ├── bot-telegram-render.ts    Telegram: HTML rendering
  ├── channel-telegram.ts       Telegram: Bot API transport
  │
  ├── bot-feishu.ts             Feishu: (you create this)
  ├── bot-feishu-render.ts      Feishu: (you create this)
  └── channel-feishu.ts         Feishu: (you create this)
```

## What You Need to Implement

### 1. Channel Transport — `channel-feishu.ts`

Extend the `Channel` base class from `channel-base.ts`:

```typescript
import { Channel, type BotInfo, type SendOpts } from './channel-base.js';

export class FeishuChannel extends Channel {
  override readonly capabilities = {
    editMessages: true,       // Feishu supports card updates
    typingIndicators: false,  // No typing indicators
    commandMenu: false,       // No native command menu
    callbackActions: true,    // Card button callbacks
    messageReactions: true,
    fileUpload: true,
    fileDownload: true,
    threads: false,
  };

  async connect(): Promise<BotInfo> { /* Get tenant access token, return bot info */ }
  async listen(): Promise<void>     { /* WebSocket or webhook event loop */ }
  disconnect(): void                { /* Cleanup */ }

  async send(chatId, text, opts?): Promise<string | null>    { /* Send message */ }
  async editMessage(chatId, msgId, text, opts?): Promise<void> { /* Update card */ }
  async deleteMessage(chatId, msgId): Promise<void>            { /* Delete message */ }
  async sendTyping(chatId): Promise<void>                      { /* No-op for Feishu */ }

  // Feishu-specific hooks
  onMessage(handler) { /* ... */ }
  onCommand(handler) { /* ... */ }
  onCallback(handler) { /* ... */ }
}
```

### 2. Renderer — `bot-feishu-render.ts`

Convert structured data from `bot-commands.ts` into Feishu-specific format (Markdown, interactive cards, etc.):

```typescript
import type { StartData, SessionsPageData, AgentsListData, StatusData } from './bot-commands.js';
import type { LivePreviewRenderer } from './bot-telegram-live-preview.js';
import type { StreamPreviewRenderInput } from './bot-telegram-render.js';

// Render /start command
export function renderStart(d: StartData): string {
  return [
    `**${d.title}** v${d.version}`,
    d.subtitle,
    '',
    `**Agent:** ${d.agent}`,
    `**Workdir:** \`${d.workdir}\``,
  ].join('\n');
}

// Render /sessions list as Feishu interactive card
export function renderSessionsPage(d: SessionsPageData): FeishuCard { /* ... */ }

// Render /status
export function renderStatus(d: StatusData): string { /* ... */ }

// LivePreview renderer (Markdown for Feishu)
export const feishuPreviewRenderer: LivePreviewRenderer = {
  renderInitial(agent) { return `● ${agent} · 0s`; },
  renderStream(input) {
    // Build Markdown preview from input.bodyText, input.thinking, etc.
    return `${input.bodyText}\n\n● ${input.agent} · ${Math.round(input.elapsedMs / 1000)}s`;
  },
};
```

### 3. Bot Glue — `bot-feishu.ts`

The thin orchestration layer. Use the shared data layer and generic pipeline:

```typescript
import { Bot, type Agent, type SessionRuntime } from './bot.js';
import {
  getStartData, getSessionsPageData, getAgentsListData,
  getModelsListData, getStatusDataAsync, getHostDataSync,
  resolveSkillPrompt, modelMatchesSelection,
} from './bot-commands.js';
import { handleIncomingMessage, type MessagePipeline } from './bot-handler.js';
import { LivePreview } from './bot-telegram-live-preview.js';
import { feishuPreviewRenderer, renderStart, renderStatus } from './bot-feishu-render.js';
import { FeishuChannel } from './channel-feishu.js';

export class FeishuBot extends Bot {
  private channel!: FeishuChannel;

  // --- Commands use shared data layer + Feishu renderer ---

  private async cmdStart(ctx: FeishuContext) {
    const data = getStartData(this, ctx.chatId);
    await ctx.reply(renderStart(data));
  }

  private async cmdStatus(ctx: FeishuContext) {
    const data = await getStatusDataAsync(this, ctx.chatId);
    await ctx.reply(renderStatus(data));
  }

  // --- Messages use the generic pipeline ---

  private async handleMessage(text: string, files: string[], ctx: FeishuContext) {
    await handleIncomingMessage({
      bot: this,
      pipeline: this.createPipeline(),
      ctx,
      text,
      files,
      createTaskId: (session) => `${session.key}:${Date.now().toString(36)}`,
      beginTask: (task) => this.beginTask(task as any),
      finishTask: (taskId) => this.finishTask(taskId),
      queueSessionTask: (session, task) => this.queueSessionTask(session, task),
      syncSelectedChats: (session) => this.syncSelectedChats(session),
      log: (msg) => this.log(msg),
    });
  }

  private createPipeline(): MessagePipeline<FeishuContext> {
    return {
      getChatId: (ctx) => ctx.chatId,
      getMessageId: (ctx) => ctx.messageId,
      resolveSession: (ctx, text, files) => this.resolveIncomingSession(ctx, text, files),
      createPlaceholder: async (ctx, session) => {
        const msgId = await this.channel.send(ctx.chatId, feishuPreviewRenderer.renderInitial(session.agent));
        return msgId ? { messageId: msgId } : null;
      },
      createLivePreview: (ctx, handle, session) => {
        return new LivePreview({
          agent: session.agent,
          chatId: ctx.chatId,
          placeholderMessageId: handle.messageId,
          channel: this.channel,
          renderer: feishuPreviewRenderer,
          streamEditIntervalMs: 800,
          startTimeMs: Date.now(),
          canEditMessages: true,
          canSendTyping: false,
          parseMode: 'Markdown',
          log: (msg) => this.log(msg),
        });
      },
      sendFinalReply: async (ctx, placeholder, session, result) => { /* ... */ },
      sendArtifacts: async (ctx, placeholder, artifacts) => { /* ... */ },
      onError: async (ctx, placeholder, session, error) => { /* ... */ },
    };
  }

  async run() {
    this.channel = new FeishuChannel({ appId: '...', appSecret: '...' });
    await this.channel.connect();
    this.channel.onCommand((cmd, args, ctx) => this.handleCommand(cmd, args, ctx));
    this.channel.onMessage((msg, ctx) => this.handleMessage(msg.text, msg.files, ctx));
    this.startKeepAlive();
    await this.channel.listen();
  }
}
```

### 4. CLI Registration — `cli.ts`

Add the dispatch case:

```typescript
case 'feishu':
  const { FeishuBot } = await import('./bot-feishu.js');
  await new FeishuBot().run();
  break;
```

## Shared Components Reference

### `bot-commands.ts` — Data Layer

| Function | Returns | Used for |
|----------|---------|----------|
| `getStartData(bot, chatId)` | `StartData` | /start command |
| `getSessionsPageData(bot, chatId, page)` | `SessionsPageData` | /sessions list |
| `getAgentsListData(bot, chatId)` | `AgentsListData` | /agents list |
| `getModelsListData(bot, chatId)` | `ModelsListData` | /models list |
| `getStatusDataAsync(bot, chatId)` | `StatusData` | /status command |
| `getHostDataSync(bot)` | `HostData` | /host command |
| `resolveSkillPrompt(bot, chatId, cmd, args)` | `{ prompt, skillName }` | Skill routing |
| `modelMatchesSelection(agent, sel, cur)` | `boolean` | Model comparison |

### `bot-handler.ts` — Message Pipeline

Implement `MessagePipeline<TCtx>` and call `handleIncomingMessage()` for the full message lifecycle.

### `bot-telegram-live-preview.ts` — LivePreview

The `LivePreview` class is channel-agnostic. Inject a `LivePreviewRenderer`:

```typescript
interface LivePreviewRenderer {
  renderInitial(agent: Agent): string;
  renderStream(input: StreamPreviewRenderInput): string;
}
```

### `bot.ts` — Base Class

`Bot` provides: config, `chat(chatId)`, `runStream()`, session management, keep-alive, `switchWorkdir()`.

`ChatId` is `number | string` — works for all platforms.

## Checklist for New IM Integration

- [ ] `channel-xxx.ts` — Transport layer extending `Channel`
- [ ] `bot-xxx-render.ts` — Platform-specific rendering consuming data from `bot-commands.ts`
- [ ] `bot-xxx.ts` — Thin glue layer extending `Bot`, wiring commands + pipeline
- [ ] `cli.ts` — Add `case 'xxx':` dispatch
- [ ] `user-config.ts` — Add channel-specific config fields if needed
- [ ] `onboarding.ts` — Add setup checks for the new channel
- [ ] Tests — Unit tests for render + channel, integration test for bot
