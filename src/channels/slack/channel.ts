/**
 * Slack channel transport — Socket Mode (no public IP needed).
 *
 * Uses @slack/socket-mode + @slack/web-api directly (avoids the heavier Bolt
 * framework so we keep tight control of the receive loop and stay consistent
 * with the other channels).
 *
 * Two tokens are required:
 *   - bot token  (xoxb-…) — REST send/edit
 *   - app token  (xapp-…) — Socket Mode connection
 *
 * Receives DMs and messages where the bot is mentioned in a channel. Messages
 * the bot itself authored are filtered out before dispatch.
 */

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient, type WebAPICallResult } from '@slack/web-api';
import {
  Channel,
  type BotInfo,
  DEFAULT_CHANNEL_CAPABILITIES,
  type SendOpts,
  splitText,
  sleep,
} from '../base.js';
import { SLACK_LIMITS } from '../../core/constants.js';
import { writeScopedLog, type LogLevel } from '../../core/logging.js';
import { ChannelHealth } from '../health.js';

export interface SlackOpts {
  botToken: string;
  appToken: string;
  workdir?: string;
  allowedChatIds?: Set<string>;
  /** When true (default), require @mention in shared channels — DMs always pass. */
  requireMentionInChannel?: boolean;
}

export interface SlackMessagePayload {
  text: string;
  files: string[];
}

export interface SlackFrom {
  userId: string;
  username?: string;
}

export interface SlackContext {
  chatId: string;          // Slack channel id (Cxxxx / Dxxxx / Gxxxx)
  messageId: string;        // Slack message ts
  threadTs: string | null;  // Slack thread root ts, if any
  from: SlackFrom;
  reply: (text: string, opts?: SendOpts) => Promise<string | null>;
  editReply: (msgId: string, text: string, opts?: SendOpts) => Promise<void>;
  channel: SlackChannel;
  raw: any;
}

export type SlackMessageHandler = (msg: SlackMessagePayload, ctx: SlackContext) => Promise<any> | any;
export type SlackErrorHandler = (err: Error) => void;

const SLACK_MAX = SLACK_LIMITS.maxMessageLength;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'unknown error');
}

export class SlackChannel extends Channel {
  override readonly capabilities = {
    ...DEFAULT_CHANNEL_CAPABILITIES,
    editMessages: true,
    typingIndicators: false, // chat.postMessage with thread_ts emulates ack
  };

  readonly knownChats = new Set<string>();

  private readonly botToken: string;
  private readonly appToken: string;
  private readonly allowedChatIds?: Set<string>;
  private readonly requireMention: boolean;

  private webClient!: WebClient;
  private socketClient: SocketModeClient | null = null;
  private botUserId: string | null = null;
  private running = false;
  private listenResolve: (() => void) | null = null;

  private readonly messageHandlers = new Set<SlackMessageHandler>();
  private readonly errorHandlers = new Set<SlackErrorHandler>();

  /** Dedup: Slack delivers events at-least-once via Socket Mode acks. */
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventQueue: string[] = [];
  private static readonly SEEN_EVENT_CAP = 256;

  constructor(opts: SlackOpts) {
    super();
    this.botToken = opts.botToken;
    this.appToken = opts.appToken;
    this.allowedChatIds = opts.allowedChatIds;
    this.requireMention = opts.requireMentionInChannel ?? true;
  }

