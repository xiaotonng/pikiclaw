import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { VALIDATION_TIMEOUTS, WEIXIN_LIMITS } from './constants.js';

export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const WEIXIN_QR_LOGIN_TTL_MS = 5 * 60_000;
const WEIXIN_DEFAULT_BOT_TYPE = '3';
const WEIXIN_QR_CONTENT_CHECK_TIMEOUT_MS = 5_000;

export const WeixinMessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const WeixinMessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const WeixinMessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const WeixinTypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

export interface WeixinTextItem {
  text?: string;
}

export interface WeixinVoiceItem {
  text?: string;
}

export interface WeixinMessageItem {
  type?: number;
  text_item?: WeixinTextItem;
  voice_item?: WeixinVoiceItem;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

export interface WeixinGetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WeixinGetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface WeixinQrStartResult {
  ok: boolean;
  sessionKey: string;
  qrcodeUrl?: string;
  message: string;
  error?: string;
}

export interface WeixinQrWaitResult {
  ok: boolean;
  connected: boolean;
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error';
  message: string;
  qrcodeUrl?: string;
  botToken?: string;
  accountId?: string;
  userId?: string;
  baseUrl?: string;
  error?: string;
}

interface WeixinQrCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

interface WeixinQrStatusResponse {
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
}

interface ActiveWeixinQrLogin {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
}

const activeWeixinQrLogins = new Map<string, ActiveWeixinQrLogin>();

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function withTimeoutSignal(timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function buildWeixinHeaders(body: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'unknown error');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function normalizeFetchBaseUrl(baseUrl: string | null | undefined): string {
  const trimmed = String(baseUrl || '').trim();
  return (trimmed || WEIXIN_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isImageDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function normalizeEncodedImageDataUrl(value: string): string | null {
  const trimmed = String(value || '').trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  if (isImageDataUrl(trimmed)) return trimmed;
  if (trimmed.startsWith('iVBORw0KGgo')) return `data:image/png;base64,${trimmed}`;
  if (trimmed.startsWith('/9j/')) return `data:image/jpeg;base64,${trimmed}`;
  if (trimmed.startsWith('R0lGOD')) return `data:image/gif;base64,${trimmed}`;
  if (trimmed.startsWith('UklGR')) return `data:image/webp;base64,${trimmed}`;
  if (trimmed.startsWith('PHN2Zy') || trimmed.startsWith('PD94bWwg')) return `data:image/svg+xml;base64,${trimmed}`;
  return null;
}

async function probeRemoteContentType(url: string, timeoutMs: number): Promise<string> {
  const headTimeout = withTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: headTimeout.signal,
    });
    if (response.ok) {
      const contentType = String(response.headers.get('content-type') || '').trim();
      if (contentType) return contentType;
    }
  } catch {}
  finally {
    headTimeout.dispose();
  }

  const getTimeout = withTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal: getTimeout.signal,
    });
    const contentType = String(response.headers.get('content-type') || '').trim();
    void response.body?.cancel().catch(() => {});
    return contentType;
  } catch {
    return '';
  } finally {
    getTimeout.dispose();
  }
}

async function buildQrDataUrl(content: string): Promise<string> {
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
  });
}

export function normalizeWeixinBaseUrl(baseUrl: string | null | undefined): string {
  return normalizeFetchBaseUrl(baseUrl);
}

export async function resolveWeixinQrDisplayUrl(qrcodeImgContent: string): Promise<string> {
  const trimmed = String(qrcodeImgContent || '').trim();
  if (!trimmed) throw new Error('Missing QR code image content.');

  const embeddedImage = normalizeEncodedImageDataUrl(trimmed);
  if (embeddedImage) return embeddedImage;

  if (isHttpUrl(trimmed)) {
    const contentType = await probeRemoteContentType(trimmed, WEIXIN_QR_CONTENT_CHECK_TIMEOUT_MS);
    if (/^image\//i.test(contentType)) return trimmed;
    return buildQrDataUrl(trimmed);
  }

  return buildQrDataUrl(trimmed);
}

async function parseJsonResponse<T>(response: Response, label: string): Promise<T> {
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: HTTP ${response.status} ${response.statusText || ''}`.trim());
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${describeError(error)}`);
  }
}

async function weixinPostJson<T>(params: {
  baseUrl: string;
  endpoint: string;
  body: Record<string, unknown>;
  token?: string;
  timeoutMs: number;
  label: string;
}): Promise<T> {
  const url = new URL(params.endpoint, `${normalizeFetchBaseUrl(params.baseUrl)}/`);
  const body = JSON.stringify(params.body);
  const timeout = withTimeoutSignal(params.timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: buildWeixinHeaders(body, params.token),
      body,
      signal: timeout.signal,
    });
    return await parseJsonResponse<T>(response, params.label);
  } finally {
    timeout.dispose();
  }
}

