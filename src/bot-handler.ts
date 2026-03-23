/**
 * bot-handler.ts — channel-agnostic message handling pipeline.
 *
 * Defines the `MessagePipeline` interface that each IM implements to plug in
 * its own placeholder, live preview, final reply, and MCP file-send logic.
 *
 * The generic `handleIncomingMessage()` orchestrates the shared flow:
 *   resolve session → create placeholder → start live preview → run stream →
 *   settle preview → send final reply → cleanup
 *
 * File return is handled in real-time by the MCP bridge during the stream,
 * not as a post-stream batch.
 */

import type { Bot, ChatId, Agent, SessionRuntime, StreamResult, StreamPreviewMeta, StreamPreviewPlan } from './bot.js';
import { buildPrompt } from './bot.js';
import { stageSessionFiles } from './code-agent.js';
import type { McpSendFileCallback } from './mcp-bridge.js';

// ---------------------------------------------------------------------------
// Pipeline interface — implement per IM
// ---------------------------------------------------------------------------

/** Opaque handle returned by createPlaceholder, passed to createLivePreview. */
export interface PlaceholderHandle {
  /** Platform message ID (number for Telegram, string for Feishu/Discord). */
  messageId: number | string;
}

/** Minimal live preview controller. */
export interface LivePreviewController {
  start(): void;
  update(text: string, thinking: string, activity?: string, meta?: StreamPreviewMeta, plan?: StreamPreviewPlan | null): void;
  settle(): Promise<void>;
  dispose(): void;
}

/**
 * Channel-specific operations that differ between IMs.
 * Implement this interface for Telegram, Feishu, Discord, etc.
 */
export interface MessagePipeline<TCtx> {
  /** Extract chatId from the platform context. */
  getChatId(ctx: TCtx): ChatId;

  /** Extract the raw message ID from the platform context. */
  getMessageId(ctx: TCtx): number | string;

  /** Resolve which session this message belongs to (reply-chain, active, or new). */
  resolveSession(ctx: TCtx, text: string, files: string[]): SessionRuntime;

  /** Send a placeholder message that will be edited with streaming updates. Return null to skip live preview. */
  createPlaceholder(ctx: TCtx, session: SessionRuntime): Promise<PlaceholderHandle | null>;

  /** Create a live preview controller for streaming updates. Return null to skip. */
  createLivePreview(ctx: TCtx, handle: PlaceholderHandle, session: SessionRuntime): LivePreviewController | null;

  /** Send the final reply (edit placeholder or send new message). */
  sendFinalReply(ctx: TCtx, placeholder: PlaceholderHandle | null, session: SessionRuntime, result: StreamResult): Promise<void>;

  /** Create an MCP sendFile callback bound to the current chat context. */
  createMcpSendFile(ctx: TCtx, session: SessionRuntime): McpSendFileCallback;

  /** Handle errors during message processing. */
  onError(ctx: TCtx, placeholder: PlaceholderHandle | null, session: SessionRuntime, error: Error): Promise<void>;

  /** Register message IDs as belonging to a session (for reply-chain tracking). */
  registerSessionMessages?(ctx: TCtx, messageIds: Array<number | string | null | undefined>, session: SessionRuntime): void;
}

// ---------------------------------------------------------------------------
// File-only messages (no text prompt)
// ---------------------------------------------------------------------------

export interface StageFilesResult {
  ok: boolean;
  sessionId: string;
  workspacePath: string | null;
  importedCount: number;
}

export async function stageFilesIntoSession(
  bot: Bot,
  session: SessionRuntime,
  files: string[],
): Promise<StageFilesResult> {
  const staged = stageSessionFiles({
    agent: session.agent,
    workdir: session.workdir,
    files,
    sessionId: session.sessionId,
    title: undefined,
  });
  session.workspacePath = staged.workspacePath;
  return {
    ok: staged.importedFiles.length > 0,
    sessionId: staged.sessionId,
    workspacePath: staged.workspacePath,
    importedCount: staged.importedFiles.length,
  };
}

// ---------------------------------------------------------------------------
// Generic message handler
// ---------------------------------------------------------------------------

