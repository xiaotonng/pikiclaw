/**
 * Channel credential validation for Telegram, Feishu, and WeChat.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { validateTelegramToken, type TelegramBotIdentity } from '../../cli/setup-wizard.js';
import type { ChannelSetupState } from '../../cli/onboarding.js';
import type { UserConfig } from './user-config.js';
import { VALIDATION_TIMEOUTS } from '../constants.js';
import { writeScopedLog } from '../logging.js';
import { normalizeWeixinBaseUrl, weixinGetUpdates } from '../../channels/weixin/api.js';

export interface TelegramConfigCheckResult {
  state: ChannelSetupState;
  bot: TelegramBotIdentity | null;
  normalizedAllowedChatIds: string;
}

export interface FeishuAppIdentity {
  appId: string;
  displayName: string | null;
}

export interface FeishuConfigCheckResult {
  state: ChannelSetupState;
  app: FeishuAppIdentity | null;
}

export interface WeixinConfigIdentity {
  accountId: string;
  baseUrl: string;
}

export interface WeixinConfigCheckResult {
  state: ChannelSetupState;
  account: WeixinConfigIdentity | null;
  normalizedBaseUrl: string;
}

export interface SlackBotIdentity {
  userId: string;
  team: string | null;
  username: string | null;
}

export interface SlackConfigCheckResult {
  state: ChannelSetupState;
  bot: SlackBotIdentity | null;
}

export interface DiscordBotIdentity {
  userId: string;
  username: string;
  applicationId: string | null;
}

export interface DiscordConfigCheckResult {
  state: ChannelSetupState;
  bot: DiscordBotIdentity | null;
}

export interface DingtalkAppIdentity {
  clientId: string;
}

export interface DingtalkConfigCheckResult {
  state: ChannelSetupState;
  app: DingtalkAppIdentity | null;
}

export interface WecomBotIdentity {
  botId: string;
}

export interface WecomConfigCheckResult {
  state: ChannelSetupState;
  bot: WecomBotIdentity | null;
}

interface FeishuValidationOptions {
  timeoutMs?: number;
}

const DEFAULT_FEISHU_VALIDATION_TIMEOUT_MS = VALIDATION_TIMEOUTS.feishuDefault;
const DEFAULT_WEIXIN_VALIDATION_TIMEOUT_MS = VALIDATION_TIMEOUTS.weixinDefault;
const DEFAULT_SLACK_VALIDATION_TIMEOUT_MS = VALIDATION_TIMEOUTS.slackDefault;
const DEFAULT_DISCORD_VALIDATION_TIMEOUT_MS = VALIDATION_TIMEOUTS.discordDefault;
const DEFAULT_DINGTALK_VALIDATION_TIMEOUT_MS = VALIDATION_TIMEOUTS.dingtalkDefault;
const DEFAULT_WECOM_VALIDATION_TIMEOUT_MS = VALIDATION_TIMEOUTS.wecomDefault;

function feishuValidationLog(appId: string, message: string): void {
  writeScopedLog('feishu-validate', `app=${appId} ${message}`, { level: 'debug' });
}

function maskAppId(appId: string): string {
  if (!appId) return '(missing)';
  if (appId.length <= 10) return appId;
  return `${appId.slice(0, 6)}...${appId.slice(-4)}`;
}

class ValidationTimeoutError extends Error {
  constructor(service: string, timeoutMs: number) {
    super(`${service} request timed out after ${timeoutMs}ms.`);
    this.name = 'ValidationTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, service: string, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      reject(new ValidationTimeoutError(service, timeoutMs));
    }, timeoutMs);

    promise
      .then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function missingChannelState(channel: ChannelSetupState['channel'], detail: string): ChannelSetupState {
  return {
    channel,
    configured: false,
    ready: false,
    validated: false,
    status: 'missing',
    detail,
  };
}

function invalidChannelState(channel: ChannelSetupState['channel'], detail: string): ChannelSetupState {
  return {
    channel,
    configured: true,
    ready: false,
    validated: true,
    status: 'invalid',
    detail,
  };
}

function errorChannelState(channel: ChannelSetupState['channel'], detail: string): ChannelSetupState {
  return {
    channel,
    configured: true,
    ready: false,
    validated: true,
    status: 'error',
    detail,
  };
}

function readyChannelState(channel: ChannelSetupState['channel'], detail: string): ChannelSetupState {
  return {
    channel,
    configured: true,
    ready: true,
    validated: true,
    status: 'ready',
    detail,
  };
}

export function normalizeTelegramAllowedChatIds(raw: string | null | undefined): {
  ok: boolean;
  normalized: string;
  ids: number[];
  error: string | null;
} {
  const value = String(raw || '').trim();
  if (!value) return { ok: true, normalized: '', ids: [], error: null };

  const seen = new Set<number>();
  const ids: number[] = [];
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!/^-?\d+$/.test(trimmed)) {
      return {
        ok: false,
        normalized: value,
        ids: [],
        error: 'Allowed Chat IDs must be comma-separated numeric chat IDs.',
      };
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) {
      return {
        ok: false,
        normalized: value,
        ids: [],
        error: 'Allowed Chat IDs contains a value outside the safe integer range.',
      };
    }
    if (seen.has(parsed)) continue;
    seen.add(parsed);
    ids.push(parsed);
  }

  return {
    ok: true,
    normalized: ids.join(','),
    ids,
    error: null,
  };
}

function isTelegramNetworkError(error: string | null | undefined): boolean {
  const detail = String(error || '');
  return detail.startsWith('Failed to reach Telegram:') || detail.startsWith('Telegram returned invalid JSON');
}

export async function validateTelegramConfig(
  token: string | null | undefined,
  allowedChatIds?: string | null,
): Promise<TelegramConfigCheckResult> {
  const trimmedToken = String(token || '').trim();
  if (!trimmedToken) {
    return {
      state: missingChannelState('telegram', 'Telegram bot token is not configured.'),
      bot: null,
      normalizedAllowedChatIds: '',
    };
  }

  const ids = normalizeTelegramAllowedChatIds(allowedChatIds);
  if (!ids.ok) {
    return {
      state: invalidChannelState('telegram', ids.error || 'Allowed Chat IDs is invalid.'),
      bot: null,
      normalizedAllowedChatIds: ids.normalized,
    };
  }

  const tokenCheck = await validateTelegramToken(trimmedToken);
  if (!tokenCheck.ok) {
    return {
      state: (isTelegramNetworkError(tokenCheck.error)
        ? errorChannelState('telegram', tokenCheck.error || 'Telegram validation failed.')
        : invalidChannelState('telegram', tokenCheck.error || 'Telegram validation failed.')),
      bot: null,
      normalizedAllowedChatIds: ids.normalized,
    };
  }

  const identity = tokenCheck.bot?.username
    ? `@${tokenCheck.bot.username}${tokenCheck.bot?.displayName ? ` (${tokenCheck.bot.displayName})` : ''}`
    : 'Telegram bot verified.';
  return {
    state: readyChannelState('telegram', identity),
    bot: tokenCheck.bot,
    normalizedAllowedChatIds: ids.normalized,
  };
}

export async function validateFeishuConfig(
  appId: string | null | undefined,
  appSecret: string | null | undefined,
  options: FeishuValidationOptions = {},
): Promise<FeishuConfigCheckResult> {
  const trimmedAppId = String(appId || '').trim();
  const trimmedSecret = String(appSecret || '').trim();
  const appLabel = maskAppId(trimmedAppId);
  const apiDomain = String(process.env.FEISHU_DOMAIN || 'https://open.feishu.cn').trim().replace(/\/+$/, '');
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Math.round(Number(options.timeoutMs))
    : DEFAULT_FEISHU_VALIDATION_TIMEOUT_MS;
  if (!trimmedAppId && !trimmedSecret) {
    return {
      state: missingChannelState('feishu', 'Feishu credentials are not configured.'),
      app: null,
    };
  }
  if (!trimmedAppId || !trimmedSecret) {
    return {
      state: invalidChannelState('feishu', 'Both App ID and App Secret are required.'),
      app: null,
    };
  }

  try {
    const startedAt = Date.now();
    feishuValidationLog(appLabel, `start domain=${apiDomain} timeoutMs=${timeoutMs}`);
    const sdkDomain = apiDomain.includes('larksuite.com')
      ? lark.Domain.Lark
      : apiDomain === 'https://open.feishu.cn'
        ? lark.Domain.Feishu
        : apiDomain as any;
    const client = new lark.Client({
      appId: trimmedAppId,
      appSecret: trimmedSecret,
      domain: sdkDomain,
      loggerLevel: lark.LoggerLevel.warn,
    });
    const parsed: any = await withTimeout(client.auth.tenantAccessToken.internal({
      data: { app_id: trimmedAppId, app_secret: trimmedSecret },
    }), timeoutMs, 'Feishu validation');
    feishuValidationLog(
      appLabel,
      `response code=${String(parsed?.code ?? '')} hasToken=${typeof parsed?.tenant_access_token === 'string'} elapsedMs=${Date.now() - startedAt}`,
    );

    if (parsed?.code !== 0 || typeof parsed?.tenant_access_token !== 'string' || !parsed.tenant_access_token) {
      const detail = typeof parsed?.msg === 'string' && parsed.msg.trim() ? parsed.msg.trim() : 'credentials rejected';
      feishuValidationLog(appLabel, `rejected code=${String(parsed?.code ?? '')} detail=${detail} elapsedMs=${Date.now() - startedAt}`);
      return {
        state: invalidChannelState('feishu', `Feishu rejected these credentials: ${detail}`),
        app: null,
      };
    }

    // Try to fetch bot display name using the tenant access token
    let botDisplayName: string | null = null;
    try {
      const botResp: any = await withTimeout(
        fetch(`${apiDomain}/open-apis/bot/v3/info`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${parsed.tenant_access_token}` },
        }).then(r => r.json()),
        VALIDATION_TIMEOUTS.feishuBotInfo,
        'Feishu bot info',
      );
      if (botResp?.bot?.app_name) {
        botDisplayName = botResp.bot.app_name;
      }
    } catch {
      // Non-critical — proceed without bot name
    }

    const app = { appId: trimmedAppId, displayName: botDisplayName };
    const identity = botDisplayName
      ? `${botDisplayName} (${appLabel})`
      : `App ${appLabel} verified.`;
    feishuValidationLog(appLabel, `verified botName=${botDisplayName ?? '(unknown)'} elapsedMs=${Date.now() - startedAt}`);
    return {
      state: readyChannelState('feishu', identity),
      app,
    };
  } catch (err) {
    feishuValidationLog(appLabel, `error ${(err instanceof Error ? err.message : String(err ?? 'unknown error'))}`);
    if (err instanceof ValidationTimeoutError) {
      return {
        state: errorChannelState('feishu', `Failed to reach Feishu: ${err.message}`),
        app: null,
      };
    }
    const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
    return {
      state: errorChannelState('feishu', `Failed to reach Feishu: ${message}`),
      app: null,
    };
  }
}

export async function validateWeixinConfig(
  baseUrl: string | null | undefined,
  botToken: string | null | undefined,
  accountId: string | null | undefined,
  options: { timeoutMs?: number } = {},
): Promise<WeixinConfigCheckResult> {
  const normalizedBaseUrl = normalizeWeixinBaseUrl(baseUrl);
  const trimmedToken = String(botToken || '').trim();
  const trimmedAccountId = String(accountId || '').trim();
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Math.round(Number(options.timeoutMs))
    : DEFAULT_WEIXIN_VALIDATION_TIMEOUT_MS;

  if (!trimmedToken && !trimmedAccountId && !String(baseUrl || '').trim()) {
    return {
      state: missingChannelState('weixin', 'Weixin is not configured.'),
      account: null,
      normalizedBaseUrl,
    };
  }
  if (!trimmedToken || !trimmedAccountId) {
    return {
      state: invalidChannelState('weixin', 'Weixin requires Base URL, Bot Token, and Account ID.'),
      account: null,
      normalizedBaseUrl,
    };
  }

  try {
    const response = await weixinGetUpdates({
      baseUrl: normalizedBaseUrl,
      token: trimmedToken,
      getUpdatesBuf: '',
      timeoutMs,
    });
    if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
      const detail = String(response.errmsg || response.errcode || 'credentials rejected').trim();
      return {
        state: invalidChannelState('weixin', `Weixin rejected these credentials: ${detail}`),
        account: null,
        normalizedBaseUrl,
      };
    }
    return {
      state: readyChannelState('weixin', `Weixin account ${trimmedAccountId} verified.`),
      account: {
        accountId: trimmedAccountId,
        baseUrl: normalizedBaseUrl,
      },
      normalizedBaseUrl,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    return {
      state: errorChannelState('weixin', `Failed to reach Weixin: ${message}`),
      account: null,
      normalizedBaseUrl,
    };
  }
}

export async function validateSlackConfig(
  botToken: string | null | undefined,
  appToken: string | null | undefined,
  options: { timeoutMs?: number } = {},
): Promise<SlackConfigCheckResult> {
  const trimmedBot = String(botToken || '').trim();
  const trimmedApp = String(appToken || '').trim();
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Math.round(Number(options.timeoutMs))
    : DEFAULT_SLACK_VALIDATION_TIMEOUT_MS;

  if (!trimmedBot && !trimmedApp) {
    return {
      state: missingChannelState('slack', 'Slack credentials are not configured.'),
      bot: null,
    };
  }
  if (!trimmedBot || !trimmedApp) {
    return {
      state: invalidChannelState('slack', 'Slack requires both Bot Token (xoxb-) and App-Level Token (xapp-).'),
      bot: null,
    };
  }
  if (!trimmedBot.startsWith('xoxb-')) {
    return {
      state: invalidChannelState('slack', 'Slack Bot Token must start with "xoxb-".'),
      bot: null,
    };
  }
  if (!trimmedApp.startsWith('xapp-')) {
    return {
      state: invalidChannelState('slack', 'Slack App-Level Token must start with "xapp-".'),
      bot: null,
    };
  }

  try {
    const data: any = await withTimeout(
      fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${trimmedBot}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: '',
      }).then(r => r.json()),
      timeoutMs,
      'Slack auth.test',
    );
    if (!data?.ok) {
      const detail = String(data?.error || 'credentials rejected');
      return {
        state: invalidChannelState('slack', `Slack rejected these credentials: ${detail}`),
        bot: null,
      };
    }
    const bot: SlackBotIdentity = {
      userId: String(data.user_id || ''),
      team: data.team ? String(data.team) : null,
      username: data.user ? String(data.user) : null,
    };
    const identity = bot.username
      ? `@${bot.username}${bot.team ? ` (${bot.team})` : ''}`
      : `Slack bot ${bot.userId} verified.`;
    return { state: readyChannelState('slack', identity), bot };
  } catch (err) {
    if (err instanceof ValidationTimeoutError) {
      return { state: errorChannelState('slack', `Failed to reach Slack: ${err.message}`), bot: null };
    }
    return {
      state: errorChannelState('slack', `Failed to reach Slack: ${err instanceof Error ? err.message : String(err)}`),
      bot: null,
    };
  }
}

export async function validateDiscordConfig(
  botToken: string | null | undefined,
  options: { timeoutMs?: number } = {},
): Promise<DiscordConfigCheckResult> {
  const trimmed = String(botToken || '').trim();
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Math.round(Number(options.timeoutMs))
    : DEFAULT_DISCORD_VALIDATION_TIMEOUT_MS;

  if (!trimmed) {
    return {
      state: missingChannelState('discord', 'Discord bot token is not configured.'),
      bot: null,
    };
  }

  try {
    const resp: any = await withTimeout(
      fetch('https://discord.com/api/v10/users/@me', {
        method: 'GET',
        headers: { Authorization: `Bot ${trimmed}` },
      }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) })),
      timeoutMs,
      'Discord users/@me',
    );
    if (resp.status !== 200) {
      const detail = resp.body?.message || `HTTP ${resp.status}`;
      return {
        state: invalidChannelState('discord', `Discord rejected this token: ${detail}`),
        bot: null,
      };
    }
    const body = resp.body || {};
    const bot: DiscordBotIdentity = {
      userId: String(body.id || ''),
      username: String(body.username || ''),
      applicationId: body.application_id ? String(body.application_id) : null,
    };
    const identity = bot.username
      ? `@${bot.username}${bot.userId ? ` (id=${bot.userId.slice(-6)})` : ''}`
      : 'Discord bot verified.';
    return { state: readyChannelState('discord', identity), bot };
  } catch (err) {
    if (err instanceof ValidationTimeoutError) {
      return { state: errorChannelState('discord', `Failed to reach Discord: ${err.message}`), bot: null };
    }
    return {
      state: errorChannelState('discord', `Failed to reach Discord: ${err instanceof Error ? err.message : String(err)}`),
      bot: null,
    };
  }
}

export async function validateDingtalkConfig(
  clientId: string | null | undefined,
  clientSecret: string | null | undefined,
  options: { timeoutMs?: number } = {},
): Promise<DingtalkConfigCheckResult> {
  const trimmedId = String(clientId || '').trim();
  const trimmedSecret = String(clientSecret || '').trim();
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Math.round(Number(options.timeoutMs))
    : DEFAULT_DINGTALK_VALIDATION_TIMEOUT_MS;

  if (!trimmedId && !trimmedSecret) {
    return {
      state: missingChannelState('dingtalk', 'DingTalk credentials are not configured.'),
      app: null,
    };
  }
  if (!trimmedId || !trimmedSecret) {
    return {
      state: invalidChannelState('dingtalk', 'DingTalk requires both Client ID (AppKey) and Client Secret (AppSecret).'),
      app: null,
    };
  }

  try {
    const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(trimmedId)}&appsecret=${encodeURIComponent(trimmedSecret)}`;
    const data: any = await withTimeout(
      fetch(url, { method: 'GET' }).then(r => r.json()),
      timeoutMs,
      'DingTalk gettoken',
    );
    if (typeof data?.errcode === 'number' && data.errcode !== 0) {
      const detail = String(data.errmsg || 'credentials rejected');
      return {
        state: invalidChannelState('dingtalk', `DingTalk rejected these credentials: ${detail}`),
        app: null,
      };
    }
    if (!data?.access_token) {
      return {
        state: invalidChannelState('dingtalk', 'DingTalk did not return an access token.'),
        app: null,
      };
    }
    const masked = trimmedId.length > 12
      ? `${trimmedId.slice(0, 6)}...${trimmedId.slice(-4)}`
      : trimmedId;
    return {
      state: readyChannelState('dingtalk', `DingTalk app ${masked} verified.`),
      app: { clientId: trimmedId },
    };
  } catch (err) {
    if (err instanceof ValidationTimeoutError) {
      return { state: errorChannelState('dingtalk', `Failed to reach DingTalk: ${err.message}`), app: null };
    }
    return {
      state: errorChannelState('dingtalk', `Failed to reach DingTalk: ${err instanceof Error ? err.message : String(err)}`),
      app: null,
    };
  }
}

export async function validateWecomConfig(
  botId: string | null | undefined,
  botSecret: string | null | undefined,
  _options: { timeoutMs?: number } = {},
): Promise<WecomConfigCheckResult> {
  const trimmedId = String(botId || '').trim();
  const trimmedSecret = String(botSecret || '').trim();

  if (!trimmedId && !trimmedSecret) {
    return {
      state: missingChannelState('wecom', 'WeChat Work credentials are not configured.'),
      bot: null,
    };
  }
  if (!trimmedId || !trimmedSecret) {
    return {
      state: invalidChannelState('wecom', 'WeChat Work requires both Bot ID and Bot Secret.'),
      bot: null,
    };
  }

  // The Smart Bot WS endpoint cannot be probed via a simple HTTP request;
  // we accept the configured credentials and let the websocket subscribe ack
  // surface real auth errors at runtime. A non-empty pair already covers the
  // most common configuration mistake.
  return {
    state: readyChannelState('wecom', `WeChat Work bot ${trimmedId} configured.`),
    bot: { botId: trimmedId },
  };
}

export async function collectChannelSetupStates(config: Partial<UserConfig>): Promise<ChannelSetupState[]> {
  const [telegram, feishu, weixin, slack, discord, dingtalk, wecom] = await Promise.all([
    validateTelegramConfig(config.telegramBotToken, config.telegramAllowedChatIds),
    validateFeishuConfig(config.feishuAppId, config.feishuAppSecret),
    validateWeixinConfig(config.weixinBaseUrl, config.weixinBotToken, config.weixinAccountId),
    validateSlackConfig(config.slackBotToken, config.slackAppToken),
    validateDiscordConfig(config.discordBotToken),
    validateDingtalkConfig(config.dingtalkClientId, config.dingtalkClientSecret),
    validateWecomConfig(config.wecomBotId, config.wecomBotSecret),
  ]);

  return [
    weixin.state,
    telegram.state,
    feishu.state,
    slack.state,
    discord.state,
    dingtalk.state,
    wecom.state,
  ];
}
