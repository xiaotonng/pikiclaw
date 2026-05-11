/**
 * WeChat Work / 企业微信 智能机器人 channel transport — Smart Bot WebSocket.
 *
 * Endpoint:   wss://openws.work.weixin.qq.com
 * Frame envelope:
 *   { cmd, headers: { req_id }, body }
 *   responses omit `cmd` and may carry { errcode, errmsg }
 *
 * Outbound:
 *   - aibot_subscribe { bot_id, secret }              — auth + register
 *   - ping                                              — heartbeat (30s)
 *   - aibot_respond_msg (stream, finish=true)         — reply to a callback
 *   - aibot_send_msg (markdown)                        — proactive send
 *
 * Inbound:
 *   - aibot_msg_callback { msgid, chatid, chattype, from.userid, msgtype, text/voice/image/file/mixed/quote }
 *
 * Caveats:
 *   - text/voice messages are dispatched as text. Image/file/mixed payloads
 *     reference encrypted URLs that require a separate corp-secret + AES key
 *     to download — out of scope for this minimal transport.
 *   - The protocol has no edit primitive. editMessage is a no-op.
 *   - Plain text messages may be sent via aibot_respond_msg (in conversation,
 *     when we still hold the original req_id) or aibot_send_msg (proactive
 *     send to a known chatid). We use the original req_id for the first
 *     reply and switch to aibot_send_msg for follow-up messages in the same
 *     conversation (e.g. streaming result deliveries).
 */

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import {
  Channel,
  type BotInfo,
  DEFAULT_CHANNEL_CAPABILITIES,
  type SendOpts,
  splitText,
  sleep,
} from '../base.js';
import { WECOM_LIMITS } from '../../core/constants.js';
import { writeScopedLog, type LogLevel } from '../../core/logging.js';
import { ChannelHealth } from '../health.js';

export interface WeComOpts {
  botId: string;
  botSecret: string;
  endpoint?: string;
  workdir?: string;
  /** Optional userId allowlist. */
  allowedUserIds?: Set<string>;
}

export interface WeComMessagePayload {
  text: string;
  files: string[];
}

export interface WeComFrom {
  userId: string;
}

export interface WeComContext {
  chatId: string;          // conversation key (chatid for groups, userid for 1:1)
  messageId: string;        // wecom msgid
  chatType: 'single' | 'group' | string;
  from: WeComFrom;
  /** Original req_id from the inbound callback — usable for one stream reply. */
  reqId: string;
  reply: (text: string, opts?: SendOpts) => Promise<string | null>;
  editReply: (msgId: string, text: string, opts?: SendOpts) => Promise<void>;
  channel: WeComChannel;
  raw: any;
}

export type WeComMessageHandler = (msg: WeComMessagePayload, ctx: WeComContext) => Promise<any> | any;
export type WeComErrorHandler = (err: Error) => void;

const WC_MAX = WECOM_LIMITS.maxMessageLength;
const WC_HEARTBEAT_MS = WECOM_LIMITS.heartbeatInterval;

interface WsFrame {
  cmd?: string;
  headers?: { req_id?: string };
  body?: any;
  errcode?: number;
  errmsg?: string;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'unknown error');
}

interface ChatMeta {
  /** Most recent inbound req_id. We consume it on the first reply (since
   *  aibot_respond_msg with stream/finish=true is one-shot). */
  pendingReqId: string | null;
}

export class WeComChannel extends Channel {
  override readonly capabilities = {
    ...DEFAULT_CHANNEL_CAPABILITIES,
    // Smart Bot WS protocol has no edit primitive.
  };

  readonly knownChats = new Set<string>();

  private readonly botId: string;
  private readonly botSecret: string;
  private readonly endpoint: string;
  private readonly allowedUserIds?: Set<string>;

  private ws: WebSocket | null = null;
  private running = false;
  private listenResolve: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedPong = 0;
  private reqSeq = 0;
  private readonly chatMeta = new Map<string, ChatMeta>();

  /** req_id -> deferred ack handler. */
  private readonly pendingAcks = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  /** Dedup by msgid. */
  private readonly seenMsgIds = new Set<string>();
  private readonly seenMsgQueue: string[] = [];
  private static readonly SEEN_CAP = 256;

