# Integrating a New IM Channel

This guide reflects the current `pikiclaw` source layout, where Telegram, Feishu, and WeChat already share the same `bot/` runtime and only differ in `channels/<name>/`.

## What Already Exists

You do not need to reimplement:

- session state and lifecycle
- agent dispatch and stream orchestration
- live-stream preview
- command data fetching and selection UIs
- session / model / agent / skill selection logic
- MCP-backed file return and `im_ask_user` prompts
- human-in-the-loop prompt state (Codex user-input + `im_ask_user`)

Those pieces live in `bot/` and are consumed by every channel.

## The Layers You Plug Into

```text
cli/main.ts
  -> channels/<name>/bot.ts
       -> bot/commands.ts
       -> bot/command-ui.ts
       -> bot/orchestration.ts          (handleIncomingMessage pipeline)
       -> channels/telegram/live-preview.ts   (channel-agnostic; reuse it)
  -> channels/<name>/channel.ts          (transport)
```

## Files to Add

### 1. `src/channels/<name>/channel.ts`

Implement the transport by extending `Channel` from `src/channels/base.ts`.

Responsibilities:

- connect and authenticate
- receive messages / commands / callbacks
- send, edit, delete messages
- upload and download files
- expose channel capability flags

Your transport should not know about sessions, agents, or skills.

### 2. `src/channels/<name>/render.ts`

Render shared command data into platform-specific output.

Typical responsibilities:

- `/start` formatting
- `/status` formatting
- host / runtime formatting
- command selection cards or keyboards
- live preview rendering
- final reply rendering

You can use:

- `bot/commands.ts` for structured command data
- `bot/command-ui.ts` for shared session / agent / model / skill views
- `bot/render-shared.ts` for shared rendering primitives
- `channels/telegram/live-preview.ts` for throttled preview updates (despite the path, `LivePreview` is channel-agnostic)

### 3. `src/channels/<name>/bot.ts`

Create the thin orchestration layer.

Typical responsibilities:

- wire channel handlers
- route slash commands
- call `handleIncomingMessage()` (from `bot/orchestration.ts`) for free-text messages
- bind channel-specific file-send callbacks for the MCP bridge
- create the platform renderer + preview controller

### 4. `src/cli/main.ts` and `src/cli/channels.ts`

Register the new channel in the channel launcher and add it to the resolution helpers.

## Shared Modules You Should Reuse

### `src/bot/commands.ts`

Structured command data, no rendering.

Key functions:

- `getStartData()`
- `getStatusDataAsync()`
- `getHostDataSync()`
- `getSessionsPageData()`
- `getModelsListData()`
- `getSkillsListData()`
- `resolveSkillPrompt()`

### `src/bot/command-ui.ts`

Shared selection UI when the channel needs session / agent / model / skill pickers.

Key helpers:

- `buildSessionsCommandView()`
- `buildAgentsCommandView()`
- `buildModelsCommandView()`
- `buildSkillsCommandView()`
- `decodeCommandAction()`
- `executeCommandAction()`

This prevents each IM integration from inventing its own selection logic.

### `src/bot/orchestration.ts`

The standard message pipeline:

1. resolve session
2. create placeholder
3. create live preview
4. stream agent output
5. send final reply
6. deliver artifacts / MCP file sends

Your channel implementation supplies hooks for those steps via a `MessagePipeline<Ctx>` object.

### `src/bot/human-loop.ts`

Single state machine for both Codex `user-input` requests and `im_ask_user` MCP calls. Channels render the question via `currentHumanLoopQuestion()` and submit answers via `humanLoopOptionSelected()` / freeform reply paths.

### `src/channels/telegram/live-preview.ts`

Despite the filename, `LivePreview` is channel-agnostic. Each channel provides:

- `renderInitial(agent)`
- `renderStream(input)`

and the controller handles edit throttling and heartbeat timing.

## Minimal Bot Skeleton

```ts
import { Bot } from '../../bot/bot.js';
import { handleIncomingMessage, type MessagePipeline } from '../../bot/orchestration.js';
import { LivePreview } from '../telegram/live-preview.js';
import { getStartData, getStatusDataAsync } from '../../bot/commands.js';
import { XxxChannel } from './channel.js';
import { renderStart, renderStatus, xxxPreviewRenderer } from './render.js';

export class XxxBot extends Bot {
  private channel!: XxxChannel;

  private async cmdStart(ctx: XxxContext) {
    const data = getStartData(this, ctx.chatId);
    await ctx.reply(renderStart(data));
  }

  private async cmdStatus(ctx: XxxContext) {
    const data = await getStatusDataAsync(this, ctx.chatId);
    await ctx.reply(renderStatus(data));
  }

  private createPipeline(): MessagePipeline<XxxContext> {
    return {
      getChatId: ctx => ctx.chatId,
      getMessageId: ctx => ctx.messageId,
      resolveSession: (ctx, text, files) => this.resolveIncomingSession(ctx, text, files),
      createPlaceholder: async (ctx, session) => {
        const messageId = await this.channel.send(ctx.chatId, xxxPreviewRenderer.renderInitial(session.agent));
        return messageId ? { messageId } : null;
      },
      createLivePreview: (ctx, placeholder, session) => new LivePreview({
        agent: session.agent,
        chatId: ctx.chatId,
        placeholderMessageId: placeholder.messageId,
        channel: this.channel,
        renderer: xxxPreviewRenderer,
        startTimeMs: Date.now(),
        canEditMessages: true,
        canSendTyping: false,
        parseMode: 'Markdown',
        log: msg => this.log(msg),
      }),
      createMcpSendFile: (ctx) => this.createMcpSendFileCallback(ctx),
      sendFinalReply: async (ctx, placeholder, session, result) => {
        // platform-specific final formatting
      },
      sendArtifacts: async (ctx, placeholder, artifacts) => {
        // optional
      },
      onError: async (ctx, placeholder, session, error) => {
        // platform-specific error reply
      },
    };
  }
}
```

## Channel Checklist

- `src/channels/<name>/channel.ts` implements `Channel`
- `src/channels/<name>/render.ts` renders command and stream output
- `src/channels/<name>/bot.ts` uses the shared pipeline from `bot/orchestration.ts`
- `src/cli/main.ts` launches the new bot; `src/cli/channels.ts` resolves it from config
- `src/core/config/user-config.ts` stores any new credentials
- `src/core/config/validation.ts` validates those credentials if needed
- `src/cli/onboarding.ts` and `src/dashboard/runtime.ts` / `src/dashboard/routes/config.ts` expose setup state if needed
- Unit tests cover transport and rendering

## Capability Questions To Answer Early

Before you implement a new channel, decide:

- Can messages be edited after send?
- Are callback buttons supported?
- Is file upload available?
- Is file download available?
- Are threads supported?
- Is there a native command menu?
- Is there a typing indicator?

These answers drive the `ChannelCapabilities` flags and influence how previews and command UIs should behave.

## Good Reference Implementations

- **Telegram** — simplest, plain-text-friendly:
  - `src/channels/telegram/channel.ts`
  - `src/channels/telegram/bot.ts`
  - `src/channels/telegram/render.ts`
  - `src/channels/telegram/live-preview.ts`

- **Feishu** — best reference if your target platform prefers cards over plain text:
  - `src/channels/feishu/channel.ts`
  - `src/channels/feishu/bot.ts`
  - `src/channels/feishu/render.ts`
  - `src/channels/feishu/markdown.ts`

- **WeChat** — best reference for an event-driven / webhook-style API:
  - `src/channels/weixin/channel.ts`
  - `src/channels/weixin/bot.ts`
  - `src/channels/weixin/api.ts`
