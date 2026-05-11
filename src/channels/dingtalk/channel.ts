/**
 * DingTalk channel transport — Stream Mode (no public IP needed).
 *
 * Uses dingtalk-stream@2.x SDK. Auth: clientId (AppKey) + clientSecret
 * (AppSecret) of a self-built robot/app subscribed to the bot message topic.
 *
 * Receive: DWClient subscribes to TOPIC_ROBOT and yields RobotTextMessage
 * payloads via registerCallbackListener.
 *
 * Send: each inbound message carries a `sessionWebhook` URL valid for ~2 hours,
 * which we POST to for replies. We cache the latest sessionWebhook per chat
 * so a long-running task that produces a result message can still reach the
 * user even after the original webhook would have expired (mid-conversation
 * activity refreshes it). DingTalk plain-text messages cannot be edited.
 */

import { DWClient, TOPIC_ROBOT, type DWClientDownStream, EventAck, type RobotTextMessage } from 'dingtalk-stream';
import {
  Channel,
  type BotInfo,
  DEFAULT_CHANNEL_CAPABILITIES,
  type SendOpts,
  splitText,
  sleep,
} from '../base.js';
import { DINGTALK_LIMITS } from '../../core/constants.js';
import { ChannelHealth } from '../health.js';
import { writeScopedLog, type LogLevel } from '../../core/logging.js';

export interface DingtalkOpts {
  clientId: string;
  clientSecret: string;
  workdir?: string;
  /** Optional chat-id allowlist (DingTalk conversationId). */
  allowedChatIds?: Set<string>;
}

export interface DingtalkMessagePayload {
  text: string;
  files: string[];
}

export interface DingtalkFrom {
  userId: string;
  displayName?: string;
}

export interface DingtalkContext {
  chatId: string;          // conversationId
  messageId: string;        // msgId
  conversationType: string; // 1 = single, 2 = group
  from: DingtalkFrom;
  reply: (text: string, opts?: SendOpts) => Promise<string | null>;
  editReply: (msgId: string, text: string, opts?: SendOpts) => Promise<void>;
  channel: DingtalkChannel;
  raw: RobotTextMessage;
}

export type DingtalkMessageHandler = (msg: DingtalkMessagePayload, ctx: DingtalkContext) => Promise<any> | any;
export type DingtalkErrorHandler = (err: Error) => void;

const DT_MAX = DINGTALK_LIMITS.maxMessageLength;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'unknown error');
}

function previewText(value: string, max = 200): string {
  const t = value.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t || '(empty)';
}

interface ChatMeta {
  /** sessionWebhook last seen for this conversation. */
  sessionWebhook: string;
  /** sessionWebhook expiry timestamp (ms). */
  sessionWebhookExpiredAt: number;
}

export class DingtalkChannel extends Channel {
  override readonly capabilities = {
    ...DEFAULT_CHANNEL_CAPABILITIES,
    // DingTalk Stream Mode plain-text messages cannot be edited; AI Cards
    // can be updated but are out of scope for this minimal channel.
  };

  readonly knownChats = new Set<string>();

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly allowedChatIds?: Set<string>;

  private dwClient: DWClient | null = null;
  private running = false;
  private listenResolve: (() => void) | null = null;

  private readonly chatMeta = new Map<string, ChatMeta>();
  private readonly messageHandlers = new Set<DingtalkMessageHandler>();
  private readonly errorHandlers = new Set<DingtalkErrorHandler>();

  /** Dedup: stream may redeliver after timeouts. */
  private readonly seenMsgIds = new Set<string>();
  private readonly seenMsgIdQueue: string[] = [];
  private static readonly SEEN_CAP = 256;

  constructor(opts: DingtalkOpts) {
    super();
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.allowedChatIds = opts.allowedChatIds;
  }

