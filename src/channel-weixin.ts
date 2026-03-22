import {
  Channel,
  DEFAULT_CHANNEL_CAPABILITIES,
  type BotInfo,
  type SendOpts,
  splitText,
  sleep,
} from './channel-base.js';
import { WEIXIN_LIMITS } from './constants.js';
import {
  extractWeixinTextBody,
  markdownToWeixinPlainText,
  normalizeWeixinBaseUrl,
  WeixinMessageType,
  type WeixinMessage,
  weixinGetConfig,
  weixinGetUpdates,
  weixinSendTextMessage,
  weixinSendTyping,
} from './weixin-api.js';

export interface WeixinOpts {
  token: string;
  accountId: string;
  baseUrl?: string;
  pollTimeout?: number;
  allowedChatIds?: Set<string>;
}

export interface WeixinMessagePayload {
  text: string;
  files: string[];
}

export interface WeixinFrom {
  userId: string;
}

export interface WeixinContext {
  chatId: string;
  messageId: string;
  from: WeixinFrom;
  reply: (text: string, opts?: SendOpts) => Promise<string | null>;
  editReply: (msgId: string, text: string, opts?: SendOpts) => Promise<void>;
  sendTyping: () => Promise<void>;
  channel: WeixinChannel;
  raw: WeixinMessage;
}

export type WeixinMessageHandler = (msg: WeixinMessagePayload, ctx: WeixinContext) => Promise<any> | any;
export type WeixinErrorHandler = (err: Error) => void;

interface WeixinChatMeta {
  userId: string;
  contextToken: string;
  typingTicket?: string;
}