  /** Subscribe ack waiter — only set during initial handshake. */
  private subscribeAck: ((err: Error | null) => void) | null = null;

  private readonly internalEmitter = new EventEmitter();
  private readonly messageHandlers = new Set<WeComMessageHandler>();
  private readonly errorHandlers = new Set<WeComErrorHandler>();

  constructor(opts: WeComOpts) {
    super();
    this.botId = opts.botId;
    this.botSecret = opts.botSecret;
    this.endpoint = (opts.endpoint || WECOM_LIMITS.defaultEndpoint).replace(/\/+$/, '/');
    this.allowedUserIds = opts.allowedUserIds;
    this.internalEmitter.setMaxListeners(0);
  }

  onMessage(handler: WeComMessageHandler) { this.messageHandlers.add(handler); return this; }
  onError(handler: WeComErrorHandler) { this.errorHandlers.add(handler); return this; }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async connect(): Promise<BotInfo> {
    const shortId = this.botId.length > 12 ? `${this.botId.slice(0, 6)}...${this.botId.slice(-4)}` : this.botId;
    this.bot = {
      id: this.botId,
      username: `wecom_${shortId}`,
      displayName: `WeCom ${shortId}`,
    };
    return this.bot;
  }

  async listen(): Promise<void> {
    this.running = true;
    const health = new ChannelHealth({
      label: 'WeCom',
      opAction: 'WS connect',
      initialDelayMs: WECOM_LIMITS.initialRetryDelay,
      maxDelayMs: WECOM_LIMITS.maxRetryDelay,
      sustainedFailureHint: 'verify wecomBotId / wecomBotSecret / wecomEndpoint in setting.json',
      log: (msg, level) => this.log(msg, level),
    });
    while (this.running) {
      const connectedAt = Date.now();
      let connectionErr: unknown = null;
      try {
        await this.runConnection();
      } catch (err) {
        connectionErr = err;
        this.emitError(err instanceof Error ? err : new Error(describeError(err)));
      }
      if (!this.running) break;
      // A connection that survived >2 heartbeats counts as "healthy session
      // ended" → reset backoff and reconnect quickly. Anything shorter is
      // treated as a failed attempt that advances exponential backoff.
      const wasLongLived = Date.now() - connectedAt > 2 * WC_HEARTBEAT_MS;
      const delayMs = wasLongLived
        ? (health.recordSuccess(), WECOM_LIMITS.initialRetryDelay)
        : health.recordFailure(connectionErr ?? new Error('connection dropped'));
      await sleep(delayMs);
    }
  }

  disconnect(): void {
    this.running = false;
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.listenResolve?.();
    this.listenResolve = null;
  }

  // ========================================================================
  // Single-connection lifecycle
  // ========================================================================