export interface HandleMessageOpts<TCtx> {
  bot: Bot;
  pipeline: MessagePipeline<TCtx>;
  ctx: TCtx;
  text: string;
  files: string[];
  /** Optional system prompt to append. */
  systemPrompt?: string;
  /** Called when a task is created — return a task ID string. */
  createTaskId(session: SessionRuntime): string;
  /** Called to register a task as started. */
  beginTask(task: { taskId: string; chatId: ChatId; agent: Agent; sessionKey: string; prompt: string; startedAt: number; sourceMessageId: number | string }): void;
  /** Called when the task finishes. */
  finishTask(taskId: string): void;
  /** Queue a task on a session chain (serialize within same session). */
  queueSessionTask<T>(session: SessionRuntime, task: () => Promise<T>): Promise<T>;
  /** Sync updated session state to all chats sharing this session. */
  syncSelectedChats(session: SessionRuntime): void;
  /** Log a message. */
  log(msg: string): void;
}

/**
 * Generic message handling orchestration. Call this from your IM-specific bot.
 *
 * This handles the full lifecycle: session resolution → task registration →
 * placeholder → live preview → stream (with MCP bridge) → final reply → cleanup.
 */
export async function handleIncomingMessage<TCtx>(opts: HandleMessageOpts<TCtx>): Promise<void> {
  const { bot, pipeline, ctx, files, systemPrompt } = opts;
  const text = opts.text.trim();
  if (!text && !files.length) return;

  const chatId = pipeline.getChatId(ctx);
  const messageId = pipeline.getMessageId(ctx);
  const session = pipeline.resolveSession(ctx, text, files);
  const cs = bot.chat(chatId);
  // Apply session selection to chat state
  cs.activeSessionKey = session.key;
  cs.agent = session.agent;
  cs.sessionId = session.sessionId;
  cs.workspacePath = session.workspacePath;
  cs.codexCumulative = session.codexCumulative;
  cs.modelId = session.modelId ?? null;

  // File-only message: stage files without running prompt
  if (!text && files.length) {
    const hadPendingWork = bot['sessionHasPendingWork']?.(session) ?? false;
    const stageTask = opts.queueSessionTask(session, async () => {
      const result = await stageFilesIntoSession(bot, session, files);
      opts.syncSelectedChats(session);
      if (!result.ok) throw new Error('no files persisted');
      opts.log(`[handleMessage] staged files session=${result.sessionId} files=${result.importedCount}`);
    });
    if (hadPendingWork) {
      void stageTask.catch(e => opts.log(`[handleMessage] stage queue failed: ${e}`));
    } else {
      await stageTask.catch(e => opts.log(`[handleMessage] stage queue failed: ${e}`));
    }
    return;
  }

  const prompt = buildPrompt(text, files);
  const start = Date.now();
  opts.log(`[handleMessage] queued chat=${chatId} agent=${session.agent} session=${session.sessionId || '(new)'} prompt="${prompt.slice(0, 100)}" files=${files.length}`);

  const placeholder = await pipeline.createPlaceholder(ctx, session);
  const taskId = opts.createTaskId(session);
  opts.beginTask({
    taskId,
    chatId,
    agent: session.agent,
    sessionKey: session.key,
    prompt,
    startedAt: start,
    sourceMessageId: messageId,
  });

  // Create MCP sendFile callback bound to this chat context
  const mcpSendFile = pipeline.createMcpSendFile(ctx, session);

  void opts.queueSessionTask(session, async () => {
    let preview: LivePreviewController | null = null;
    try {
      if (placeholder) {
        preview = pipeline.createLivePreview(ctx, placeholder, session);
        preview?.start();
      }

      const result = await bot.runStream(prompt, session, files, (nextText, nextThinking, nextActivity = '', meta, plan) => {
        preview?.update(nextText, nextThinking, nextActivity, meta, plan);
      }, systemPrompt, mcpSendFile);
      await preview?.settle();

      opts.log(`[handleMessage] done agent=${session.agent} ok=${result.ok} elapsed=${result.elapsedS.toFixed(1)}s`);

      await pipeline.sendFinalReply(ctx, placeholder, session, result);
    } catch (e: any) {
      opts.log(`[handleMessage] task failed chat=${chatId} error=${e?.message || e}`);
      await pipeline.onError(ctx, placeholder, session, e instanceof Error ? e : new Error(String(e)));
    } finally {
      preview?.dispose();
      opts.finishTask(taskId);
      opts.syncSelectedChats(session);
    }
  }).catch(e => {
    opts.log(`[handleMessage] queue execution failed: ${e}`);
    opts.finishTask(taskId);
  });
}
