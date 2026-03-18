/**
 * Telegram channel — Telegram Bot API comms with Telegram-specific hooks.
 *
 * ┌─ Lifecycle ─────────────────────────────────────────────────────────────┐
 * │  connect()          — getMe, 获取 bot 信息 (id, username, displayName) │
 * │  listen()           — 启动 long-polling 循环，持续接收更新              │
 * │  disconnect()       — 停止 polling，中断进行中的请求                    │
 * │  drain()            — 跳过所有积压的旧更新，返回跳过数量               │
 * ├─ 发送 (bot → user) ────────────────────────────────────────────────────┤
 * │  send(chatId, text, opts?)         — 发送文本，支持 HTML/Markdown、     │
 * │                                      回复引用、inline keyboard，       │
 * │                                      超长自动分片 (4096 上限)          │
 * │  editMessage(chatId, msgId, text)  — 编辑已发送消息 (流式输出模拟)     │
 * │  deleteMessage(chatId, msgId)      — 删除消息                          │
 * │  sendPhoto(chatId, photo, opts?)   — 发送图片 (Buffer)，支持 caption   │
 * │  sendDocument(chatId, content, filename, opts?) — 发送文件              │
 * │  sendTyping(chatId)                — 发送"正在输入"状态                │
 * │  answerCallback(callbackId, text?) — 响应 inline 按钮回调              │
 * ├─ 菜单管理 ─────────────────────────────────────────────────────────────┤
 * │  setMenu(commands)  — 注册底部菜单命令 (全局 + knownChats 级别)，      │
 * │                       同时 setChatMenuButton 让菜单按钮可见            │
 * │  clearMenu()        — 删除所有命令，重置菜单按钮为默认                 │
 * ├─ 接收 (user → bot) — Hook 注册 ────────────────────────────────────────┤
 * │  onCommand(handler)  — /command args，自动解析命令名和参数；            │
 * │                        无 handler 时 fallthrough 到 onMessage          │
 * │  onMessage(handler)  — 聚合消息 { text, files[] }；                    │
 * │                        图片/文档自动下载到 workdir，提供本地路径        │
 * │  onCallback(handler) — inline keyboard 按钮点击                        │
 * │  onError(handler)    — polling / handler 错误                          │
 * ├─ Handler Context (ctx) ────────────────────────────────────────────────┤
 * │  chatId / messageId / from (id, username, firstName)                   │
 * │  reply(text, opts)            — 直接回复当前消息                       │
 * │  editReply(msgId, text, opts) — 编辑之前的消息                         │
 * │  answerCallback(text?)        — 响应 callback query (仅 callback)      │
 * │  channel                      — channel 实例，可调高级方法             │
 * │  raw                          — 原始 Telegram update 对象              │
 * ├─ 智能行为 ─────────────────────────────────────────────────────────────┤
 * │  knownChats        — 自动记录所有交互过的 chatId，setMenu 自动遍历     │
 * │  消息聚合           — photo/document 自动下载，统一为 { text, files[] } │
 * │  群组过滤           — 群聊默认只响应 @mention / 回复 bot 的消息        │
 * │  Chat 白名单        — allowedChatIds 限制只处理特定聊天                │
 * │  解析失败降级       — HTML 解析失败自动去掉 parseMode 重试             │
 * │  超长消息分片       — 超过 4096 字符按换行符自动分片发送               │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Standalone usage:
 *   const ch = new TelegramChannel({ token: 'BOT_TOKEN', workdir: '/tmp' });
 *   await ch.connect();
 *   ch.onCommand((cmd, args, ctx) => ctx.reply(`Got /${cmd} ${args}`));
 *   ch.onMessage((msg, ctx) => ctx.reply(`Echo: ${msg.text} (files: ${msg.files.length})`));
 *   await ch.listen();
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import {
  Channel,
  type BotInfo,
  DEFAULT_CHANNEL_CAPABILITIES,
  type MenuCommand,
  type SendOpts,
  splitText,
  sleep,
} from './channel-base.js';
import { TELEGRAM_LIMITS } from './constants.js';

// ---------------------------------------------------------------------------
// Proxy support — automatically respects HTTPS_PROXY / HTTP_PROXY / NO_PROXY
// ---------------------------------------------------------------------------
setGlobalDispatcher(new EnvHttpProxyAgent());

export { TelegramChannel };

// ---------------------------------------------------------------------------
// Telegram-specific types
// ---------------------------------------------------------------------------

/** Aggregated message: text + downloaded file paths. */
export interface TgMessage {
  text: string;
  files: string[];      // local file paths (auto-downloaded from photo/document)
}