  private runConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.stopHeartbeat();
        this.failPendingAcks();
        try { ws.close(); } catch {}
        if (err) reject(err);
        else resolve();
      };

      this.debug(`[ws] dialing ${this.endpoint}`);
      const ws = new WebSocket(this.endpoint);
      this.ws = ws;
      this.missedPong = 0;

      ws.on('open', () => {
        this.subscribe().catch(err => finish(err instanceof Error ? err : new Error(describeError(err))));
      });

      ws.on('message', raw => {
        try {
          const text = raw instanceof Buffer ? raw.toString('utf-8') : String(raw);
          const frame: WsFrame = JSON.parse(text);
          this.handleFrame(frame);
        } catch (err) {
          this.debug(`[ws] invalid json: ${describeError(err)}`);
        }
      });

      ws.on('error', err => {
        const error = err instanceof Error ? err : new Error(describeError(err));
        finish(error);
      });

      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf?.toString?.() || '';
        const detail = reason ? `${code} ${reason}` : `${code}`;
        finish(new Error(`websocket closed: ${detail}`));
      });
    });
  }

  private async subscribe(): Promise<void> {
    const reqId = this.makeReqId('aibot_subscribe');
    const frame = {
      cmd: 'aibot_subscribe',
      headers: { req_id: reqId },
      body: { bot_id: this.botId, secret: this.botSecret },
    };

    await new Promise<void>((resolve, reject) => {
      this.subscribeAck = err => err ? reject(err) : resolve();
      this.writeFrame(frame).catch(err => {
        this.subscribeAck = null;
        reject(err instanceof Error ? err : new Error(describeError(err)));
      });
      // Defensive timeout — server should ack within seconds.
      const timer = setTimeout(() => {
        if (!this.subscribeAck) return;
        const ack = this.subscribeAck;
        this.subscribeAck = null;
        ack(new Error('subscribe ack timeout'));
      }, 10_000);
      timer.unref?.();
    });

    this.debug('[ws] subscribed successfully');
    this.startHeartbeat();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.missedPong >= 2) {
        this.log('[ws] no heartbeat ack for 2 consecutive pings — closing', 'warn');
        try { this.ws?.close(); } catch {}
        return;
      }
      this.missedPong++;
      const reqId = this.makeReqId('ping');
      void this.writeFrame({ cmd: 'ping', headers: { req_id: reqId } }).catch(() => {});
    }, WC_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ========================================================================
  // Frame dispatch
  // ========================================================================

  private handleFrame(frame: WsFrame) {
    const cmd = frame.cmd || '';
    const reqId = frame.headers?.req_id || '';
    if (cmd === 'aibot_msg_callback') {
      this.handleMsgCallback(frame);
      return;
    }
    if (cmd === 'aibot_event_callback') {
      this.debug(`[ws] event callback (ignored) req_id=${reqId}`);
      return;
    }
    if (!cmd) {
      // Response frame; route by req_id prefix.
      if (reqId.startsWith('ping')) {
        this.missedPong = 0;
        return;
      }
      if (reqId.startsWith('aibot_subscribe')) {
        const ack = this.subscribeAck;
        this.subscribeAck = null;
        if (typeof frame.errcode === 'number' && frame.errcode !== 0) {
          ack?.(new Error(`subscribe failed: errcode=${frame.errcode} errmsg=${frame.errmsg || ''}`));
        } else {
          ack?.(null);
        }
        return;
      }
      const pending = this.pendingAcks.get(reqId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAcks.delete(reqId);
        if (typeof frame.errcode === 'number' && frame.errcode !== 0) {
          pending.reject(new Error(`ack errcode=${frame.errcode} errmsg=${frame.errmsg || ''}`));
        } else {
          pending.resolve();
        }
      }
      return;
    }
    this.debug(`[ws] unhandled cmd=${cmd}`);
  }

  private handleMsgCallback(frame: WsFrame) {
    const body = frame.body || {};
    const msgId = String(body.msgid || '').trim();
    const reqId = frame.headers?.req_id || '';
    if (!msgId) return;

    if (this.seenMsgIds.has(msgId)) return;
    this.seenMsgIds.add(msgId);
    this.seenMsgQueue.push(msgId);
    while (this.seenMsgQueue.length > WeComChannel.SEEN_CAP) {
      this.seenMsgIds.delete(this.seenMsgQueue.shift()!);
    }

    const userId = String(body.from?.userid || '').trim();
    if (!userId) return;
    if (!this.isAllowed(userId)) {
      this.debug(`[recv] blocked: userid=${userId} not in allowlist`);
      return;
    }

    const chatType = String(body.chattype || 'single');
    const chatId = String(body.chatid || '').trim() || userId;
    this.knownChats.add(chatId);

    const meta = this.chatMeta.get(chatId) ?? { pendingReqId: null };
    meta.pendingReqId = reqId || meta.pendingReqId;
    this.chatMeta.set(chatId, meta);

    const text = this.extractInboundText(body);

    const ctx: WeComContext = {
      chatId,
      messageId: msgId,
      chatType,
      reqId: reqId || '',
      from: { userId },
      reply: (replyText, opts) => this.send(chatId, replyText, opts),
      editReply: () => Promise.resolve(),
      channel: this,
      raw: body,
    };

    const payload: WeComMessagePayload = { text, files: [] };
    void this.dispatchInbound(payload, ctx);
  }

  private extractInboundText(body: any): string {
    if (!body) return '';
    const direct = String(body.text?.content || '').trim();
    if (direct) return this.stripBotMention(direct, body.aibotid);
    if (body.msgtype === 'voice') {
      const voice = body.voice || {};
      const transcript = String(voice.content || voice.text || '').trim();
      if (transcript) return this.stripBotMention(transcript, body.aibotid);
    }
    if (body.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
      const parts: string[] = [];
      for (const item of body.mixed.msg_item) {
        if (item?.msgtype === 'text' && item.text?.content) parts.push(String(item.text.content));
      }
      const joined = parts.join('\n').trim();
      if (joined) return this.stripBotMention(joined, body.aibotid);
    }
    return '';
  }

  private stripBotMention(text: string, aibotid?: string): string {
    let out = text;
    if (aibotid) out = out.replace(new RegExp(`@${aibotid}`, 'g'), '');
    if (this.botId) out = out.replace(new RegExp(`@${this.botId}`, 'g'), '');
    return out.trim();
  }

  private async dispatchInbound(payload: WeComMessagePayload, ctx: WeComContext) {
    for (const handler of this.messageHandlers) {
      try { await handler(payload, ctx); } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(describeError(error)));
      }
    }
  }

  // ========================================================================
  // Outgoing primitives
  // ========================================================================

  async send(chatId: number | string, text: string, _opts?: SendOpts): Promise<string | null> {
    const chat = String(chatId);
    const trimmed = (text || '').trim() || '(empty)';
    const chunks = splitText(trimmed, WC_MAX);
    let lastReqId: string | null = null;

    const meta = this.chatMeta.get(chat);
    const replyReqId = meta?.pendingReqId;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      // First chunk: prefer aibot_respond_msg if we hold a fresh req_id.
      if (i === 0 && replyReqId) {
        const streamId = this.makeReqId('stream');
        const frame = {
          cmd: 'aibot_respond_msg',
          headers: { req_id: replyReqId },
          body: {
            msgtype: 'stream',
            stream: { id: streamId, finish: true, content: chunk },
          },
        };
        await this.writeFrame(frame);
        // The server treats the req_id as consumed after stream finish=true.
        if (meta) meta.pendingReqId = null;
        lastReqId = replyReqId;
        continue;
      }
      const reqId = this.makeReqId('aibot_send_msg');
      const frame = {
        cmd: 'aibot_send_msg',
        headers: { req_id: reqId },
        body: {
          chatid: chat,
          msgtype: 'markdown',
          markdown: { content: chunk },
        },
      };
      await this.writeAndAwaitAck(reqId, frame, 5_000);
      lastReqId = reqId;
    }
    return lastReqId;
  }

  async editMessage(_chatId: number | string, _msgId: number | string, _text: string, _opts?: SendOpts): Promise<void> {
    // No edit primitive in the Smart Bot WS protocol.
  }

  async deleteMessage(_chatId: number | string, _msgId: number | string): Promise<void> {
    // No delete primitive.
  }

  async sendTyping(_chatId: number | string, _opts?: SendOpts): Promise<void> {
    // No typing indicator.
  }

  // ========================================================================
  // Frame writing helpers
  // ========================================================================

  private writeFrame(frame: any): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== ws.OPEN) {
        reject(new Error('wecom-ws: not connected'));
        return;
      }
      ws.send(JSON.stringify(frame), err => {
        if (err) reject(err instanceof Error ? err : new Error(describeError(err)));
        else resolve();
      });
    });
  }

  private writeAndAwaitAck(reqId: string, frame: any, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(reqId);
        // Fall back to non-blocking on timeout to avoid deadlocks.
        this.debug(`[ws] ack timeout req_id=${reqId} — proceeding`);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      this.pendingAcks.set(reqId, { resolve, reject, timer });
      this.writeFrame(frame).catch(err => {
        const pending = this.pendingAcks.get(reqId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(reqId);
        }
        reject(err);
      });
    });
  }

  private failPendingAcks() {
    for (const [reqId, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(new Error('wecom-ws: connection closed'));
      this.pendingAcks.delete(reqId);
    }
  }

  private makeReqId(prefix: string): string {
    this.reqSeq += 1;
    return `${prefix}_${this.reqSeq}`;
  }

  private isAllowed(userId: string): boolean {
    if (!this.allowedUserIds?.size) return true;
    return this.allowedUserIds.has(userId);
  }

  private emitError(error: Error) {
    for (const handler of this.errorHandlers) {
      try { handler(error); } catch {}
    }
  }

  private debug(msg: string) { this.log(msg, 'debug'); }
  private log(msg: string, level: LogLevel = 'info') { writeScopedLog('wecom', msg, { level }); }
}