async function weixinGetJson<T>(params: {
  url: string;
  timeoutMs: number;
  label: string;
  headers?: Record<string, string>;
}): Promise<T> {
  const timeout = withTimeoutSignal(params.timeoutMs);
  try {
    const response = await fetch(params.url, {
      method: 'GET',
      headers: params.headers,
      signal: timeout.signal,
    });
    return await parseJsonResponse<T>(response, params.label);
  } finally {
    timeout.dispose();
  }
}

function purgeExpiredWeixinQrLogins() {
  const now = Date.now();
  for (const [sessionKey, login] of activeWeixinQrLogins) {
    if (now - login.startedAt >= WEIXIN_QR_LOGIN_TTL_MS) activeWeixinQrLogins.delete(sessionKey);
  }
}

function buildSendMessageBody(toUserId: string, text: string, contextToken?: string) {
  return {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: crypto.randomUUID(),
      message_type: WeixinMessageType.BOT,
      message_state: WeixinMessageState.FINISH,
      item_list: text
        ? [{ type: WeixinMessageItemType.TEXT, text_item: { text } }]
        : undefined,
      context_token: contextToken || undefined,
    },
    base_info: {},
  };
}

export async function weixinGetUpdates(params: {
  baseUrl: string;
  token: string;
  getUpdatesBuf?: string;
  timeoutMs?: number;
}): Promise<WeixinGetUpdatesResp> {
  const timeoutMs = params.timeoutMs ?? WEIXIN_LIMITS.longPollTimeout;
  try {
    return await weixinPostJson<WeixinGetUpdatesResp>({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: {
        get_updates_buf: params.getUpdatesBuf ?? '',
        base_info: {},
      },
      token: params.token,
      timeoutMs,
      label: 'weixin getupdates',
    });
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: params.getUpdatesBuf ?? '',
      };
    }
    throw error;
  }
}

export async function weixinSendTextMessage(params: {
  baseUrl: string;
  token: string;
  toUserId: string;
  text: string;
  contextToken?: string;
  timeoutMs?: number;
}): Promise<void> {
  await weixinPostJson({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: buildSendMessageBody(params.toUserId, params.text, params.contextToken),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 15_000,
    label: 'weixin sendmessage',
  });
}

export async function weixinGetConfig(params: {
  baseUrl: string;
  token: string;
  userId: string;
  contextToken?: string;
  timeoutMs?: number;
}): Promise<WeixinGetConfigResp> {
  return weixinPostJson<WeixinGetConfigResp>({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: {
      ilink_user_id: params.userId,
      context_token: params.contextToken || undefined,
      base_info: {},
    },
    token: params.token,
    timeoutMs: params.timeoutMs ?? 10_000,
    label: 'weixin getconfig',
  });
}

export async function weixinSendTyping(params: {
  baseUrl: string;
  token: string;
  userId: string;
  typingTicket: string;
  status?: number;
  timeoutMs?: number;
}): Promise<void> {
  await weixinPostJson({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: {
      ilink_user_id: params.userId,
      typing_ticket: params.typingTicket,
      status: params.status ?? WeixinTypingStatus.TYPING,
      base_info: {},
    },
    token: params.token,
    timeoutMs: params.timeoutMs ?? 10_000,
    label: 'weixin sendtyping',
  });
}

