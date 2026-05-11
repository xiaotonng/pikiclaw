/**
 * Discord channel transport — Gateway WebSocket (no public IP needed).
 *
 * Uses discord.js v14 with the bare minimum gateway intents:
 *   - Guilds, GuildMessages, MessageContent, DirectMessages
 *
 * IMPORTANT: For the bot to read message content in shared channels you must
 * enable the "Message Content Intent" toggle in the Discord developer portal
 * Bot page. Without it the gateway will silently emit empty `content`.
 *
 * Receives DMs and messages where the bot is mentioned. Self-authored
 * messages are filtered out before dispatch.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import {
  Channel,
  type BotInfo,
  DEFAULT_CHANNEL_CAPABILITIES,
  type SendOpts,
  splitText,
  sleep,
} from '../base.js';
import { DISCORD_LIMITS } from '../../core/constants.js';
import { writeScopedLog, type LogLevel } from '../../core/logging.js';

export interface DiscordOpts {
  botToken: string;
  workdir?: string;
  /** Optional channel-id allowlist; empty/undefined means "all". */
  allowedChatIds?: Set<string>;
  /** When true (default), require @mention in shared channels — DMs always pass. */
  requireMentionInChannel?: boolean;
}

export interface DiscordMessagePayload {
  text: string;
  files: string[];
}

export interface DiscordFrom {
  userId: string;
  username?: string;
}

export interface DiscordContext {
  chatId: string;
  messageId: string;
  from: DiscordFrom;
  reply: (text: string, opts?: SendOpts) => Promise<string | null>;
  editReply: (msgId: string, text: string, opts?: SendOpts) => Promise<void>;
  channel: DiscordChannel;
  raw: Message;
}

export type DiscordMessageHandler = (msg: DiscordMessagePayload, ctx: DiscordContext) => Promise<any> | any;
export type DiscordErrorHandler = (err: Error) => void;

const DISCORD_MAX = DISCORD_LIMITS.maxMessageLength;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'unknown error');
}

export class DiscordChannel extends Channel {
  override readonly capabilities = {
    ...DEFAULT_CHANNEL_CAPABILITIES,
    editMessages: true,
  };

  readonly knownChats = new Set<string>();

  private readonly botToken: string;
  private readonly allowedChatIds?: Set<string>;
  private readonly requireMention: boolean;

  private client!: Client;
  private botUserId: string | null = null;
  private running = false;
  private listenResolve: (() => void) | null = null;

  private readonly messageHandlers = new Set<DiscordMessageHandler>();
  private readonly errorHandlers = new Set<DiscordErrorHandler>();

  constructor(opts: DiscordOpts) {
    super();
    this.botToken = opts.botToken;
    this.allowedChatIds = opts.allowedChatIds;
    this.requireMention = opts.requireMentionInChannel ?? true;
  }

