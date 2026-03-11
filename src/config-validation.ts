import { validateTelegramToken, type TelegramBotIdentity } from './setup-wizard.js';
import type { ChannelSetupState } from './onboarding.js';
import type { UserConfig } from './user-config.js';
import { feishuApiDomain, feishuNoProxyEnabled, withFeishuDirectFetch } from './feishu-network.js';

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

const DEFAULT_FEISHU_VALIDATION_TIMEOUT_MS = 15_000;

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
  const apiDomain = feishuApiDomain();
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
    const controller = new AbortController();
    feishuValidationLog(appLabel, `start domain=${apiDomain} timeoutMs=${timeoutMs} direct=${feishuNoProxyEnabled()}`);
    const resp = await withTimeout(fetch(`${apiDomain}/open-apis/auth/v3/tenant_access_token/internal`, withFeishuDirectFetch({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: trimmedAppId, app_secret: trimmedSecret }),
      signal: controller.signal,
    })), timeoutMs, 'Feishu validation', () => controller.abort());
    feishuValidationLog(appLabel, `response status=${resp.status} ok=${resp.ok} elapsedMs=${Date.now() - startedAt}`);
    const raw = await withTimeout(resp.text(), Math.min(timeoutMs, 4_000), 'Feishu validation response', () => controller.abort());
    feishuValidationLog(appLabel, `body bytes=${raw.length} elapsedMs=${Date.now() - startedAt}`);
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      feishuValidationLog(appLabel, `invalid-json status=${resp.status} elapsedMs=${Date.now() - startedAt}`);
      return {
        state: errorChannelState('feishu', `Feishu returned invalid JSON (HTTP ${resp.status}).`),
        app: null,
      };
    }

    if (!resp.ok) {
      const detail = typeof parsed?.msg === 'string' ? parsed.msg : `HTTP ${resp.status}`;
      feishuValidationLog(appLabel, `http-error detail=${detail} elapsedMs=${Date.now() - startedAt}`);
      return {
        state: errorChannelState('feishu', `Feishu validation failed: ${detail}`),
        app: null,
      };
    }

    if (parsed?.code !== 0 || typeof parsed?.tenant_access_token !== 'string' || !parsed.tenant_access_token) {
      const detail = typeof parsed?.msg === 'string' && parsed.msg.trim() ? parsed.msg.trim() : 'credentials rejected';
      feishuValidationLog(appLabel, `rejected code=${String(parsed?.code ?? '')} detail=${detail} elapsedMs=${Date.now() - startedAt}`);
      return {
        state: invalidChannelState('feishu', `Feishu rejected these credentials: ${detail}`),
        app: null,
      };
    }

    const app = { appId: trimmedAppId, displayName: null };
    feishuValidationLog(appLabel, `verified elapsedMs=${Date.now() - startedAt}`);
    return {
      state: readyChannelState('feishu', `App ${trimmedAppId} verified.`),
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
