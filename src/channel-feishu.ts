/**
 * Feishu channel — Feishu/Lark Open Platform transport using official SDK.
 *
 * Uses @larksuiteoapi/node-sdk for:
 *   - WSClient + EventDispatcher: WebSocket event receiving with auto-reconnect
 *   - Client.im: message send/edit/delete, image/file upload, resource download
 *   - Automatic tenant_access_token management
 *
 * CardKit streaming APIs (typewriter effect) use Client.request() directly
 * since the SDK doesn't wrap them yet.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import {
  Channel,
  type BotInfo,
  type MenuCommand,
  DEFAULT_CHANNEL_CAPABILITIES,
  type SendOpts,
  sleep,
} from './channel-base.js';
import { createFeishuHttpInstance, createFeishuWsAgent } from './feishu-network.js';

export { FeishuChannel };
export type FeishuCardActionItem = lark.InteractiveCardActionItem;
type FeishuCardTemplate =
  | 'blue'
  | 'wathet'
  | 'turquoise'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'carmine'
  | 'violet'
  | 'purple'
  | 'indigo'
  | 'grey';
export interface FeishuCardActionRow {
  actions: FeishuCardActionItem[];
  layout?: 'bisected' | 'trisection' | 'flow';
}
export interface FeishuCardView {
  markdown: string;
  title?: string;
  template?: FeishuCardTemplate;
  rows?: FeishuCardActionRow[];
}

// ---------------------------------------------------------------------------
// Feishu-specific types
// ---------------------------------------------------------------------------

export interface FeishuMessage {
  text: string;
  files: string[];
}

export interface FeishuFrom {
  openId: string;
  userId?: string;
  name?: string;
}

export interface FeishuContext {
  chatId: string;
  messageId: string;
  from: FeishuFrom;
  chatType: 'p2p' | 'group';
  reply: (text: string, opts?: SendOpts) => Promise<string | null>;
  editReply: (msgId: string, text: string, opts?: SendOpts) => Promise<void>;
  channel: FeishuChannel;
  raw: any;
}

export type FeishuCommandHandler = (cmd: string, args: string, ctx: FeishuContext) => Promise<any> | any;
export type FeishuMessageHandler = (msg: FeishuMessage, ctx: FeishuContext) => Promise<any> | any;
export type FeishuErrorHandler = (err: Error) => void;

export interface FeishuCallbackContext {
  chatId: string;
  messageId: string;
  from: FeishuFrom;
  editReply: (msgId: string, text: string, opts?: SendOpts) => Promise<void>;
  channel: FeishuChannel;
  raw: any;
}

export type FeishuCallbackHandler = (data: string, ctx: FeishuCallbackContext) => Promise<any> | any;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FeishuOpts {
  appId: string;
  appSecret: string;
  /** API base domain. Default: https://open.feishu.cn (Lark: https://open.larksuite.com) */
  domain?: string;
  /** Working directory for temp file downloads. */
  workdir?: string;
  allowedChatIds?: Set<string>;
  /** API request timeout in seconds. */
  apiTimeout?: number;
}

const FEISHU_CARD_MAX = 28_000; // card markdown budget (card JSON limit ~30KB)
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const FEISHU_WS_START_RETRY_MAX_DELAY_MS = 60_000;

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err ?? 'unknown error');
  const parts = [`${err.name}: ${err.message}`];
  for (const key of ['code', 'errno', 'syscall', 'address', 'port', 'host', 'hostname']) {
    const value = (err as any)?.[key];
    if (value != null && value !== '') parts.push(`${key}=${value}`);
  }
  return parts.join(' | ');
}

function isRetryableWsStartError(err: unknown): boolean {
  const text = describeError(err).toLowerCase();
  return [
    'socket hang up',
    'econnreset',
    'etimedout',
    'econnrefused',
    'enotfound',
    'eai_again',
    'fetch failed',
    'timeout',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
  ].some(token => text.includes(token));
}

// ---------------------------------------------------------------------------
// Card builder helper
// ---------------------------------------------------------------------------

