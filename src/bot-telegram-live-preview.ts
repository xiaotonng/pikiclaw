import type { Agent, ChatId, StreamPreviewMeta, StreamPreviewPlan } from './bot.js';
import { hasPreviewMeta, samePreviewMeta, samePreviewPlan } from './bot-streaming.js';
import type { StreamPreviewRenderInput } from './bot-render-shared.js';
import { STREAM_PREVIEW_TIMEOUTS } from './constants.js';

const STREAM_PREVIEW_HEARTBEAT_MS = STREAM_PREVIEW_TIMEOUTS.heartbeat;
const STREAM_TYPING_HEARTBEAT_MS = STREAM_PREVIEW_TIMEOUTS.typing;
const STREAM_STALLED_NOTICE_MS = STREAM_PREVIEW_TIMEOUTS.stalledNotice;

// ---------------------------------------------------------------------------
// Channel-agnostic interfaces
// ---------------------------------------------------------------------------

/** Minimal channel interface needed for live preview edits. */
export interface PreviewChannel {
  editMessage(chatId: ChatId, messageId: number | string, text: string, opts?: { parseMode?: string; keyboard?: any }): Promise<void>;
  sendTyping(chatId: ChatId, opts?: { messageThreadId?: number }): Promise<void>;
}

/**
 * Renderer that converts streaming state into a platform-specific string.
 * Implement this per IM: Telegram HTML, Feishu Markdown, Discord Markdown, etc.
 */