  onMessage(handler: DiscordMessageHandler) { this.messageHandlers.add(handler); return this; }
  onError(handler: DiscordErrorHandler) { this.errorHandlers.add(handler); return this; }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async connect(): Promise<BotInfo> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    let resolveReady: (() => void) | null = null;
    let rejectReady: ((err: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.client.once(Events.ClientReady, () => resolveReady?.());
    this.client.once(Events.Error, err => rejectReady?.(err instanceof Error ? err : new Error(describeError(err))));

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.client.login(this.botToken);
        await ready;
        const me = this.client.user;
        if (!me) throw new Error('Discord client missing user after ready');
        this.botUserId = me.id;
        this.bot = {
          id: me.id,
          username: me.username || '',
          displayName: me.displayName || me.username || 'discord-bot',
        };
        return this.bot;
      } catch (err) {
        lastErr = err;
        try { await this.client.destroy(); } catch {}
        if (attempt >= 5) break;
        await sleep(Math.min(1000 * attempt, 5_000));
      }
    }
    throw new Error(`Discord connect failed: ${describeError(lastErr)}`);
  }

  async listen(): Promise<void> {
    this.running = true;

    this.client.on(Events.MessageCreate, (msg) => {
      void this.dispatchMessage(msg).catch(error => {
        this.emitError(error instanceof Error ? error : new Error(describeError(error)));
      });
    });

    this.client.on(Events.Error, err => {
      this.emitError(err instanceof Error ? err : new Error(describeError(err)));
    });

    this.client.on(Events.ShardDisconnect, () => {
      this.debug('[gateway] shard disconnected — discord.js will auto-reconnect');
    });

    if (!this.running) return;
    await new Promise<void>(resolve => {
      this.listenResolve = resolve;
      if (!this.running) resolve();
    });
  }

  disconnect(): void {
    this.running = false;
    try { void this.client?.destroy(); } catch {}
    this.listenResolve?.();
    this.listenResolve = null;
  }

  // ========================================================================
  // Outgoing primitives
  // ========================================================================

  async send(chatId: number | string, text: string, opts: SendOpts = {}): Promise<string | null> {
    const channelId = String(chatId);
    const channel = await this.fetchTextChannel(channelId);
    const chunks = splitText((text || '').trim() || '(empty)', DISCORD_MAX);
    let lastId: string | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const payload: any = { content: chunk };
      if (opts.replyTo) payload.reply = { messageReference: String(opts.replyTo), failIfNotExists: false };
      const sent = await channel.send(payload);
      lastId = sent.id;
    }
    return lastId;
  }

  async editMessage(chatId: number | string, msgId: number | string, text: string, _opts?: SendOpts): Promise<void> {
    const trimmed = String(text);
    if (!trimmed.trim()) return;
    const channel = await this.fetchTextChannel(String(chatId));
    const truncated = trimmed.length > DISCORD_MAX ? trimmed.slice(0, DISCORD_MAX) + '\n…(truncated)' : trimmed;
    try {
      const message = await channel.messages.fetch(String(msgId));
      await message.edit({ content: truncated });
    } catch (err) {
      const detail = describeError(err).toLowerCase();
      if (detail.includes('unknown message') || detail.includes('cannot edit')) return;
      throw err;
    }
  }

  async deleteMessage(chatId: number | string, msgId: number | string): Promise<void> {
    try {
      const channel = await this.fetchTextChannel(String(chatId));
      const message = await channel.messages.fetch(String(msgId));
      await message.delete();
    } catch {}
  }

  async sendTyping(chatId: number | string, _opts?: SendOpts): Promise<void> {
    try {
      const channel = await this.fetchTextChannel(String(chatId));
      if (typeof (channel as any).sendTyping === 'function') {
        await (channel as any).sendTyping();
      }
    } catch {}
  }

  // ========================================================================
  // Internal dispatch
  // ========================================================================

  private async dispatchMessage(msg: Message): Promise<void> {
    if (msg.author?.bot) return;
    if (this.botUserId && msg.author?.id === this.botUserId) return;

    const channelId = msg.channelId;
    const messageId = msg.id;
    const userId = msg.author?.id || '';
    if (!channelId || !messageId || !userId) return;

    if (!this.isAllowed(channelId)) return;
    this.knownChats.add(channelId);

    const isDm = msg.channel?.isDMBased?.() ?? false;
    const mentioned = this.botUserId ? msg.mentions?.users?.has(this.botUserId) === true : false;
    if (!isDm && this.requireMention && !mentioned) return;

    let cleaned = String(msg.content || '');
    if (this.botUserId) {
      cleaned = cleaned.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '').trim();
    }

    const ctx: DiscordContext = {
      chatId: channelId,
      messageId,
      from: { userId, username: msg.author?.username || undefined },
      reply: (text, opts) => this.send(channelId, text, { ...opts, replyTo: opts?.replyTo ?? messageId }),
      editReply: (replyMsgId, text, opts) => this.editMessage(channelId, replyMsgId, text, opts),
      channel: this,
      raw: msg,
    };
    const payload: DiscordMessagePayload = { text: cleaned, files: [] };
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

  private async fetchTextChannel(channelId: string): Promise<TextBasedChannel & { send: any; messages: any }> {
    const cached = this.client.channels.cache.get(channelId);
    if (cached && 'send' in cached) return cached as any;
    const fetched = await this.client.channels.fetch(channelId);
    if (!fetched || !('send' in fetched)) {
      throw new Error(`Discord channel ${channelId} is not text-based`);
    }
    return fetched as any;
  }

  private emitError(error: Error) {
    for (const handler of this.errorHandlers) {
      try { handler(error); } catch {}
    }
  }

  private debug(msg: string) { this.log(msg, 'debug'); }
  private log(msg: string, level: LogLevel = 'info') { writeScopedLog('discord', msg, { level }); }
}