  onMessage(handler: DingtalkMessageHandler) { this.messageHandlers.add(handler); return this; }
  onError(handler: DingtalkErrorHandler) { this.errorHandlers.add(handler); return this; }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async connect(): Promise<BotInfo> {
    this.dwClient = new DWClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      keepAlive: true,
    });

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.dwClient.getAccessToken();
        const shortId = this.clientId.length > 12
          ? `${this.clientId.slice(0, 6)}...${this.clientId.slice(-4)}`
          : this.clientId;
        this.bot = {
          id: this.clientId,
          username: `dingtalk_${shortId}`,
          displayName: `DingTalk ${shortId}`,
        };
        return this.bot;
      } catch (err) {
        lastErr = err;
        if (attempt >= 5) break;
        await sleep(Math.min(1000 * attempt, 5_000));
      }
    }
    throw new Error(`DingTalk connect failed: ${describeError(lastErr)}`);
  }

  async listen(): Promise<void> {
    if (!this.dwClient) throw new Error('DingTalk channel not connected');
    this.running = true;

    this.dwClient.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
      void this.dispatchRobotMessage(msg).catch(error => {
        this.emitError(error instanceof Error ? error : new Error(describeError(error)));
      });
    });

    const health = new ChannelHealth({
      label: 'DingTalk',
      opAction: 'WS connect',
      initialDelayMs: DINGTALK_LIMITS.initialRetryDelay,
      maxDelayMs: DINGTALK_LIMITS.maxRetryDelay,
      sustainedFailureHint: 'verify dingtalkClientId / dingtalkClientSecret in setting.json',
      log: (msg, level) => this.log(msg, level),
    });
    while (this.running) {
      try {
        await this.dwClient.connect();
        health.recordSuccess();
        break;
      } catch (err) {
        if (!this.running) return;
        await sleep(health.recordFailure(err));
      }
    }

    if (!this.running) return;
    await new Promise<void>(resolve => {
      this.listenResolve = resolve;
      if (!this.running) resolve();
    });
  }

  disconnect(): void {
    this.running = false;
    try { this.dwClient?.disconnect(); } catch {}
    this.dwClient = null;
    this.listenResolve?.();
    this.listenResolve = null;
  }

  // ========================================================================
  // Outgoing primitives
  // ========================================================================

  async send(chatId: number | string, text: string, _opts: SendOpts = {}): Promise<string | null> {
    const chat = String(chatId);
    const meta = this.chatMeta.get(chat);
    if (!meta?.sessionWebhook) {
      throw new Error(`DingTalk has no active sessionWebhook for chat ${chat}; user must send a message first.`);
    }
    if (meta.sessionWebhookExpiredAt && Date.now() > meta.sessionWebhookExpiredAt) {
      this.debug(`[send] sessionWebhook for ${chat} likely expired — attempting anyway`);
    }

    const trimmed = (text || '').trim() || '(empty)';
    const chunks = splitText(trimmed, DT_MAX);
    let lastId: string | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      this.debug(`[send] chat=${chat} chunk=${i + 1}/${chunks.length} chars=${chunk.length} preview=${previewText(chunk)}`);
      const resp = await fetch(meta.sessionWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: chunk } }),
      });
      const body = await resp.text();
      if (!resp.ok) {
        throw new Error(`DingTalk reply failed: HTTP ${resp.status} ${resp.statusText || ''}; body=${previewText(body)}`);
      }
      try {
        const data = JSON.parse(body);
        if (typeof data?.errcode === 'number' && data.errcode !== 0) {
          throw new Error(`DingTalk reply errcode=${data.errcode} errmsg=${data.errmsg || 'unknown'}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('DingTalk reply errcode=')) throw err;
        // Non-JSON body or no errcode is treated as success.
      }
      lastId = `dt:${Date.now().toString(36)}:${i}`;
    }
    return lastId;
  }

  async editMessage(_chatId: number | string, _msgId: number | string, _text: string, _opts?: SendOpts): Promise<void> {
    // Plain-text messages on DingTalk are not editable. AI Cards have an
    // update API but require pre-registering a card template — out of scope
    // for this transport. Callers that fall back here just no-op.
  }

  async deleteMessage(_chatId: number | string, _msgId: number | string): Promise<void> {
    // No public delete API for bot-sent messages.
  }

  async sendTyping(_chatId: number | string, _opts?: SendOpts): Promise<void> {
    // No typing indicator API.
  }

  // ========================================================================
  // Internal dispatch
  // ========================================================================

  private async dispatchRobotMessage(msg: DWClientDownStream): Promise<void> {
    try {
      this.dwClient?.socketCallBackResponse(msg.headers.messageId, { status: EventAck.SUCCESS });
    } catch {}

    let parsed: RobotTextMessage;
    try {
      parsed = JSON.parse(msg.data) as RobotTextMessage;
    } catch (err) {
      this.emitError(new Error(`DingTalk message parse failed: ${describeError(err)}`));
      return;
    }
    if (!parsed) return;

    const chatId = String(parsed.conversationId || '').trim();
    const messageId = String(parsed.msgId || '').trim();
    const senderId = String(parsed.senderStaffId || parsed.senderId || '').trim();
    if (!chatId || !messageId || !senderId) return;

    if (this.seenMsgIds.has(messageId)) return;
    this.seenMsgIds.add(messageId);
    this.seenMsgIdQueue.push(messageId);
    while (this.seenMsgIdQueue.length > DingtalkChannel.SEEN_CAP) {
      this.seenMsgIds.delete(this.seenMsgIdQueue.shift()!);
    }

    if (!this.isAllowed(chatId)) return;
    this.knownChats.add(chatId);

    if (parsed.sessionWebhook) {
      this.chatMeta.set(chatId, {
        sessionWebhook: parsed.sessionWebhook,
        sessionWebhookExpiredAt: Number(parsed.sessionWebhookExpiredTime) || Date.now() + 60 * 60_000,
      });
    }

    let text = '';
    if (parsed.msgtype === 'text' && parsed.text?.content) text = String(parsed.text.content || '').trim();
    else this.debug(`[recv] non-text msgtype=${parsed.msgtype} chat=${chatId} msg=${messageId}`);

    const ctx: DingtalkContext = {
      chatId,
      messageId,
      conversationType: String(parsed.conversationType || ''),
      from: { userId: senderId, displayName: parsed.senderNick },
      reply: (replyText, opts) => this.send(chatId, replyText, opts),
      editReply: () => Promise.resolve(),
      channel: this,
      raw: parsed,
    };

    const payload: DingtalkMessagePayload = { text, files: [] };
    for (const handler of this.messageHandlers) {
      try { await handler(payload, ctx); } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(describeError(error)));
      }
    }
  }

  private isAllowed(chatId: string): boolean {
    if (!this.allowedChatIds?.size) return true;
    return this.allowedChatIds.has(chatId);
  }

  private emitError(error: Error) {
    for (const handler of this.errorHandlers) {
      try { handler(error); } catch {}
    }
  }

  private debug(msg: string) { this.log(msg, 'debug'); }
  private log(msg: string, level: LogLevel = 'info') { writeScopedLog('dingtalk', msg, { level }); }
}