export function extractWeixinTextBody(message: WeixinMessage): string {
  const items = message.item_list || [];
  for (const item of items) {
    if (item.type === WeixinMessageItemType.TEXT && item.text_item?.text) {
      return String(item.text_item.text);
    }
    if (item.type === WeixinMessageItemType.VOICE && item.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  return '';
}

export function markdownToWeixinPlainText(text: string): string {
  let result = String(text || '');
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  result = result.replace(/^\|[\s:|-]+\|$/gm, '');
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) => inner.split('|').map(cell => cell.trim()).join('  '));
  result = result.replace(/[*_~`>#-]/g, match => (match === '-' ? '-' : ''));
  return result.replace(/\r\n?/g, '\n').trim();
}

function buildQrUrl(baseUrl: string, botType: string): string {
  return new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, `${normalizeFetchBaseUrl(baseUrl)}/`).toString();
}

function buildQrStatusUrl(baseUrl: string, qrcode: string): string {
  return new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, `${normalizeFetchBaseUrl(baseUrl)}/`).toString();
}

async function fetchWeixinQrCode(baseUrl: string, botType: string): Promise<WeixinQrCodeResponse> {
  return weixinGetJson<WeixinQrCodeResponse>({
    url: buildQrUrl(baseUrl, botType),
    timeoutMs: VALIDATION_TIMEOUTS.weixinDefault,
    label: 'weixin get_bot_qrcode',
  });
}

async function fetchWeixinQrStatus(baseUrl: string, qrcode: string, timeoutMs: number): Promise<WeixinQrStatusResponse> {
  try {
    return await weixinGetJson<WeixinQrStatusResponse>({
      url: buildQrStatusUrl(baseUrl, qrcode),
      timeoutMs,
      label: 'weixin get_qrcode_status',
      headers: {
        'iLink-App-ClientVersion': '1',
      },
    });
  } catch (error) {
    if (isAbortError(error)) return { status: 'wait' };
    throw error;
  }
}

export async function startWeixinQrLogin(params: {
  baseUrl?: string;
  sessionKey?: string;
  botType?: string;
} = {}): Promise<WeixinQrStartResult> {
  purgeExpiredWeixinQrLogins();
  const sessionKey = String(params.sessionKey || crypto.randomUUID());
  const baseUrl = normalizeFetchBaseUrl(params.baseUrl);
  const existing = activeWeixinQrLogins.get(sessionKey);
  if (existing) {
    return {
      ok: true,
      sessionKey,
      qrcodeUrl: existing.qrcodeUrl,
      message: '二维码已生成，请使用微信扫描。',
    };
  }

  try {
    const qr = await fetchWeixinQrCode(baseUrl, params.botType || WEIXIN_DEFAULT_BOT_TYPE);
    if (!qr.qrcode || !qr.qrcode_img_content) {
      return {
        ok: false,
        sessionKey,
        message: '微信未返回二维码数据。',
        error: 'Missing QR code payload.',
      };
    }
    const qrcodeUrl = await resolveWeixinQrDisplayUrl(qr.qrcode_img_content);
    activeWeixinQrLogins.set(sessionKey, {
      sessionKey,
      qrcode: qr.qrcode,
      qrcodeUrl,
      startedAt: Date.now(),
    });
    return {
      ok: true,
      sessionKey,
      qrcodeUrl,
      message: '二维码已生成，请使用微信扫描。',
    };
  } catch (error) {
    return {
      ok: false,
      sessionKey,
      message: '生成微信二维码失败。',
      error: describeError(error),
    };
  }
}

export async function waitForWeixinQrLogin(params: {
  baseUrl?: string;
  sessionKey: string;
  timeoutMs?: number;
  botType?: string;
}): Promise<WeixinQrWaitResult> {
  purgeExpiredWeixinQrLogins();
  const baseUrl = normalizeFetchBaseUrl(params.baseUrl);
  const login = activeWeixinQrLogins.get(params.sessionKey);
  if (!login) {
    return {
      ok: false,
      connected: false,
      status: 'error',
      message: '当前没有进行中的微信扫码会话，请重新生成二维码。',
      error: 'QR session not found.',
    };
  }

  if (Date.now() - login.startedAt >= WEIXIN_QR_LOGIN_TTL_MS) {
    activeWeixinQrLogins.delete(params.sessionKey);
    return {
      ok: false,
      connected: false,
      status: 'expired',
      message: '二维码已过期，请重新生成。',
      qrcodeUrl: login.qrcodeUrl,
      error: 'QR session expired.',
    };
  }

  try {
    const status = await fetchWeixinQrStatus(
      baseUrl,
      login.qrcode,
      Math.max(1_000, params.timeoutMs ?? VALIDATION_TIMEOUTS.weixinQrPoll),
    );
    switch (status.status) {
      case 'confirmed':
        activeWeixinQrLogins.delete(params.sessionKey);
        if (!status.bot_token || !status.ilink_bot_id) {
          return {
            ok: false,
            connected: false,
            status: 'error',
            message: '微信登录已确认，但返回数据不完整。',
            error: 'Missing bot token or account id.',
          };
        }
        return {
          ok: true,
          connected: true,
          status: 'confirmed',
          message: '微信连接成功。',
          botToken: status.bot_token,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          baseUrl: normalizeFetchBaseUrl(status.baseurl || baseUrl),
        };
      case 'expired': {
        const refreshed = await fetchWeixinQrCode(baseUrl, params.botType || WEIXIN_DEFAULT_BOT_TYPE);
        if (refreshed.qrcode && refreshed.qrcode_img_content) {
          const qrcodeUrl = await resolveWeixinQrDisplayUrl(refreshed.qrcode_img_content);
          activeWeixinQrLogins.set(params.sessionKey, {
            sessionKey: params.sessionKey,
            qrcode: refreshed.qrcode,
            qrcodeUrl,
            startedAt: Date.now(),
          });
          return {
            ok: true,
            connected: false,
            status: 'expired',
            message: '二维码已刷新，请重新扫码。',
            qrcodeUrl,
          };
        }
        return {
          ok: false,
          connected: false,
          status: 'expired',
          message: '二维码已过期，请重新生成。',
          qrcodeUrl: login.qrcodeUrl,
          error: 'Failed to refresh QR code.',
        };
      }
      case 'scaned':
        return {
          ok: true,
          connected: false,
          status: 'scaned',
          message: '已扫码，请在微信里确认。',
          qrcodeUrl: login.qrcodeUrl,
        };
      case 'wait':
      default:
        return {
          ok: true,
          connected: false,
          status: 'wait',
          message: '等待扫码中。',
          qrcodeUrl: login.qrcodeUrl,
        };
    }
  } catch (error) {
    activeWeixinQrLogins.delete(params.sessionKey);
    return {
      ok: false,
      connected: false,
      status: 'error',
      message: '微信扫码登录失败。',
      error: describeError(error),
    };
  }
}