/** Sender info. */
export interface TgFrom {
  id: number;
  username?: string;
  firstName?: string;
}

/** Context passed to every handler — provides reply helpers + metadata. */
export interface TgContext {
  chatId: number;
  messageId: number;
  from: TgFrom;
  /** Send a reply to this message. Returns the sent message ID. */
  reply: (text: string, opts?: SendOpts) => Promise<number | null>;
  /** Edit a previous message (e.g. the placeholder). */
  editReply: (msgId: number, text: string, opts?: SendOpts) => Promise<void>;
  /** Answer a callback query. */
  answerCallback: (text?: string) => Promise<void>;
  /** The channel instance, for advanced ops (sendDocument, api, etc.). */
  channel: TelegramChannel;
  /** Raw Telegram update for escape-hatch access. */
  raw: any;
}

/** Callback context — extends TgContext with callback-specific fields. */
export interface TgCallbackContext extends TgContext {
  callbackId: string;
}

export type CommandHandler  = (cmd: string, args: string, ctx: TgContext) => Promise<any> | any;
export type MessageHandler  = (msg: TgMessage, ctx: TgContext) => Promise<any> | any;
export type CallbackHandler = (data: string, ctx: TgCallbackContext) => Promise<any> | any;
export type ErrorHandler    = (err: Error) => void;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramOpts {
  token: string;
  /** Working directory for temp file downloads. */
  workdir?: string;
  pollTimeout?: number;
  apiTimeout?: number;
  allowedChatIds?: Set<number>;
  botUsername?: string;
  requireMentionInGroup?: boolean;
}

interface ThreadedOpts {
  messageThreadId?: number;
}

const TG_MAX = TELEGRAM_LIMITS.maxMessageLength;
const FILE_MAX_BYTES = TELEGRAM_LIMITS.fileMaxBytes;
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function previewText(value: string, max = 280): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function addErrorMetadata(parts: string[], err: any) {
  for (const key of ['code', 'errno', 'syscall', 'address', 'port', 'host', 'hostname', 'path']) {
    const value = err?.[key];
    if (value != null && value !== '') parts.push(`${key}=${value}`);
  }
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err ?? 'unknown error');

  const parts = [`${err.name}: ${err.message}`];
  addErrorMetadata(parts, err);

  if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length) {
    parts.push(`errors=[${err.errors.slice(0, 3).map(item => describeError(item)).join(' | ')}]`);
  }

  const cause = (err as any).cause;
  if (cause && cause !== err) {
    parts.push(`cause=${describeError(cause)}`);
  }

  return parts.join(' | ');
}

function isRetryableRequestError(err: unknown): boolean {
  const text = describeError(err).toLowerCase();
  return [
    'fetch failed',
    'econnreset',
    'etimedout',
    'enotfound',
    'eai_again',
    'econnrefused',
    'socket hang up',
    'http 502',
    'http 503',
    'http 504',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
  ].some(token => text.includes(token));
}

function isParseModeError(err: unknown): boolean {
  const text = describeError(err).toLowerCase();
  return text.includes("can't parse")
    || text.includes('parse entities')
    || text.includes('unsupported start tag')
    || text.includes('unsupported tag');
}

function wrapSendError(err: unknown): Error {
  return new Error(`sendMessage failed: ${describeError(err)}`, {
    cause: err instanceof Error ? err : undefined,
  });
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  const cause = (err as any)?.cause;
  if (cause && cause !== err) return isAbortError(cause);
  return false;
}

