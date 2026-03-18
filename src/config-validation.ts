import * as lark from '@larksuiteoapi/node-sdk';
import { validateTelegramToken, type TelegramBotIdentity } from './setup-wizard.js';
import type { ChannelSetupState } from './onboarding.js';
import type { UserConfig } from './user-config.js';
import { VALIDATION_TIMEOUTS } from './constants.js';

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

interface FeishuValidationOptions {
  timeoutMs?: number;
}

const DEFAULT_FEISHU_VALIDATION_TIMEOUT_MS = VALIDATION_TIMEOUTS.feishuDefault;

function feishuValidationLog(appId: string, message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[feishu-validate ${ts}] app=${appId} ${message}\n`);
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

export async function collectChannelSetupStates(config: Partial<UserConfig>): Promise<ChannelSetupState[]> {
  const [telegram, feishu] = await Promise.all([
    validateTelegramConfig(config.telegramBotToken, config.telegramAllowedChatIds),
    validateFeishuConfig(config.feishuAppId, config.feishuAppSecret),
  ]);

  return [
    telegram.state,
    feishu.state,
  ];
}