const WEIXIN_MAX_MESSAGE_LENGTH = WEIXIN_LIMITS.maxMessageLength;
const WEIXIN_MAX_RETRY_DELAY_MS = WEIXIN_LIMITS.maxRetryDelay;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class WeixinChannel extends Channel {
  readonly capabilities = {
    ...DEFAULT_CHANNEL_CAPABILITIES,
    typingIndicators: true,
  };

  readonly knownChats = new Set<string>();

  private readonly token: string;
  private readonly accountId: string;
  private readonly baseUrl: string;
  private readonly pollTimeout: number;
  private readonly allowedChatIds?: Set<string>;
  private readonly messageHandlers = new Set<WeixinMessageHandler>();
  private readonly errorHandlers = new Set<WeixinErrorHandler>();
  private readonly chatMeta = new Map<string, WeixinChatMeta>();
  private stopping = false;
  private updateBuf = '';

  constructor(opts: WeixinOpts) {
    super();
    this.token = opts.token;
    this.accountId = opts.accountId;
    this.baseUrl = normalizeWeixinBaseUrl(opts.baseUrl);
    this.pollTimeout = opts.pollTimeout ?? WEIXIN_LIMITS.longPollTimeout;
    this.allowedChatIds = opts.allowedChatIds;
  }

  onMessage(handler: WeixinMessageHandler) {
    this.messageHandlers.add(handler);
    return this;
  }

  onError(handler: WeixinErrorHandler) {
    this.errorHandlers.add(handler);
    return this;
  }

  async connect(): Promise<BotInfo> {
    const shortId = this.accountId.length > 18 ? `${this.accountId.slice(0, 8)}...${this.accountId.slice(-6)}` : this.accountId;
    this.bot = {
      id: this.accountId,
      username: `weixin_${shortId}`,
      displayName: `Weixin ${shortId}`,
    };
    return this.bot;
  }

  async listen(): Promise<void> {
    this.stopping = false;
    let retryDelayMs = 1_000;
    while (!this.stopping) {
      try {
        const response = await weixinGetUpdates({
          baseUrl: this.baseUrl,
          token: this.token,
          getUpdatesBuf: this.updateBuf,
          timeoutMs: this.pollTimeout,
        });
        retryDelayMs = 1_000;
        if (response.get_updates_buf !== undefined) this.updateBuf = response.get_updates_buf || '';
        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          throw new Error(`Weixin getupdates failed: ${response.errmsg || response.errcode || response.ret}`);
        }
        for (const message of response.msgs || []) {
          await this.dispatchInboundMessage(message);
        }
      } catch (error) {
        if (this.stopping || isAbortError(error)) break;
        this.emitError(new Error(`Weixin polling failed: ${describeError(error)}`));
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, WEIXIN_MAX_RETRY_DELAY_MS);
      }
    }
  }

  disconnect(): void {
    this.stopping = true;
  }

  async send(chatId: number | string, text: string, _opts?: SendOpts): Promise<string | null> {
    const meta = this.chatMeta.get(String(chatId));
    if (!meta?.contextToken) throw new Error('Weixin context token is missing for this chat.');

    const plain = markdownToWeixinPlainText(text) || String(text || '').trim();
    const chunks = splitText(plain, WEIXIN_MAX_MESSAGE_LENGTH).map(chunk => chunk.trim()).filter(Boolean);
    let lastMessageId: string | null = null;
    for (const chunk of chunks) {
      await weixinSendTextMessage({
        baseUrl: this.baseUrl,
        token: this.token,
        toUserId: meta.userId,
        text: chunk,
        contextToken: meta.contextToken,
      });
      lastMessageId = `wx:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    }
    return lastMessageId;
  }

  async editMessage(_chatId: number | string, _msgId: number | string, _text: string, _opts?: SendOpts): Promise<void> {}

  async deleteMessage(_chatId: number | string, _msgId: number | string): Promise<void> {}

  async sendTyping(chatId: number | string, _opts?: SendOpts): Promise<void> {
    const meta = this.chatMeta.get(String(chatId));
    if (!meta?.contextToken || !meta.userId) return;
    let typingTicket = meta.typingTicket;
    if (!typingTicket) {
      const config = await weixinGetConfig({
        baseUrl: this.baseUrl,
        token: this.token,
        userId: meta.userId,
        contextToken: meta.contextToken,
      });
      typingTicket = String(config.typing_ticket || '').trim();
      if (!typingTicket) return;
      meta.typingTicket = typingTicket;
      this.chatMeta.set(String(chatId), meta);
    }
    await weixinSendTyping({
      baseUrl: this.baseUrl,
      token: this.token,
      userId: meta.userId,
      typingTicket,
    });
  }

  private composeChatId(userId: string): string {
    return `${this.accountId}:${userId}`;
  }

  private isAllowed(chatId: string, userId: string): boolean {
    if (!this.allowedChatIds?.size) return true;
    return this.allowedChatIds.has(chatId) || this.allowedChatIds.has(userId);
  }

  private async dispatchInboundMessage(message: WeixinMessage): Promise<void> {
    if ((message.message_type ?? WeixinMessageType.USER) !== WeixinMessageType.USER) return;
    const userId = String(message.from_user_id || '').trim();
    if (!userId) return;
    const chatId = this.composeChatId(userId);
    if (!this.isAllowed(chatId, userId)) return;

    const existing = this.chatMeta.get(chatId);
    const contextToken = String(message.context_token || existing?.contextToken || '').trim();
    const meta: WeixinChatMeta = {
      userId,
      contextToken,
      typingTicket: existing?.contextToken === contextToken ? existing?.typingTicket : undefined,
    };
    this.chatMeta.set(chatId, meta);
    this.knownChats.add(chatId);

    const ctx: WeixinContext = {
      chatId,
      messageId: String(message.message_id || message.seq || Date.now()),
      from: { userId },
      reply: (text, opts) => this.send(chatId, text, opts),
      editReply: (msgId, text, opts) => this.editMessage(chatId, msgId, text, opts),
      sendTyping: () => this.sendTyping(chatId),
      channel: this,
      raw: message,
    };
    const payload: WeixinMessagePayload = {
      text: extractWeixinTextBody(message),
      files: [],
    };
    for (const handler of this.messageHandlers) {
      try {
        await handler(payload, ctx);
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(describeError(error)));
      }
    }
  }

  private emitError(error: Error) {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {}
    }
  }
}