async function parseJsonResponse(resp: Response, label: string): Promise<any> {
  const raw = await resp.text();
  const bodyPreview = previewText(raw);

  let data: any = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${label} returned invalid JSON: HTTP ${resp.status} ${resp.statusText || ''}`.trim() +
        `; body=${bodyPreview}; parse=${describeError(err)}`,
      );
    }
  }

  if (!resp.ok) {
    const detail = data != null ? previewText(JSON.stringify(data)) : bodyPreview;
    throw new Error(`${label} failed: HTTP ${resp.status} ${resp.statusText || ''}`.trim() + `; body=${detail}`);
  }

  return data;
}

function mimeTypeForFilename(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.jpg':
    case '.jpeg':
    default:
      return 'image/jpeg';
  }
}

function isPollingConflictError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.startsWith('Telegram polling conflict:');
}

// ---------------------------------------------------------------------------
// TelegramChannel
// ---------------------------------------------------------------------------

class TelegramChannel extends Channel {
  override readonly capabilities = {
    ...DEFAULT_CHANNEL_CAPABILITIES,
    editMessages: true,
    typingIndicators: true,
    commandMenu: true,
    callbackActions: true,
    messageReactions: true,
    fileUpload: true,
    fileDownload: true,
    threads: true,
  };

  private token: string;
  private base: string;
  private workdir: string;
  private pollTimeout: number;
  private apiTimeout: number;
  private allowedChatIds: Set<number>;
  private requireMention: boolean;

  private offset = 0;
  private skipPendingOnNextListen = false;
  private running = false;
  private ac = new AbortController();
  private messageChains = new Map<string, Promise<void>>();

  private _hCommand: CommandHandler | null = null;
  private _hMessage: MessageHandler | null = null;
  private _hCallback: CallbackHandler | null = null;
  private _hError: ErrorHandler | null = null;

  /** Chat IDs seen from incoming updates. */
  readonly knownChats = new Set<number>();

  /** Cached menu commands for applying to newly discovered chats. */
  private _menuCommands: { command: string; description: string }[] | null = null;

  constructor(opts: TelegramOpts) {
    super();
    this.token = opts.token;
    this.base = `https://api.telegram.org/bot${opts.token}`;
    this.workdir = opts.workdir ?? process.cwd();
    this.pollTimeout = opts.pollTimeout ?? 45;
    this.apiTimeout = opts.apiTimeout ?? 60;
    this.allowedChatIds = opts.allowedChatIds ?? new Set();
    this.requireMention = opts.requireMentionInGroup ?? true;
    if (opts.botUsername) this.bot = { id: 0, username: opts.botUsername, displayName: '' };
  }

  // ---- Telegram-specific hook registration ----------------------------------

  onCommand(h: CommandHandler)   { this._hCommand = h; }
  onMessage(h: MessageHandler)   { this._hMessage = h; }
  onCallback(h: CallbackHandler) { this._hCallback = h; }
  onError(h: ErrorHandler)       { this._hError = h; }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async connect(): Promise<BotInfo> {
    let delay = 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        const data = await this.api('getMe');
        const me = data.result;
        this.bot = { id: me.id, username: me.username || '', displayName: me.first_name || '' };
        return this.bot;
      } catch (e: any) {
        if (this.ac.signal.aborted || isAbortError(e)) throw e;
        if (attempt >= 10) throw e;
        this._log(`[connect] attempt ${attempt} failed: ${e.message ?? e} — retrying in ${delay / 1000}s`);
        await sleep(delay);
        delay = Math.min(delay * 2, TELEGRAM_LIMITS.maxRetryDelay);
      }
    }
  }

  async listen(): Promise<void> {
    this.running = true;
    let backoff = 3000;
    while (this.running) {
      try {
        const requestOffset = this.skipPendingOnNextListen ? -1 : this.offset;
        const data = await this.api('getUpdates', {
          offset: requestOffset, timeout: this.pollTimeout,
          allowed_updates: ['message', 'callback_query'],
        });
        const skippedPending = this.skipPendingOnNextListen;
        if (skippedPending) this.skipPendingOnNextListen = false;
        backoff = 3000; // reset on success
        const results = data.result || [];
        if (skippedPending && !results.length) this.offset = 0;
        for (const update of results) {
          this.offset = update.update_id + 1;
          this._dispatch(update).catch(e => this._hError?.(e));
        }
      } catch (e: any) {
        if (!this.running || this.ac.signal.aborted || isAbortError(e)) break;
        if (isPollingConflictError(e)) {
          const err = e instanceof Error ? e : new Error(String(e));
          this.running = false;
          this._log(`[poll] conflict: ${err.message} — stopping`);
          this._hError?.(err);
          break;
        }
        this._log(`[poll] error: ${e.message ?? e} — retrying in ${backoff / 1000}s`);
        this._hError?.(e);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, TELEGRAM_LIMITS.maxRetryDelay);
      }
    }
  }

  disconnect() {
    this.running = false;
    this.ac.abort();
  }

  skipPendingUpdatesOnNextListen() {
    this.skipPendingOnNextListen = true;
  }

  private _logOutgoingText(action: string, meta: string, text: string) {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`[telegram ${ts}] [send] ${action} ${meta}\n${text}\n`);
  }

  private _logOutgoingPreview(action: string, meta: string, text: string) {
    this._log(`[send] ${action} ${meta} chars=${text.length}`);
  }

  private _logOutgoingFile(action: string, meta: string) {
    this._log(`[send] ${action} ${meta}`);
  }

  private _requestSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), this.ac.signal]);
  }

  private async _fetchResponse(label: string, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: this._requestSignal(timeoutMs) });
    } catch (err) {
      throw new Error(`${label} request failed after ${Math.ceil(timeoutMs / 1000)}s: ${describeError(err)}`, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  // ========================================================================
  // Outgoing primitives (Channel interface)
  // ========================================================================

  private _applyThreadId(payload: Record<string, any>, opts?: ThreadedOpts) {
    if (opts?.messageThreadId != null) payload.message_thread_id = opts.messageThreadId;
  }

  async send(chatId: number | string, text: string, opts: SendOpts = {}): Promise<number | null> {
    let msgId: number | null = null;
    const chunks = splitText(text.trim() || '(empty)', TG_MAX - 200);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const p: any = { chat_id: chatId, text: chunk, disable_web_page_preview: true };
      if (opts.parseMode) p.parse_mode = opts.parseMode;
      if (opts.replyTo != null) p.reply_to_message_id = opts.replyTo;
      if (opts.keyboard != null) p.reply_markup = opts.keyboard;
      this._applyThreadId(p, opts);
      this._logOutgoingText('sendMessage', `chat=${chatId} chunk=${index + 1}/${chunks.length}${opts.replyTo != null ? ` reply_to=${opts.replyTo}` : ''}${opts.parseMode ? ` parse=${opts.parseMode}` : ''}`, chunk);
      let res: any;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await this.api('sendMessage', p);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt >= 3 || !isRetryableRequestError(err)) break;
          const delayMs = attempt * 250;
          this._log(`[send] sendMessage transient error attempt=${attempt} chat=${chatId}: ${describeError(err)} — retrying in ${delayMs}ms`);
          await sleep(delayMs);
        }
      }
      if (lastErr) {
        if (opts.parseMode && isParseModeError(lastErr)) {
          delete p.parse_mode;
          try {
            res = await this.api('sendMessage', p);
          } catch (err) {
            throw wrapSendError(err);
          }
        } else {
          throw wrapSendError(lastErr);
        }
      }
      msgId ??= res?.result?.message_id ?? null;
    }
    return msgId;
  }

  async editMessage(chatId: number | string, msgId: number | string, text: string, opts: SendOpts = {}) {
    if (!text.trim()) return;
    const t = text.length > 4000 ? text.slice(0, 4000) + '\n...' : text;
    const p: any = { chat_id: chatId, message_id: msgId, text: t, disable_web_page_preview: true };
    if (opts.parseMode) p.parse_mode = opts.parseMode;
    if (opts.keyboard != null) p.reply_markup = opts.keyboard;
    this._logOutgoingPreview('editMessageText', `chat=${chatId} msg_id=${msgId}${opts.parseMode ? ` parse=${opts.parseMode}` : ''}`, t);
    try { await this.api('editMessageText', p); } catch (exc: any) {
      const s = String(exc).toLowerCase();
      if (s.includes('not modified') || s.includes("can't be edited")) return;
      if (opts.parseMode && (s.includes("can't parse") || s.includes('bad request'))) {
        delete p.parse_mode; try { await this.api('editMessageText', p); } catch { /* ignore */ }
      }
    }
  }

  async sendMessageDraft(chatId: number | string, draftId: number, text: string, opts: SendOpts = {}) {
    if (!text.trim()) return;
    const t = text.length > TG_MAX ? text.slice(0, TG_MAX) : text;
    const p: any = { chat_id: chatId, draft_id: draftId, text: t };
    if (opts.parseMode) p.parse_mode = opts.parseMode;
    this._applyThreadId(p, opts);
    this._logOutgoingPreview(
      'sendMessageDraft',
      `chat=${chatId} draft_id=${draftId}${opts.messageThreadId != null ? ` thread=${opts.messageThreadId}` : ''}${opts.parseMode ? ` parse=${opts.parseMode}` : ''}`,
      t,
    );
    await this.api('sendMessageDraft', p);
  }

  async deleteMessage(chatId: number | string, msgId: number | string) {
    try { await this.api('deleteMessage', { chat_id: chatId, message_id: msgId }); } catch { /* ignore */ }
  }

  async sendTyping(chatId: number | string, opts: SendOpts = {}) {
    const payload: any = { chat_id: chatId, action: 'typing' };
    this._applyThreadId(payload, opts);
    await this.api('sendChatAction', payload).catch(() => {});
  }

  // ========================================================================
  // Telegram-specific outgoing
  // ========================================================================

  async answerCallback(callbackId: string, text?: string) {
    if (text) this._logOutgoingText('answerCallbackQuery', `callback_id=${callbackId}`, text);
    await this.api('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) }).catch(() => {});
  }

  async setMessageReaction(chatId: number | string, msgId: number | string, reactions: string[]) {
    const payload = {
      chat_id: chatId,
      message_id: msgId,
      reaction: reactions.map(emoji => ({ type: 'emoji', emoji })),
      is_big: false,
    };
    await this.api('setMessageReaction', payload).catch(() => {});
  }

  async sendPhoto(
    chatId: number | string,
    photo: Buffer,
    opts: { caption?: string; replyTo?: number | string; filename?: string; mimeType?: string; messageThreadId?: number } = {},
  ): Promise<number | null> {
    const hash = crypto.createHash('md5').update(photo).digest('hex').slice(0, 16);
    const boundary = `----pikiclaw${hash}`;
    const parts: Buffer[] = [];
    const add = (s: string) => parts.push(Buffer.from(s, 'utf-8'));
    const filename = opts.filename || 'photo.jpg';
    const mimeType = opts.mimeType || mimeTypeForFilename(filename);
    add(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);
    if (opts.replyTo != null) add(`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${opts.replyTo}\r\n`);
    if (opts.messageThreadId != null) add(`--${boundary}\r\nContent-Disposition: form-data; name="message_thread_id"\r\n\r\n${opts.messageThreadId}\r\n`);
    if (opts.caption) add(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${opts.caption.slice(0, 1024)}\r\n`);
    add(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    parts.push(photo);
    add(`\r\n--${boundary}--\r\n`);
    this._logOutgoingFile('sendPhoto', `chat=${chatId} file=${filename} bytes=${photo.byteLength}${opts.replyTo != null ? ` reply_to=${opts.replyTo}` : ''}`);
    if (opts.caption) this._logOutgoingText('sendPhoto.caption', `chat=${chatId} file=${filename}`, opts.caption.slice(0, 1024));
    const resp = await this._fetchResponse(
      'Telegram API sendPhoto',
      `${this.base}/sendPhoto`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(parts),
      },
      this.apiTimeout * 1000,
    );
    const data = await parseJsonResponse(resp, 'Telegram API sendPhoto');
    if (!data?.ok) throw new Error(`Telegram API sendPhoto: ${previewText(JSON.stringify(data))}`);
    return data?.result?.message_id ?? null;
  }

  async sendDocument(
    chatId: number | string,
    content: string | Buffer,
    filename: string,
    opts: { caption?: string; replyTo?: number | string; messageThreadId?: number } = {},
  ): Promise<number | null> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);
    const boundary = `----pikiclaw${hash}`;
    const parts: Buffer[] = [];
    const add = (s: string) => parts.push(Buffer.from(s, 'utf-8'));
    add(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);
    if (opts.replyTo) add(`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${opts.replyTo}\r\n`);
    if (opts.messageThreadId != null) add(`--${boundary}\r\nContent-Disposition: form-data; name="message_thread_id"\r\n\r\n${opts.messageThreadId}\r\n`);
    if (opts.caption) add(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${opts.caption.slice(0, 1024)}\r\n`);
    add(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    parts.push(buf);
    add(`\r\n--${boundary}--\r\n`);
    this._logOutgoingFile('sendDocument', `chat=${chatId} file=${filename} bytes=${buf.byteLength}${opts.replyTo != null ? ` reply_to=${opts.replyTo}` : ''}`);
    if (opts.caption) this._logOutgoingText('sendDocument.caption', `chat=${chatId} file=${filename}`, opts.caption.slice(0, 1024));
    if (typeof content === 'string') this._logOutgoingText('sendDocument.body', `chat=${chatId} file=${filename}`, content);
    const resp = await this._fetchResponse(
      'Telegram API sendDocument',
      `${this.base}/sendDocument`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(parts),
      },
      this.apiTimeout * 1000,
    );
    const data = await parseJsonResponse(resp, 'Telegram API sendDocument');
    if (!data?.ok) throw new Error(`Telegram API sendDocument: ${previewText(JSON.stringify(data))}`);
    return data?.result?.message_id ?? null;
  }

  async sendFile(
    chatId: number | string,
    filePath: string,
    opts: { caption?: string; replyTo?: number | string; asPhoto?: boolean; messageThreadId?: number } = {},
  ): Promise<number | null> {
    const stat = fs.statSync(filePath);
    if (stat.size > FILE_MAX_BYTES) {
      throw new Error(`file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${FILE_MAX_BYTES / 1024 / 1024}MB)`);
    }
    const content = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const wantsPhoto = opts.asPhoto ?? PHOTO_EXTS.has(path.extname(filename).toLowerCase());
    if (wantsPhoto) {
      return this.sendPhoto(chatId, content, {
        caption: opts.caption,
        replyTo: opts.replyTo,
        messageThreadId: opts.messageThreadId,
        filename,
        mimeType: mimeTypeForFilename(filename),
      });
    }
    return this.sendDocument(chatId, content, filename, {
      caption: opts.caption,
      replyTo: opts.replyTo,
      messageThreadId: opts.messageThreadId,
    });
  }

  /** Set bottom menu commands and ensure the menu button is visible.
   *  Automatically applies to all known chats (from incoming updates). */
  override async setMenu(commands: MenuCommand[]) {
    this._menuCommands = commands;
    await this.api('setMyCommands', { commands });
    await this.api('setChatMenuButton', { menu_button: { type: 'commands' } });
    for (const cid of this.knownChats) {
      await this._applyMenuToChat(cid);
    }
  }

  /** Track a chat ID; apply menu on first discovery. */
  private _trackChat(chatId: number) {
    if (this.knownChats.has(chatId)) return;
    this.knownChats.add(chatId);
    this._applyMenuToChat(chatId).catch(() => {});
  }

  /** Apply cached menu commands to a single chat. */
  private async _applyMenuToChat(chatId: number) {
    if (!this._menuCommands) return;
    await this.api('setMyCommands', {
      commands: this._menuCommands,
      scope: { type: 'chat', chat_id: chatId },
    }).catch(() => {});
    await this.api('setChatMenuButton', {
      chat_id: chatId,
      menu_button: { type: 'commands' },
    }).catch(() => {});
  }

  /** Remove all bot commands and reset menu button to default. */
  override async clearMenu() {
    this._menuCommands = null;
    await this.api('deleteMyCommands', {}).catch(() => {});
    await this.api('setChatMenuButton', { menu_button: { type: 'default' } }).catch(() => {});
    for (const cid of this.knownChats) {
      await this.api('deleteMyCommands', { scope: { type: 'chat', chat_id: cid } }).catch(() => {});
      await this.api('setChatMenuButton', { chat_id: cid, menu_button: { type: 'default' } }).catch(() => {});
    }
  }

  /** Drain pending updates (call before listen to skip stale messages). */
  async drain(): Promise<number> {
    const data = await this.api('getUpdates', { offset: -1, timeout: 0 });
    const results = data.result || [];
    if (results.length) this.offset = results[results.length - 1].update_id + 1;
    return results.length;
  }

  /** Get the chat ID from the most recent incoming message (useful for 1v1 bot setup). */
  async getRecentChatId(): Promise<number | null> {
    const data = await this.api('getUpdates', { offset: -1, timeout: 0 });
    const results = data.result || [];
    if (!results.length) return null;
    const u = results[results.length - 1];
    return u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? null;
  }

  /** Download a Telegram file to a local path. Returns the local path. */
  async downloadFile(fileId: string, destFilename?: string): Promise<string> {
    const meta = await this.api('getFile', { file_id: fileId });
    const filePath = meta.result.file_path;
    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    const resp = await this._fetchResponse('Telegram file download', url, { method: 'GET' }, this.apiTimeout * 1000);
    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      throw new Error(`Telegram file download failed: HTTP ${resp.status} ${resp.statusText || ''}`.trim() + `; body=${previewText(raw)}`);
    }
    const ext = path.extname(filePath) || '.bin';
    const name = destFilename || `tg_${fileId.slice(-8)}${ext}`;
    const localPath = path.join(this.workdir, name);
    fs.mkdirSync(this.workdir, { recursive: true });
    if (resp.body) {
      await pipeline(Readable.fromWeb(resp.body as any), fs.createWriteStream(localPath));
    } else {
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(localPath, buf);
    }

    // Check downloaded file size
    const stat = fs.statSync(localPath);
    if (stat.size > FILE_MAX_BYTES) {
      fs.rmSync(localPath, { force: true });
      throw new Error(`file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${FILE_MAX_BYTES / 1024 / 1024}MB)`);
    }

    return localPath;
  }

  // ========================================================================
  // Low-level API
  // ========================================================================

  async api(method: string, payload?: any): Promise<any> {
    const timeout = method === 'getUpdates' ? (this.pollTimeout + 10) * 1000 : this.apiTimeout * 1000;
    const resp = await this._fetchResponse(
      `Telegram API ${method}`,
      `${this.base}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      },
      timeout,
    );
    const data = await parseJsonResponse(resp, `Telegram API ${method}`);
    if (!data.ok) {
      if (method === 'getUpdates' && Number(data.error_code) === 409) {
        const detail = typeof data.description === 'string' && data.description.trim()
          ? data.description.trim()
          : 'another getUpdates request is already running for this bot token';
        throw new Error(`Telegram polling conflict: ${detail}`);
      }
      throw new Error(`Telegram API ${method}: ${JSON.stringify(data)}`);
    }
    return data;
  }

  // ========================================================================
  // Internal: dispatch
  // ========================================================================

  private async _dispatch(update: any) {
    const key = this._queueKey(update);
    if (!key) {
      await this._dispatchNow(update);
      return;
    }

    const prev = this.messageChains.get(key) || Promise.resolve();
    const current = prev
      .catch(() => {})
      .then(() => this._dispatchNow(update));
    const settled = current.finally(() => {
      if (this.messageChains.get(key) === settled) this.messageChains.delete(key);
    });
    this.messageChains.set(key, settled);
    await settled;
  }

  private _queueKey(update: any): string | null {
    const raw = update.message || update.edited_message;
    if (!raw?.chat?.id) return null;
    const entities = raw.entities || [];
    const cmdEntity = entities.find((e: any) => e.type === 'bot_command' && e.offset === 0);
    if (cmdEntity) return null;
    return String(raw.chat.id);
  }

  private async _dispatchNow(update: any) {
    // callback query
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      this._log(`[recv] callback_query id=${cq.id} chat=${chatId} from=${cq.from?.username || cq.from?.id} data="${cq.data}"`);
      if (!chatId || !this._isAllowed(chatId)) { this._log(`[recv] callback blocked: chat=${chatId} not allowed`); return; }
      this._trackChat(chatId);
      if (!this._hCallback) return;
      const ctx = this._makeCtx(chatId, cq.message?.message_id ?? 0, cq.from, cq) as TgCallbackContext;
      ctx.callbackId = cq.id;
      ctx.answerCallback = (text?: string) => this.answerCallback(cq.id, text);
      await this._hCallback(cq.data || '', ctx);
      return;
    }

    // message
    const raw = update.message || update.edited_message;
    if (!raw || !raw.chat?.id) return;
    const chatId = raw.chat.id;
    const fromUser = raw.from?.username || raw.from?.first_name || raw.from?.id || '?';
    const msgPreview = (raw.text || raw.caption || '').slice(0, 120);
    this._log(`[recv] message chat=${chatId} from=${fromUser} msg_id=${raw.message_id} text="${msgPreview}"${raw.photo ? ' +photo' : ''}${raw.document ? ` +doc(${raw.document?.file_name})` : ''}`);
    if (!this._isAllowed(chatId)) { this._log(`[recv] blocked: chat=${chatId} not in allowlist`); return; }
    this._trackChat(chatId);
    if (!this._shouldHandle(raw)) { this._log(`[recv] skipped: not relevant (group mention/reply check)`); return; }

    const from: TgFrom = { id: raw.from?.id, username: raw.from?.username, firstName: raw.from?.first_name };
    const ctx = this._makeCtx(chatId, raw.message_id, from, raw);

    // command — if no command handler registered, fall through to message handler
    const entities = raw.entities || [];
    const cmdEntity = entities.find((e: any) => e.type === 'bot_command' && e.offset === 0);
    if (cmdEntity) {
      const full = (raw.text || '').slice(cmdEntity.offset, cmdEntity.offset + cmdEntity.length);
      const cmd = full.replace(/^\//, '').split('@')[0].toLowerCase();
      const args = (raw.text || '').slice(cmdEntity.offset + cmdEntity.length).trim();
      this._log(`[recv] command /${cmd} args="${args.slice(0, 80)}" chat=${chatId}`);
      if (this._hCommand) {
        await this._hCommand(cmd, args, ctx);
        return;
      }
    }

    // message (text + files aggregation)
    if (!this._hMessage) return;
    const text = this._cleanMention(raw.text || raw.caption || '');
    const files: string[] = [];

    // download photo
    if (raw.photo?.length) {
      const best = raw.photo[raw.photo.length - 1];
      this._log(`[recv] downloading photo file_id=${best.file_id} size=${best.width}x${best.height}`);
      try {
        const localPath = await this.downloadFile(best.file_id, `_tg_photo_${raw.message_id}.jpg`);
        files.push(localPath);
        this._log(`[recv] photo saved: ${localPath}`);
      } catch (e: any) { this._log(`[recv] photo download failed: ${e}`); this._hError?.(e); }
    }

    // download document
    if (raw.document) {
      const origName = raw.document.file_name || `doc_${raw.message_id}`;
      this._log(`[recv] downloading document "${origName}" file_id=${raw.document.file_id}`);
      try {
        const localPath = await this.downloadFile(raw.document.file_id, `_tg_${origName}`);
        files.push(localPath);
        this._log(`[recv] document saved: ${localPath}`);
      } catch (e: any) { this._log(`[recv] document download failed: ${e}`); this._hError?.(e); }
    }

    this._log(`[dispatch] -> onMessage text="${text.slice(0, 80)}" files=${files.length} chat=${chatId}`);
    await this._hMessage({ text, files }, ctx);
  }

  // ========================================================================
  // Internal: helpers
  // ========================================================================

  private _makeCtx(chatId: number, messageId: number, from: any, raw: any): TgContext {
    const messageThreadId = typeof raw?.message_thread_id === 'number' ? raw.message_thread_id : undefined;
    return {
      chatId, messageId,
      from: { id: from?.id, username: from?.username, firstName: from?.first_name },
      reply: (text: string, opts?: SendOpts) => this.send(chatId, text, { ...opts, replyTo: messageId, messageThreadId: opts?.messageThreadId ?? messageThreadId }),
      editReply: (msgId: number, text: string, opts?: SendOpts) => this.editMessage(chatId, msgId, text, opts),
      answerCallback: () => Promise.resolve(),
      channel: this,
      raw,
    };
  }

  private _isAllowed(chatId: number): boolean {
    return this.allowedChatIds.size === 0 || this.allowedChatIds.has(chatId);
  }

  private _shouldHandle(raw: any): boolean {
    const chatType = raw.chat?.type || '';
    const text = (raw.text || raw.caption || '').trim();
    const hasMedia = !!raw.photo || !!raw.document;
    if (chatType === 'private') return !!(text || hasMedia);
    if ((raw.entities || []).some((e: any) => e.type === 'bot_command' && e.offset === 0)) return true;
    if (!this.requireMention) return !!(text || hasMedia);
    const mention = this.bot?.username ? `@${(this.bot.username as string).toLowerCase()}` : '';
    if (mention && text.toLowerCase().includes(mention)) return true;
    if (raw.reply_to_message?.from?.id === (this.bot?.id ?? 0)) return true;
    return false;
  }

  private _cleanMention(text: string): string {
    if (this.bot?.username) text = text.replace(new RegExp(`@${this.bot.username}`, 'gi'), '');
    return text.trim();
  }

  _log(msg: string) {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`[telegram ${ts}] ${msg}\n`);
  }
}
