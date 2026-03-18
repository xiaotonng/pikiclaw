/**
 * Feishu channel — Feishu/Lark Open Platform transport using official SDK.
 *
 * Uses @larksuiteoapi/node-sdk for:
 *   - WSClient + EventDispatcher: WebSocket event receiving with auto-reconnect
 *   - Client.im: message send/edit/delete, image/file upload, resource download
 *   - Automatic tenant_access_token management
 *
 * CardKit streaming APIs (typewriter effect) use the SDK's cardkit.v1 wrappers
 * and degrade to regular interactive cards when the tenant/app cannot use them.
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
import { adaptMarkdownForFeishu } from './bot-feishu-render.js';
import { FEISHU_LIMITS } from './constants.js';

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
export type FeishuRecallHandler = (messageId: string, chatId: string, raw: any) => Promise<any> | any;

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

const FEISHU_CARD_MAX = FEISHU_LIMITS.cardMax;
const FILE_MAX_BYTES = FEISHU_LIMITS.fileMaxBytes;
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const FEISHU_WS_START_RETRY_MAX_DELAY_MS = FEISHU_LIMITS.wsStartRetryMaxDelay;

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err ?? 'unknown error');
  const parts = [`${err.name}: ${err.message}`];
  for (const key of ['code', 'errno', 'syscall', 'address', 'port', 'host', 'hostname']) {
    const value = (err as any)?.[key];
    if (value != null && value !== '') parts.push(`${key}=${value}`);
  }
  return parts.join(' | ');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function describeFeishuApiError(err: unknown): string {
  const base = describeError(err);
  const method = String((err as any)?.config?.method || '').toUpperCase();
  const url = String((err as any)?.config?.url || '').trim();
  const response = (err as any)?.response?.data;
  const parts = [base];
  if (method || url) parts.push(`request=${[method, url].filter(Boolean).join(' ')}`);
  if (response != null) parts.push(`response=${safeJson(response)}`);
  return parts.join(' | ');
}

function isCardKitCapabilityError(err: unknown): boolean {
  const text = describeFeishuApiError(err).toLowerCase();
  return [
    'status code 400',
    'permission',
    'scope',
    'forbidden',
    'unsupported',
    'not support',
    'cardkit',
    'streaming',
  ].some(token => text.includes(token));
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

function isRetryableUploadError(err: unknown): boolean {
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
    'temporarily unavailable',
    'internal server error',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
  ].some(token => text.includes(token));
}

function requireMessageId(resp: any, action: string): string {
  const messageId = resp?.data?.message_id;
  if (messageId) return String(messageId);
  const code = resp?.code;
  const msg = resp?.msg || resp?.message || 'no message_id returned';
  throw new Error(`${action} failed: code=${code ?? '?'} msg=${msg}`);
}

function buildPostContent(paragraphs: Array<Array<Record<string, unknown>>>, title = ''): string {
  return JSON.stringify({
    zh_cn: {
      title,
      content: paragraphs,
    },
  });
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
  const adapted = adaptMarkdownForFeishu(view.markdown);
  const content = adapted.length > FEISHU_CARD_MAX
    ? adapted.slice(0, FEISHU_CARD_MAX) + '\n\n...(truncated)'
    : adapted;
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

function buildCardKitMarkdownData(markdown: string, opts?: { clearStreamingStatus?: boolean }): string {
  const adapted = adaptMarkdownForFeishu(markdown);
  const content = adapted.length > FEISHU_CARD_MAX
    ? `${adapted.slice(0, FEISHU_CARD_MAX)}\n\n...(truncated)`
    : adapted;
  const elements = opts?.clearStreamingStatus
    ? [
        { tag: 'markdown', content: '', element_id: 'status' },
        { tag: 'markdown', content, element_id: 'content' },
      ]
    : [
        { tag: 'markdown', content },
      ];
  return JSON.stringify({
    schema: '2.0',
    body: {
      elements,
    },
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
    messageReactions: true,
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

  private running = false;
  private messageChains = new Map<string, Promise<void>>();

  /** Tracks CardKit-backed cards: messageId → { cardId, sequence, lastContent, streaming } */
  private cardStates = new Map<string, { cardId: string; sequence: number; lastContent: string; streaming: boolean }>();

  /** Maps open_id → chat_id for resolving menu event context. */
  private _openIdToChat = new Map<string, string>();

  /** Disable CardKit after tenant/app-level failures to avoid repeated 400s. */
  private cardKitEnabled = true;

  private _hCommand: FeishuCommandHandler | null = null;
  private _hMessage: FeishuMessageHandler | null = null;
  private _hCardAction: FeishuCallbackHandler | null = null;
  private _hRecall: FeishuRecallHandler | null = null;
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
      loggerLevel: lark.LoggerLevel.warn,
    });

    this.eventDispatcher = new lark.EventDispatcher({});
    this._registerEvents();
  }

  // ---- Hook registration ---------------------------------------------------

  onCommand(h: FeishuCommandHandler)   { this._hCommand = h; }
  onMessage(h: FeishuMessageHandler)   { this._hMessage = h; }
  onCallback(h: FeishuCallbackHandler) { this._hCardAction = h; }
  onMessageRecalled(h: FeishuRecallHandler) { this._hRecall = h; }
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
        username: info?.app_name || 'pikiclaw',
        displayName: info?.app_name || 'pikiclaw',
      };
    } catch {
      this.bot = { id: this.appId, username: 'pikiclaw', displayName: 'pikiclaw' };
    }
    return this.bot;
  }

  async listen(): Promise<void> {
    this.running = true;

    let retryDelayMs = FEISHU_LIMITS.wsStartRetryInitialDelay;
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
      'im.message.recalled_v1': (data: any) => {
        void this._dispatchMessageRecalled(data).catch(e => {
          this._log(`[message-recalled] error: ${e}`);
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
          } catch (e: any) { this._log(`[recv] image download failed: ${e}`); }
        }
      } else if (msgType === 'file') {
        if (content.file_key) {
          try {
            const localPath = await this._downloadResource(messageId, content.file_key, 'file', content.file_name);
            files.push(localPath);
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
        await this._hCommand(cmd, args, ctx);
        return;
      }

      // Message dispatch
      if (!this._hMessage) return;
      if (!trimmedText && !files.length) return;
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

    // Try: event payload → cache → API resolve
    const chatId = this._openIdToChat.get(openId)
      ?? await this._resolveP2pChatId(openId);
    if (!chatId) {
      this._log(`[menu] cannot resolve chat_id for open_id=${openId}, event_key=${eventKey}`);
      return;
    }
    if (!this._isAllowed(chatId)) return;

    this._log(`[recv] menu event_key=${eventKey} open_id=${openId} chat=${chatId}`);
    const from: FeishuFrom = { openId, userId: event.operator?.operator_id?.user_id };
    const ctx = this._makeCtx(chatId, '', from, 'p2p', event);
    await this._hCommand(eventKey, '', ctx);
  }

  private async _dispatchMessageRecalled(event: any) {
    const chatId = String(event?.chat_id || '').trim();
    const messageId = String(event?.message_id || '').trim();
    if (!chatId || !messageId || !this._hRecall) return;
    if (!this._isAllowed(chatId)) { this._log(`[message-recalled] blocked: chat=${chatId}`); return; }
    this.knownChats.add(chatId);
    this._log(`[recv] message_recalled chat=${chatId} msg=${messageId}`);
    await this._hRecall(messageId, chatId, event);
  }

  /**
   * Resolve a p2p chat_id for a given open_id by sending a minimal message
   * via open_id and extracting the chat_id from the API response.
   */
  private async _resolveP2pChatId(openId: string): Promise<string | null> {
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text: '...' }),
        },
      });
      const chatId = (resp?.data as any)?.chat_id ?? null;
      const msgId = resp?.data?.message_id;
      // Clean up the placeholder message
      if (msgId) {
        try { await this.client.im.message.delete({ path: { message_id: msgId } }); } catch {}
      }
      if (chatId) {
        this._openIdToChat.set(openId, chatId);
        this.knownChats.add(chatId);
        this._log(`[menu] resolved chat_id=${chatId} for open_id=${openId}`);
      }
      return chatId;
    } catch (e: any) {
      this._log(`[menu] resolve chat_id failed for open_id=${openId}: ${e?.message || e}`);
      return null;
    }
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
    return requireMessageId(resp, 'send interactive card');
  }

  async send(chatId: number | string, text: string, opts: SendOpts = {}): Promise<string | null> {
    const rows = keyboardToRows(opts.keyboard);
    const view: FeishuCardView = { markdown: text.trim() || '(empty)', rows };

    // Reply to a specific message if replyTo is set
    if (opts.replyTo) {
      return await this.replyCard(String(opts.replyTo), view);
    }

    return await this.sendCard(chatId, view);
  }

  async replyCard(replyToMsgId: string, view: FeishuCardView): Promise<string | null> {
    const card = buildCardFromView(view);
    this._logOutgoing('reply', `reply_to=${replyToMsgId} chars=${view.markdown.length} rows=${view.rows?.length || 0}`);
    const resp = await this.client.im.message.reply({
      path: { message_id: replyToMsgId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    return requireMessageId(resp, 'reply interactive card');
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

    const cardState = this.cardStates.get(String(msgId));
    if (cardState?.streaming) {
      if (cardState.lastContent && !text.startsWith(cardState.lastContent)) {
        this._log(`[edit] CardKit preview lost append-only shape for msg=${msgId}; switching to regular card edits`);
        await this.replaceStreamingCardWithRegularCard(chatId, msgId, text, opts, 'Streaming preview stabilized.');
        return;
      } else if (text.length > FEISHU_CARD_MAX) {
        this._log(`[edit] CardKit preview length cap reached for msg=${msgId}; switching to regular card edits`);
        await this.replaceStreamingCardWithRegularCard(chatId, msgId, text, opts, 'Preview truncated.');
        return;
      } else {
        cardState.sequence++;
        cardState.lastContent = text;
        this._logOutgoing('stream-push', `card=${cardState.cardId} seq=${cardState.sequence} chars=${text.length}`);
        try {
          await this.client.cardkit.v1.cardElement.content({
            path: { card_id: cardState.cardId, element_id: 'content' },
            data: { content: text, sequence: cardState.sequence },
          });
        } catch (e: any) {
          if (isCardKitCapabilityError(e)) this.disableCardKit(describeFeishuApiError(e));
          this._log(`[edit] CardKit push error: ${describeFeishuApiError(e)}`);
        }
        return;
      }
    }
    if (cardState) {
      await this.updateCardKitMessage(String(msgId), text);
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
    this.cardStates.delete(String(msgId));
    try {
      await this.client.im.message.delete({
        path: { message_id: String(msgId) },
      });
    } catch {}
  }

  async sendTyping(_chatId: number | string): Promise<void> {
    // Feishu has no typing indicator API — no-op
  }

  async setMessageReaction(_chatId: number | string, msgId: number | string, reactions: string[]): Promise<void> {
    const messageId = String(msgId || '').trim();
    const emojiTypes = [...new Set(reactions.map(reaction => String(reaction || '').trim()).filter(Boolean))];
    if (!messageId || !emojiTypes.length) return;

    this._logOutgoing('setReaction', `msg_id=${messageId} reactions=${emojiTypes.join(',')}`);
    for (const emojiType of emojiTypes) {
      await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }).catch(() => {});
    }
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
  async sendStreamingCard(chatId: string, initialContent: string, opts?: { replyTo?: string; keyboard?: any }): Promise<string | null> {
    const sendRegularCard = (text: string) => {
      const markdown = text || 'Generating...';
      const rows = keyboardToRows(opts?.keyboard);
      return opts?.replyTo
        ? this.replyCard(opts.replyTo, { markdown, rows })
        : this.send(chatId, markdown, { keyboard: opts?.keyboard });
    };

    if (!this.cardKitEnabled) {
      return sendRegularCard(initialContent);
    }

    const rows = keyboardToRows(opts?.keyboard);
    const elements: any[] = [
      { tag: 'markdown', content: initialContent || 'Generating...', element_id: 'status' },
      { tag: 'markdown', content: '', element_id: 'content' },
    ];
    for (const row of rows) {
      const actions = row.actions.filter(Boolean);
      if (!actions.length) continue;
      const element: any = { tag: 'action', actions };
      const layout = row.layout || inferActionLayout(actions);
      if (layout) element.layout = layout;
      elements.push(element);
    }

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
        elements,
      },
    };

    // Step 1: Create card entity via CardKit
    let cardId: string;
    try {
      const createResp = await this.client.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(cardData),
        },
      });
      const nextCardId = createResp?.data?.card_id;
      if (!nextCardId) throw new Error('no card_id returned');
      cardId = nextCardId;
    } catch (e: any) {
      if (isCardKitCapabilityError(e)) this.disableCardKit(describeFeishuApiError(e));
      this._log(`[streaming] CardKit create failed: ${describeFeishuApiError(e)}, falling back to regular card`);
      return sendRegularCard(initialContent);
    }

    // Step 2: Send card as message (reply to user's message if replyTo is set)
    const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
    try {
      this._logOutgoing('sendStreamingCard', `chat=${chatId} card=${cardId}${opts?.replyTo ? ` reply_to=${opts.replyTo}` : ''}`);
      let sendResp: any;
      if (opts?.replyTo) {
        sendResp = await this.client.im.message.reply({
          path: { message_id: opts.replyTo },
          data: { msg_type: 'interactive', content: cardContent },
        });
      } else {
        sendResp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: cardContent },
        });
      }
      const messageId = sendResp?.data?.message_id;
      if (!messageId) throw new Error('no message_id returned');

      // Track streaming state — editMessage() will use CardKit for this messageId
      this.cardStates.set(messageId, { cardId, sequence: 1, lastContent: '', streaming: true });
      return messageId;
    } catch (e: any) {
      this._log(`[streaming] send card message failed: ${e?.message || e}`);
      return sendRegularCard(initialContent);
    }
  }

  /** Check if a message is currently a streaming card (CardKit v2). */
  isStreamingCard(messageId: string): boolean {
    return this.cardStates.get(messageId)?.streaming === true;
  }

  /**
   * End streaming mode on a CardKit card.
   * Subsequent edits may continue through CardKit full-card updates or switch
   * to regular message patching, depending on the fallback path.
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
      await this.client.cardkit.v1.card.settings({
        path: { card_id: state.cardId },
        data: {
          settings: JSON.stringify(settings),
          sequence: state.sequence,
        },
      });
    } catch (e: any) {
      if (isCardKitCapabilityError(e)) this.disableCardKit(describeFeishuApiError(e));
      this._log(`[streaming] end streaming error: ${describeFeishuApiError(e)}`);
    }
    state.streaming = false;
    state.lastContent = '';
  }

  private async replaceStreamingCardWithRegularCard(
    chatId: number | string,
    msgId: number | string,
    text: string,
    opts: SendOpts,
    summary: string,
  ): Promise<void> {
    await this.endStreaming(String(msgId), summary);

    const rows = keyboardToRows(opts.keyboard);
    const card = buildCardFromView({ markdown: text, rows });
    this._logOutgoing('edit', `chat=${chatId} msg_id=${msgId} chars=${text.length} rows=${rows.length}`);
    try {
      await this.client.im.message.patch({
        path: { message_id: String(msgId) },
        data: { content: JSON.stringify(card) },
      });
      this.cardStates.delete(String(msgId));
    } catch (e: any) {
      const msg = String(e?.message || e).toLowerCase();
      if (msg.includes('not modified') || msg.includes('edit is not allowed')) {
        this.cardStates.delete(String(msgId));
        return;
      }
      throw e;
    }
  }

  private async updateCardKitMessage(messageId: string, text: string): Promise<void> {
    const state = this.cardStates.get(messageId);
    if (!state) throw new Error(`CardKit state missing for message ${messageId}`);

    state.sequence++;
    state.lastContent = text;
    this._logOutgoing('card-update', `card=${state.cardId} seq=${state.sequence} chars=${text.length}`);
    try {
      await this.client.cardkit.v1.card.update({
        path: { card_id: state.cardId },
        data: {
          card: {
            type: 'card_json',
            data: buildCardKitMarkdownData(text, { clearStreamingStatus: true }),
          },
          sequence: state.sequence,
        },
      });
    } catch (e: any) {
      if (isCardKitCapabilityError(e)) this.disableCardKit(describeFeishuApiError(e));
      throw e;
    }
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
    return requireMessageId(resp, 'send text');
  }

  async sendPost(chatId: string, content: string, opts: { replyTo?: number | string } = {}): Promise<string | null> {
    const replyTo = opts.replyTo ? String(opts.replyTo) : undefined;
    this._logOutgoing('sendPost', `${replyTo ? `reply_to=${replyTo}` : `chat=${chatId}`} chars=${content.length}`);
    const resp = replyTo
      ? await this.client.im.message.reply({
        path: { message_id: replyTo },
        data: { msg_type: 'post', content },
      })
      : await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'post', content },
      });
    return requireMessageId(resp, 'send post');
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
    const stat = fs.statSync(filePath);
    if (stat.size > FILE_MAX_BYTES) {
      throw new Error(`file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${FILE_MAX_BYTES / 1024 / 1024}MB)`);
    }
    const content = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const isPhoto = opts.asPhoto ?? PHOTO_EXTS.has(path.extname(filename).toLowerCase());
    const caption = typeof opts.caption === 'string' ? opts.caption.trim() : '';
    const replyTo = opts.replyTo ? String(opts.replyTo) : undefined;

    if (isPhoto) {
      try {
        const imageKey = await this.uploadImage(content);
        if (caption) {
          return await this.sendPost(String(chatId), buildPostContent([
            [{ tag: 'img', image_key: imageKey }],
            [{ tag: 'text', text: caption }],
          ]), { replyTo });
        }
        const msgContent = JSON.stringify({ image_key: imageKey });
        this._logOutgoing('sendImage', `${replyTo ? `reply_to=${replyTo}` : `chat=${chatId}`} file=${filename}`);
        const resp = replyTo
          ? await this.client.im.message.reply({ path: { message_id: replyTo }, data: { msg_type: 'image', content: msgContent } })
          : await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: String(chatId), msg_type: 'image', content: msgContent } });
        return requireMessageId(resp, 'send image');
      } catch (err) {
        if (isRetryableUploadError(err)) throw err;
      }
    }

    const fileKey = await this.uploadFile(content, filename);
    const msgContent = JSON.stringify({ file_key: fileKey });
    this._logOutgoing('sendFile', `${replyTo ? `reply_to=${replyTo}` : `chat=${chatId}`} file=${filename}`);
    const resp = replyTo
      ? await this.client.im.message.reply({ path: { message_id: replyTo }, data: { msg_type: 'file', content: msgContent } })
      : await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: String(chatId), msg_type: 'file', content: msgContent } });
    return requireMessageId(resp, 'send file');
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

    // Check downloaded file size
    const stat = fs.statSync(localPath);
    if (stat.size > FILE_MAX_BYTES) {
      fs.rmSync(localPath, { force: true });
      throw new Error(`file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${FILE_MAX_BYTES / 1024 / 1024}MB)`);
    }

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
      reply: (text: string, opts?: SendOpts) => this.send(chatId, text, { ...opts, replyTo: messageId || opts?.replyTo }),
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
    void action;
    void meta;
  }

  private disableCardKit(reason: string) {
    if (!this.cardKitEnabled) return;
    this.cardKitEnabled = false;
    this._log(`[streaming] CardKit disabled for this process: ${reason}`);
  }
}