function inferActionLayout(actions: FeishuCardActionItem[]): FeishuCardActionRow['layout'] | undefined {
  if (actions.length >= 3) return 'trisection';
  if (actions.length === 2) return 'bisected';
  return undefined;
}

function chunkActionRows(actions: FeishuCardActionItem[], size = 3): FeishuCardActionRow[] {
  const rows: FeishuCardActionRow[] = [];
  for (let i = 0; i < actions.length; i += size) {
    const rowActions = actions.slice(i, i + size).filter(Boolean);
    if (!rowActions.length) continue;
    rows.push({ actions: rowActions, layout: inferActionLayout(rowActions) });
  }
  return rows;
}

function keyboardToRows(keyboard: any): FeishuCardActionRow[] {
  const explicitRows = Array.isArray(keyboard?.rows)
    ? keyboard.rows
      .filter((row: any) => Array.isArray(row?.actions) && row.actions.length)
      .map((row: any) => ({
        actions: row.actions.filter(Boolean),
        layout: row.layout || inferActionLayout(row.actions),
      }))
    : [];
  if (explicitRows.length) return explicitRows;

  const actions = Array.isArray(keyboard?.actions)
    ? keyboard.actions.filter(Boolean)
    : [];
  return chunkActionRows(actions);
}

function buildCardFromView(view: FeishuCardView): lark.InteractiveCard {
  const content = view.markdown.length > FEISHU_CARD_MAX
    ? view.markdown.slice(0, FEISHU_CARD_MAX) + '\n\n...(truncated)'
    : view.markdown;
  const card: lark.InteractiveCard = {
    config: { wide_screen_mode: true, update_multi: true },
    elements: [{ tag: 'markdown', content }],
  };
  if (view.title) {
    card.header = {
      template: view.template || 'blue',
      title: { content: view.title, tag: 'plain_text' },
    };
  }
  for (const row of view.rows || []) {
    const actions = row.actions.filter(Boolean);
    if (!actions.length) continue;
    const element: lark.InterfaceCardActionElement = {
      tag: 'action',
      actions,
    };
    const layout = row.layout || inferActionLayout(actions);
    if (layout) element.layout = layout;
    card.elements!.push(element);
  }
  return card;
}

function buildCard(markdown: string, opts?: { title?: string; template?: FeishuCardTemplate; rows?: FeishuCardActionRow[] }): lark.InteractiveCard {
  return buildCardFromView({
    markdown,
    title: opts?.title,
    template: opts?.template,
    rows: opts?.rows,
  });
}

// ---------------------------------------------------------------------------
// FeishuChannel
// ---------------------------------------------------------------------------

class FeishuChannel extends Channel {
  override readonly capabilities = {
    ...DEFAULT_CHANNEL_CAPABILITIES,
    editMessages: true,
    typingIndicators: false,
    commandMenu: true,
    callbackActions: true,
    messageReactions: false,
    fileUpload: true,
    fileDownload: true,
    threads: false,
  };

  private appId: string;
  private appSecret: string;
  private domain: string;
  private workdir: string;
  private allowedChatIds: Set<string>;

  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private eventDispatcher: lark.EventDispatcher;
  private httpInstance = createFeishuHttpInstance();
  private wsAgent = createFeishuWsAgent();

  private running = false;
  private messageChains = new Map<string, Promise<void>>();

  /** Tracks CardKit streaming cards: messageId → { cardId, sequence } */
  private cardStates = new Map<string, { cardId: string; sequence: number }>();

  /** Maps open_id → chat_id for resolving menu event context. */
  private _openIdToChat = new Map<string, string>();

  private _hCommand: FeishuCommandHandler | null = null;
  private _hMessage: FeishuMessageHandler | null = null;
  private _hCardAction: FeishuCallbackHandler | null = null;
  private _hError: FeishuErrorHandler | null = null;

  readonly knownChats = new Set<string>();

  /** Resolves when wsClient.start() settles (used by listen() to block). */
  private _listenResolve: (() => void) | null = null;