  onMessage(handler: SlackMessageHandler) { this.messageHandlers.add(handler); return this; }
  onError(handler: SlackErrorHandler) { this.errorHandlers.add(handler); return this; }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async connect(): Promise<BotInfo> {
    this.webClient = new WebClient(this.botToken);
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const auth: any = await this.webClient.auth.test();
        if (!auth?.ok) throw new Error(`auth.test failed: ${auth?.error || 'unknown'}`);
        this.botUserId = String(auth.user_id || '').trim();
        this.bot = {
          id: this.botUserId || '',
          username: String(auth.user || '').trim(),
          displayName: String(auth.user || auth.team || 'slack-bot').trim(),
        };
        return this.bot;
      } catch (err) {
        lastErr = err;
        if (attempt >= 5) break;
        await sleep(Math.min(1000 * attempt, 5_000));
      }
    }
    throw new Error(`Slack connect failed: ${describeError(lastErr)}`);
  }

  async listen(): Promise<void> {
    this.running = true;
    this.socketClient = new SocketModeClient({
      appToken: this.appToken,
      // We log via our own scope; suppress noisy SDK info logs.
      logLevel: undefined as any,
    });

    this.socketClient.on('message', async ({ event, ack }) => {
      try { await ack(); } catch {}
      void this.dispatchMessageEvent(event).catch(error => {
        this.emitError(error instanceof Error ? error : new Error(describeError(error)));
      });
    });

    this.socketClient.on('app_mention', async ({ event, ack }) => {
      try { await ack(); } catch {}
      void this.dispatchMessageEvent(event).catch(error => {
        this.emitError(error instanceof Error ? error : new Error(describeError(error)));
      });
    });

    this.socketClient.on('error', err => {
      this.emitError(err instanceof Error ? err : new Error(describeError(err)));
    });
    this.socketClient.on('disconnect', () => {
      this.debug('[ws] disconnected — SDK will auto-reconnect');
    });

    const health = new ChannelHealth({
      label: 'Slack',
      opAction: 'WS start',
      initialDelayMs: SLACK_LIMITS.initialRetryDelay,
      maxDelayMs: SLACK_LIMITS.maxRetryDelay,
      sustainedFailureHint: 'verify slackBotToken (xoxb-) / slackAppToken (xapp-) in setting.json',
      log: (msg, level) => this.log(msg, level),
    });
    while (this.running) {
      try {
        await this.socketClient.start();
        health.recordSuccess();
        break;
      } catch (err) {
        if (!this.running) return;
        await sleep(health.recordFailure(err));
      }
    }

    if (!this.running) {
      try { await this.socketClient.disconnect(); } catch {}
      return;
    }

    await new Promise<void>(resolve => {
      this.listenResolve = resolve;
      if (!this.running) resolve();
    });
  }

  disconnect(): void {
    this.running = false;
    if (this.socketClient) {
      try { void this.socketClient.disconnect(); } catch {}
      this.socketClient = null;
    }
    this.listenResolve?.();
    this.listenResolve = null;
  }

  // ========================================================================
  // Outgoing primitives
  // ========================================================================

  async send(chatId: number | string, text: string, opts: SendOpts = {}): Promise<string | null> {
    const channelId = String(chatId);
    const chunks = splitText((text || '').trim() || '(empty)', SLACK_MAX);
    let lastTs: string | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const payload: any = { channel: channelId, text: chunk, mrkdwn: true };
      if (opts.replyTo) payload.thread_ts = String(opts.replyTo);
      const resp: any = await this.webClient.chat.postMessage(payload);
      if (!resp?.ok) {
        throw new Error(`Slack chat.postMessage failed: ${resp?.error || 'unknown'}`);
      }
      const ts = String(resp.ts || resp.message?.ts || '').trim();
      if (ts) lastTs = ts;
    }
    return lastTs;
  }

  async editMessage(chatId: number | string, msgId: number | string, text: string, _opts?: SendOpts): Promise<void> {
    if (!String(text).trim()) return;
    const channelId = String(chatId);
    const ts = String(msgId);
    const trimmed = text.length > SLACK_MAX ? text.slice(0, SLACK_MAX) + '\n…(truncated)' : text;
    try {
      const resp: any = await this.webClient.chat.update({ channel: channelId, ts, text: trimmed, mrkdwn: true } as any);
      if (!resp?.ok) {
        const detail = String(resp?.error || '');
        if (detail === 'message_not_found' || detail === 'cant_update_message') return;
        throw new Error(`Slack chat.update failed: ${detail || 'unknown'}`);
      }
    } catch (err) {
      const detail = describeError(err).toLowerCase();
      if (detail.includes('message_not_found') || detail.includes('cant_update_message')) return;
      throw err;
    }
  }

  async deleteMessage(chatId: number | string, msgId: number | string): Promise<void> {
    try {
      await this.webClient.chat.delete({ channel: String(chatId), ts: String(msgId) });
    } catch {}
  }

  async sendTyping(_chatId: number | string, _opts?: SendOpts): Promise<void> {
    // Slack does not expose a typing indicator in the public API.
  }

  // ========================================================================
  // Internal dispatch
  // ========================================================================

  private async dispatchMessageEvent(event: any): Promise<void> {
    if (!event || event.bot_id || event.subtype === 'bot_message') return;
    if (this.botUserId && event.user === this.botUserId) return;

    const channelId = String(event.channel || '').trim();
    const messageTs = String(event.ts || event.event_ts || '').trim();
    const userId = String(event.user || '').trim();
    if (!channelId || !messageTs || !userId) return;

    const eventId = String(event.client_msg_id || `${channelId}:${messageTs}`);
    if (this.seenEventIds.has(eventId)) return;
    this.seenEventIds.add(eventId);
    this.seenEventQueue.push(eventId);
    while (this.seenEventQueue.length > SlackChannel.SEEN_EVENT_CAP) {
      this.seenEventIds.delete(this.seenEventQueue.shift()!);
    }

    if (!this.isAllowed(channelId)) return;
    this.knownChats.add(channelId);

    const channelType = String(event.channel_type || '').trim();
    const isDm = channelType === 'im';
    const text = String(event.text || '').trim();
    const mention = this.botUserId ? `<@${this.botUserId}>` : '';
    const mentionedHere = mention ? text.includes(mention) : false;
    if (!isDm && this.requireMention && !mentionedHere) return;

    const cleanedText = mention ? text.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim() : text;

    const ctx: SlackContext = {
      chatId: channelId,
      messageId: messageTs,
      threadTs: typeof event.thread_ts === 'string' && event.thread_ts ? event.thread_ts : null,
      from: { userId, username: event.user_profile?.display_name || event.username || undefined },
      reply: (replyText, opts) => this.send(channelId, replyText, {
        ...opts,
        replyTo: opts?.replyTo ?? (event.thread_ts || messageTs),
      }),
      editReply: (msgId, replyText, opts) => this.editMessage(channelId, msgId, replyText, opts),
      channel: this,
      raw: event,
    };

    const payload: SlackMessagePayload = { text: cleanedText, files: [] };
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
  private log(msg: string, level: LogLevel = 'info') { writeScopedLog('slack', msg, { level }); }
}