export interface LivePreviewRenderer {
  /** Render the initial placeholder text (e.g. "● codex · 0s"). */
  renderInitial(agent: Agent): string;
  /** Render the streaming preview with current state. */
  renderStream(input: StreamPreviewRenderInput): string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LivePreviewOptions {
  agent: Agent;
  chatId: ChatId;
  placeholderMessageId: number | string | null;
  channel: PreviewChannel;
  renderer: LivePreviewRenderer;
  streamEditIntervalMs: number;
  startTimeMs: number;
  canEditMessages: boolean;
  canSendTyping: boolean;
  messageThreadId?: number;
  /** Parse mode string passed to editMessage (e.g. 'HTML', 'MarkdownV2'). */
  parseMode?: string;
  keyboard?: any;
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// LivePreview — generic streaming preview controller
// ---------------------------------------------------------------------------

export class LivePreview {
  readonly initialText: string;

  private readonly agent: Agent;
  private readonly chatId: ChatId;
  private readonly placeholderMessageId: number | string | null;
  private readonly channel: PreviewChannel;
  private readonly renderer: LivePreviewRenderer;
  private readonly streamEditIntervalMs: number;
  private readonly startTimeMs: number;
  private readonly canEditMessages: boolean;
  private readonly canSendTyping: boolean;
  private readonly messageThreadId?: number;
  private readonly parseMode: string;
  private readonly keyboard: any;
  private readonly log: (message: string) => void;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private editChain: Promise<void> = Promise.resolve();
  private previewVersion = 0;
  private editCount = 0;
  private lastEditAt = 0;
  private lastProgressAt: number;
  private lastPreview: string;
  private latestText = '';
  private latestThinking = '';
  private latestActivity = '';
  private latestMeta: StreamPreviewMeta | null = null;
  private latestPlan: StreamPreviewPlan | null = null;

  constructor(options: LivePreviewOptions) {
    this.agent = options.agent;
    this.chatId = options.chatId;
    this.placeholderMessageId = options.placeholderMessageId;
    this.channel = options.channel;
    this.renderer = options.renderer;
    this.streamEditIntervalMs = options.streamEditIntervalMs;
    this.startTimeMs = options.startTimeMs;
    this.canEditMessages = options.canEditMessages;
    this.canSendTyping = options.canSendTyping;
    this.messageThreadId = options.messageThreadId;
    this.parseMode = options.parseMode ?? 'HTML';
    this.keyboard = options.keyboard;
    this.log = options.log ?? (() => {});

    this.initialText = this.renderer.renderInitial(this.agent);
    this.lastPreview = this.initialText;
    this.lastProgressAt = this.startTimeMs;
  }

  start() {
    this.sendTypingPulse();
    if (this.canEditMessages) {
      this.heartbeatTimer = setInterval(() => {
        const idleMs = Date.now() - this.lastProgressAt;
        const recentlyEdited = Date.now() - this.lastEditAt < STREAM_PREVIEW_HEARTBEAT_MS - 250;
        if (recentlyEdited && idleMs < STREAM_STALLED_NOTICE_MS) return;
        this.queuePreviewEdit(true);
      }, STREAM_PREVIEW_HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
    }
    if (this.canSendTyping) {
      this.typingTimer = setInterval(() => this.sendTypingPulse(), STREAM_TYPING_HEARTBEAT_MS);
      this.typingTimer.unref?.();
    }
  }

  update(
    text: string,
    thinking: string,
    activity = '',
    meta?: StreamPreviewMeta,
    plan?: StreamPreviewPlan | null,
  ) {
    const nextMeta: StreamPreviewMeta | null = hasPreviewMeta(meta) ? meta! : null;
    const nextPlan = plan?.steps?.length ? plan : null;
    const changed = text !== this.latestText
      || thinking !== this.latestThinking
      || activity !== this.latestActivity
      || !samePreviewMeta(nextMeta, this.latestMeta)
      || !samePreviewPlan(nextPlan, this.latestPlan);

    this.latestText = text;
    this.latestThinking = thinking;
    this.latestActivity = activity;
    this.latestMeta = nextMeta;
    this.latestPlan = nextPlan;

    if (changed) this.lastProgressAt = Date.now();
    if (!text.trim() && !thinking.trim() && !activity.trim() && !nextMeta && !nextPlan) return;
    this.schedulePreviewEdit();
  }

  async settle() {
    this.stopFeedback();
    await this.flushPreviewEdits();
  }

  dispose() {
    this.stopFeedback();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.previewVersion++;
  }

  getEditCount(): number {
    return this.editCount;
  }

  private stopFeedback() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  private sendTypingPulse() {
    if (!this.canSendTyping) return;
    void this.channel.sendTyping(this.chatId, { messageThreadId: this.messageThreadId }).catch(() => {});
  }

  private renderPreview(): string {
    return this.renderer.renderStream({
      agent: this.agent,
      elapsedMs: Date.now() - this.startTimeMs,
      bodyText: this.latestText,
      thinking: this.latestThinking,
      activity: this.latestActivity,
      meta: this.latestMeta,
      plan: this.latestPlan,
    });
  }

  private schedulePreviewEdit() {
    if (!this.canEditMessages) return;
    const wait = this.streamEditIntervalMs - (Date.now() - this.lastEditAt);
    if (wait <= 0) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.queuePreviewEdit();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.queuePreviewEdit();
    }, wait);
  }

  private queuePreviewEdit(force = false) {
    if (!this.canEditMessages || this.placeholderMessageId == null) return;
    const placeholderMessageId = this.placeholderMessageId;
    const preview = this.renderPreview();
    if (!preview) return;
    if (!force && preview === this.lastPreview) return;
    this.lastPreview = preview;
    const version = ++this.previewVersion;
    this.editCount++;
    this.lastEditAt = Date.now();
    this.editChain = this.editChain
      .catch(() => {})
      .then(async () => {
        if (version !== this.previewVersion) return;
        try {
          await this.channel.editMessage(this.chatId, placeholderMessageId, preview, { parseMode: this.parseMode, keyboard: this.keyboard });
        } catch (error: any) {
          this.log(`stream edit err: ${error?.message || error}`);
        }
      });
  }

  private async flushPreviewEdits() {
    if (!this.canEditMessages) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.editCount > 0 || this.latestText.trim() || this.latestThinking.trim() || this.latestActivity.trim()) {
      this.queuePreviewEdit(true);
    }
    await this.editChain.catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Backward compat alias — existing code imports TelegramLivePreview
// ---------------------------------------------------------------------------

/** @deprecated Use `LivePreview` directly. */
export const TelegramLivePreview = LivePreview;
/** @deprecated Use `LivePreviewOptions` directly. */
export type TelegramLivePreviewOptions = LivePreviewOptions;