  constructor(opts: FeishuOpts) {
    super();
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.domain = (opts.domain ?? 'https://open.feishu.cn').replace(/\/+$/, '');
    this.workdir = opts.workdir ?? process.cwd();
    this.allowedChatIds = opts.allowedChatIds ?? new Set();

    // Resolve SDK domain enum or custom string
    const sdkDomain = this.domain.includes('larksuite.com')
      ? lark.Domain.Lark
      : this.domain === 'https://open.feishu.cn'
        ? lark.Domain.Feishu
        : this.domain as any;

    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: sdkDomain,
      ...(this.httpInstance ? { httpInstance: this.httpInstance } : {}),
      loggerLevel: lark.LoggerLevel.warn,
    });

    this.eventDispatcher = new lark.EventDispatcher({});
    this._registerEvents();
  }

  // ---- Hook registration ---------------------------------------------------

  onCommand(h: FeishuCommandHandler)   { this._hCommand = h; }
  onMessage(h: FeishuMessageHandler)   { this._hMessage = h; }
  onCallback(h: FeishuCallbackHandler) { this._hCardAction = h; }
  onError(h: FeishuErrorHandler)       { this._hError = h; }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async connect(): Promise<BotInfo> {
    // Get bot info via raw request (SDK doesn't have a dedicated bot info method)
    try {
      const resp = await this.client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        data: {},
      });
      const info = (resp as any)?.bot;
      this.bot = {
        id: info?.open_id || this.appId,
        username: info?.app_name || 'codeclaw',
        displayName: info?.app_name || 'codeclaw',
      };
    } catch {
      this.bot = { id: this.appId, username: 'codeclaw', displayName: 'codeclaw' };
    }
    return this.bot;
  }

  async listen(): Promise<void> {
    this.running = true;

    let retryDelayMs = 3_000;
    while (this.running) {
      const sdkDomain = this.domain.includes('larksuite.com')
        ? lark.Domain.Lark
        : this.domain === 'https://open.feishu.cn'
          ? lark.Domain.Feishu
          : this.domain as any;

      this.wsClient = new lark.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain: sdkDomain,
        ...(this.httpInstance ? { httpInstance: this.httpInstance } : {}),
        ...(this.wsAgent ? { agent: this.wsAgent } : {}),
        loggerLevel: lark.LoggerLevel.warn,
        autoReconnect: true,
      });

      this._log('[ws] starting SDK WSClient...');
      try {
        await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
        this._log('[ws] WSClient started, listening for events');
        break;
      } catch (err) {
        try { this.wsClient.close({ force: true }); } catch {}
        this.wsClient = null;
        if (!this.running) return;
        if (!isRetryableWsStartError(err)) throw err;
        this._log(`[ws] start failed: ${describeError(err)} — retrying in ${Math.ceil(retryDelayMs / 1000)}s`);
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, FEISHU_WS_START_RETRY_MAX_DELAY_MS);
      }
    }

    if (!this.running || !this.wsClient) return;

    // Block until disconnect() is called
    await new Promise<void>(resolve => {
      this._listenResolve = resolve;
      if (!this.running) resolve();
    });
  }

  disconnect(): void {
    this.running = false;
    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch {}
      this.wsClient = null;
    }
    this._listenResolve?.();
    this._listenResolve = null;
  }

  // ========================================================================
  // Event handling (via SDK EventDispatcher)
  // ========================================================================

  private _registerEvents() {
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        try {
          await this._handleMessageEvent(data);
        } catch (e: any) {
          this._log(`[dispatch] error: ${e}`);
          this._hError?.(e instanceof Error ? e : new Error(String(e)));
        }
      },
      'card.action.trigger': (data: any) => {
        void this._dispatchCardAction(data).catch(e => {
          this._log(`[card-action] error: ${e}`);
          this._hError?.(e instanceof Error ? e : new Error(String(e)));
        });
        return {};
      },
      'application.bot.menu_v6': (data: any) => {
        void this._dispatchMenuEvent(data).catch(e => {
          this._log(`[menu] error: ${e}`);
          this._hError?.(e instanceof Error ? e : new Error(String(e)));
        });
      },
    });
  }

  private async _handleMessageEvent(event: any) {
    const msg = event?.message;
    if (!msg) return;

    const chatId = msg.chat_id as string;
    const messageId = msg.message_id as string;
    const chatType: 'p2p' | 'group' = msg.chat_type === 'p2p' ? 'p2p' : 'group';
    const msgType = msg.message_type as string;

    if (!chatId || !messageId) return;
    if (!this._isAllowed(chatId)) { this._log(`[recv] blocked: chat=${chatId} not allowed`); return; }
    this.knownChats.add(chatId);

    const sender = event.sender;
    // Skip messages from the bot itself
    if (sender?.sender_type === 'app') return;

    const from: FeishuFrom = {
      openId: sender?.sender_id?.open_id || '',
      userId: sender?.sender_id?.user_id,
      name: '',
    };

    // Track open_id → chat_id for menu event resolution
    if (from.openId) this._openIdToChat.set(from.openId, chatId);

    const fromDesc = from.userId || from.openId || '?';
    this._log(`[recv] message chat=${chatId} from=${fromDesc} msg_id=${messageId} type=${msgType}`);

    // Group: require @mention
    if (chatType === 'group' && !this._isBotMentioned(msg)) {
      this._log(`[recv] skipped: not mentioned in group ${chatId}`);
      return;
    }

    const ctx = this._makeCtx(chatId, messageId, from, chatType, event);

    // Parse message content
    let text = '';
    const files: string[] = [];

    try {
      const content = JSON.parse(msg.content || '{}');

      if (msgType === 'text') {
        text = this._cleanMention(content.text || '');
      } else if (msgType === 'image') {
        if (content.image_key) {
          try {
            const localPath = await this._downloadResource(messageId, content.image_key, 'image');
            files.push(localPath);
            this._log(`[recv] image saved: ${localPath}`);
          } catch (e: any) { this._log(`[recv] image download failed: ${e}`); }
        }
      } else if (msgType === 'file') {
        if (content.file_key) {
          try {
            const localPath = await this._downloadResource(messageId, content.file_key, 'file', content.file_name);
            files.push(localPath);
            this._log(`[recv] file saved: ${localPath}`);
          } catch (e: any) { this._log(`[recv] file download failed: ${e}`); }
        }
      } else if (msgType === 'post') {
        text = this._cleanMention(this._extractPostText(content));
      } else {
        text = this._cleanMention(content.text || '');
      }
    } catch (e: any) {
      this._log(`[recv] content parse error: ${e.message || e}`);
      return;
    }

    const trimmedText = text.trim();

    // Queue dispatch per chat to preserve ordering
    const key = chatId;
    const prev = this.messageChains.get(key) || Promise.resolve();
    const current = prev.catch(() => {}).then(async () => {
      // Command dispatch
      if (trimmedText.startsWith('/') && this._hCommand) {
        const spaceIdx = trimmedText.indexOf(' ');
        const cmd = (spaceIdx > 0 ? trimmedText.slice(1, spaceIdx) : trimmedText.slice(1)).toLowerCase();
        const args = spaceIdx > 0 ? trimmedText.slice(spaceIdx + 1).trim() : '';
        this._log(`[recv] command /${cmd} args="${args.slice(0, 80)}" chat=${chatId}`);
        await this._hCommand(cmd, args, ctx);
        return;
      }

      // Message dispatch
      if (!this._hMessage) return;
      if (!trimmedText && !files.length) return;
      this._log(`[dispatch] -> onMessage text="${trimmedText.slice(0, 80)}" files=${files.length} chat=${chatId}`);
      await this._hMessage({ text: trimmedText, files }, ctx);
    });
    const settled = current.catch(e => {
      this._log(`[dispatch] handler error: ${e}`);
      this._hError?.(e instanceof Error ? e : new Error(String(e)));
    }).finally(() => {
      if (this.messageChains.get(key) === settled) this.messageChains.delete(key);
    });
    this.messageChains.set(key, settled);
    await settled;
  }

  private async _dispatchCardAction(event: any) {
    const chatId = event.context?.open_chat_id;
    const messageId = event.context?.open_message_id;
    const actionStr = event.action?.value?.action;
    if (!chatId || !actionStr || !this._hCardAction) return;
    if (!this._isAllowed(chatId)) { this._log(`[card-action] blocked: chat=${chatId}`); return; }

    const from: FeishuFrom = {
      openId: event.operator?.open_id || '',
      userId: event.operator?.user_id,
    };
    this._log(`[recv] card_action chat=${chatId} msg=${messageId} action="${actionStr}"`);
    await this._hCardAction(actionStr, {
      chatId,
      messageId,
      from,
      editReply: (msgId, text, opts) => this.editMessage(chatId, msgId, text, opts),
      channel: this,
      raw: event,
    });
  }

  private async _dispatchMenuEvent(event: any) {
    const eventKey = event.event_key;
    const openId = event.operator?.operator_id?.open_id;
    if (!eventKey || !openId || !this._hCommand) return;

    const chatId = this._openIdToChat.get(openId);
    if (!chatId) {
      this._log(`[menu] no chat_id for open_id=${openId}, event_key=${eventKey}`);
      return;
    }
    if (!this._isAllowed(chatId)) return;

    this._log(`[recv] menu event_key=${eventKey} open_id=${openId} chat=${chatId}`);
    const from: FeishuFrom = { openId, userId: event.operator?.operator_id?.user_id };
    const ctx = this._makeCtx(chatId, '', from, 'p2p', event);
    await this._hCommand(eventKey, '', ctx);
  }

  // ========================================================================
  // Outgoing primitives (Channel interface)
  // ========================================================================

  override async setMenu(commands: MenuCommand[]) {
    this._log(`[menu] ${commands.length} commands. Configure in Feishu Developer Console → Bot → Custom Menu:`);
    for (const c of commands) {
      this._log(`[menu]   event_key="${c.command}"  name="${c.description}"`);
    }
  }

  override async clearMenu() {
    this._log(`[menu] cleared (remove items in Feishu Developer Console)`);
  }

  async sendCard(chatId: number | string, view: FeishuCardView): Promise<string | null> {
    const card = buildCardFromView(view);
    this._logOutgoing('send', `chat=${chatId} chars=${view.markdown.length} rows=${view.rows?.length || 0}`);
    const resp = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: String(chatId),
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    return resp?.data?.message_id ?? null;
  }

  async send(chatId: number | string, text: string, opts: SendOpts = {}): Promise<string | null> {
    const rows = keyboardToRows(opts.keyboard);
    return await this.sendCard(chatId, {
      markdown: text.trim() || '(empty)',
      rows,
    });
  }

  async editCard(chatId: number | string, msgId: number | string, view: FeishuCardView): Promise<void> {
    if (!view.markdown.trim()) return;

    const cardState = this.cardStates.get(String(msgId));
    if (cardState) {
      await this.editMessage(chatId, msgId, view.markdown, { keyboard: { rows: view.rows || [] } });
      return;
    }

    const card = buildCardFromView(view);
    this._logOutgoing('edit', `chat=${chatId} msg_id=${msgId} chars=${view.markdown.length} rows=${view.rows?.length || 0}`);
    try {
      await this.client.im.message.patch({
        path: { message_id: String(msgId) },
        data: { content: JSON.stringify(card) },
      });
    } catch (e: any) {
      const msg = String(e?.message || e).toLowerCase();
      if (msg.includes('not modified') || msg.includes('edit is not allowed')) return;
      throw e;
    }
  }

  async editMessage(chatId: number | string, msgId: number | string, text: string, opts: SendOpts = {}): Promise<void> {
    if (!text.trim()) return;

    // If this message has a CardKit streaming card, push content via CardKit API
    const cardState = this.cardStates.get(String(msgId));
    if (cardState) {
      cardState.sequence++;
      const content = text.length > FEISHU_CARD_MAX ? text.slice(-FEISHU_CARD_MAX) : text;
      this._logOutgoing('stream-push', `card=${cardState.cardId} seq=${cardState.sequence} chars=${content.length}`);
      try {
        await this.client.request({
          method: 'PUT',
          url: `/open-apis/cardkit/v1/cards/${cardState.cardId}/elements/content/content`,
          data: { content, sequence: cardState.sequence },
        });
      } catch (e: any) {
        this._log(`[edit] CardKit push error: ${e?.message || e}`);
      }
      return;
    }

    // Fallback: regular PATCH for non-streaming cards
    const rows = keyboardToRows(opts.keyboard);
    await this.editCard(chatId, msgId, {
      markdown: text,
      rows,
    });
  }

  async deleteMessage(_chatId: number | string, msgId: number | string): Promise<void> {
    try {
      await this.client.im.message.delete({
        path: { message_id: String(msgId) },
      });
    } catch {}
  }

  async sendTyping(_chatId: number | string): Promise<void> {
    // Feishu has no typing indicator API — no-op
  }

  // ========================================================================
  // Streaming cards (CardKit v1) — typewriter effect
  // ========================================================================

  /**
   * Create a streaming card entity and send it as a message.
   * Returns the messageId (for session tracking) or null on failure.
   *
   * While streaming is active, `editMessage()` transparently pushes content
   * via the CardKit API instead of PATCH. Call `endStreaming()` to finalize.
   */
  async sendStreamingCard(chatId: string, initialContent: string): Promise<string | null> {
    const cardData = {
      schema: '2.0',
      config: {
        streaming_mode: true,
        summary: { content: '[Generating...]' },
        streaming_config: {
          print_frequency_ms: { default: 30 },
          print_step: { default: 3 },
        },
      },
      body: {
        elements: [
          { tag: 'markdown', content: initialContent || 'Thinking...', element_id: 'content' },
        ],
      },
    };

    // Step 1: Create card entity via CardKit
    let cardId: string;
    try {
      const createResp: any = await this.client.request({
        method: 'POST',
        url: '/open-apis/cardkit/v1/cards',
        data: {
          type: 'card_json',
          data: JSON.stringify(cardData),
        },
      });
      cardId = createResp?.data?.card_id;
      if (!cardId) throw new Error('no card_id returned');
    } catch (e: any) {
      this._log(`[streaming] CardKit create failed: ${e?.message || e}, falling back to regular card`);
      return this.send(chatId, initialContent);
    }

    // Step 2: Send card as message
    try {
      this._logOutgoing('sendStreamingCard', `chat=${chatId} card=${cardId}`);
      const sendResp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        },
      });
      const messageId = sendResp?.data?.message_id;
      if (!messageId) throw new Error('no message_id returned');

      // Track streaming state — editMessage() will use CardKit for this messageId
      this.cardStates.set(messageId, { cardId, sequence: 1 });
      return messageId;
    } catch (e: any) {
      this._log(`[streaming] send card message failed: ${e?.message || e}`);
      return this.send(chatId, initialContent);
    }
  }

  /**
   * End streaming mode on a card and finalize it.
   * After this, `editMessage()` falls through to the regular PATCH path.
   */
  async endStreaming(messageId: string, summary?: string): Promise<void> {
    const state = this.cardStates.get(messageId);
    if (!state) return;

    state.sequence++;
    const settings = {
      config: {
        streaming_mode: false,
        summary: { content: summary || 'Response complete.' },
      },
    };

    this._logOutgoing('endStreaming', `card=${state.cardId} seq=${state.sequence}`);
    try {
      await this.client.request({
        method: 'PATCH',
        url: `/open-apis/cardkit/v1/cards/${state.cardId}/settings`,
        data: {
          settings: JSON.stringify(settings),
          sequence: state.sequence,
        },
      });
    } catch (e: any) {
      this._log(`[streaming] end streaming error: ${e?.message || e}`);
    }

    // Remove tracking — subsequent editMessage calls use regular PATCH
    this.cardStates.delete(messageId);
  }

  // ========================================================================
  // Feishu-specific outgoing
  // ========================================================================

  /** Send a text message (not card). For simple notifications. */
  async sendText(chatId: string, text: string): Promise<string | null> {
    const resp = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    return resp?.data?.message_id ?? null;
  }

  /** Upload an image and return the image_key. */
  async uploadImage(imageBuffer: Buffer): Promise<string> {
    this._logOutgoing('uploadImage', `bytes=${imageBuffer.byteLength}`);
    const resp = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image: imageBuffer,
      },
    });
    const imageKey = (resp as any)?.image_key ?? (resp as any)?.data?.image_key;
    if (!imageKey) throw new Error('Image upload failed: no image_key returned');
    return imageKey;
  }

  /** Upload a file and return the file_key. */
  async uploadFile(fileBuffer: Buffer, fileName: string): Promise<string> {
    const ext = path.extname(fileName).toLowerCase().slice(1);
    const fileType = (['pdf', 'doc', 'xls', 'ppt'].includes(ext) ? ext : 'stream') as any;

    this._logOutgoing('uploadFile', `file=${fileName} bytes=${fileBuffer.byteLength}`);
    const resp = await this.client.im.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: fileBuffer,
      },
    });
    const fileKey = (resp as any)?.file_key ?? (resp as any)?.data?.file_key;
    if (!fileKey) throw new Error('File upload failed: no file_key returned');
    return fileKey;
  }

  /** Upload and send a local file. */
  async sendFile(
    chatId: number | string,
    filePath: string,
    opts: { caption?: string; replyTo?: number | string; asPhoto?: boolean } = {},
  ): Promise<string | null> {
    const content = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const isPhoto = opts.asPhoto ?? PHOTO_EXTS.has(path.extname(filename).toLowerCase());

    if (isPhoto) {
      const imageKey = await this.uploadImage(content);
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: String(chatId),
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });
      return resp?.data?.message_id ?? null;
    }

    const fileKey = await this.uploadFile(content, filename);
    const resp = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: String(chatId),
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
    return resp?.data?.message_id ?? null;
  }

  // ========================================================================
  // Download resources from received messages
  // ========================================================================

  private async _downloadResource(messageId: string, fileKey: string, type: string, filename?: string): Promise<string> {
    const resp = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });

    const ext = type === 'image' ? '.jpg' : (filename ? path.extname(filename) : '.bin');
    const name = filename || `feishu_${fileKey.slice(-8)}${ext}`;
    const localPath = path.join(this.workdir, `_feishu_${name}`);
    fs.mkdirSync(this.workdir, { recursive: true });

    await (resp as any).writeFile(localPath);
    return localPath;
  }

  // ========================================================================
  // Internal helpers
  // ========================================================================

  private _makeCtx(chatId: string, messageId: string, from: FeishuFrom, chatType: 'p2p' | 'group', raw: any): FeishuContext {
    return {
      chatId,
      messageId,
      from,
      chatType,
      reply: (text: string, opts?: SendOpts) => this.send(chatId, text, opts),
      editReply: (msgId: string, text: string, opts?: SendOpts) => this.editMessage(chatId, msgId, text, opts),
      channel: this,
      raw,
    };
  }

  private _isAllowed(chatId: string): boolean {
    return this.allowedChatIds.size === 0 || this.allowedChatIds.has(chatId);
  }

  private _isBotMentioned(msg: any): boolean {
    const mentions: any[] = msg.mentions || [];
    if (!this.bot) return mentions.length > 0;
    return mentions.some((m: any) => {
      const mentionId = m.id?.open_id || m.id?.app_id || '';
      return mentionId === this.bot!.id || m.name === this.bot!.displayName;
    });
  }

  private _cleanMention(text: string): string {
    return text.replace(/@_user_\d+/g, '').trim();
  }

  /** Extract plain text from a rich text (post) message content. */
  private _extractPostText(content: any): string {
    const post = content.zh_cn || content.en_us || content;
    const parts: string[] = [];
    if (post.title) parts.push(post.title);
    const paragraphs: any[][] = post.content || [];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      const line = paragraph
        .map((elem: any) => {
          if (elem.tag === 'text') return elem.text || '';
          if (elem.tag === 'a') return elem.text || elem.href || '';
          if (elem.tag === 'at') return '';
          return '';
        })
        .join('');
      if (line.trim()) parts.push(line);
    }
    return parts.join('\n');
  }

  _log(msg: string) {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`[feishu ${ts}] ${msg}\n`);
  }

  private _logOutgoing(action: string, meta: string) {
    this._log(`[send] ${action} ${meta}`);
  }
}
