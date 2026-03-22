import type {
  AgentStatusResponse,
  AppState,
  BrowserSetupResponse,
  BrowserStatusResponse,
  HostInfo,
  LsDirResult,
  PermissionRequestResult,
  SessionTailMessage,
  SessionsPageResult,
  WeixinLoginStartResult,
  WeixinLoginWaitResult,
  WeixinValidationResult,
} from './types';

export interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function forwardAbort(source: AbortSignal | null | undefined, controller: AbortController): () => void {
  if (!source) return () => {};
  const abort = () => controller.abort((source as AbortSignal & { reason?: unknown }).reason);
  if (source.aborted) {
    abort();
    return () => {};
  }
  source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

async function json<T>(url: string, opts: ApiRequestOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = opts;
  const controller = new AbortController();
  const cleanupAbort = forwardAbort(signal, controller);
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const raw = await res.text();
    if (!raw) throw new Error(`Empty response (${res.status})`);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`Invalid server response (${res.status})`);
    }
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    if (err instanceof Error) throw err;
    throw new Error(String(err ?? 'Request failed'));
  } finally {
    clearTimeout(timer);
    cleanupAbort();
  }
}

function post<T>(url: string, body: unknown, opts: ApiRequestOptions = {}): Promise<T> {
  return json<T>(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const api = {
  getState: () => json<AppState>('/api/state'),
  getHost: () => json<HostInfo>('/api/host'),
  getAgentStatus: () => json<AgentStatusResponse>('/api/agent-status'),
  getSessions: () => json<Record<string, { sessions: unknown[] }>>('/api/sessions'),
  getSessionsPage: (agent: string, page = 0, limit = 6, opts: ApiRequestOptions = {}) =>
    json<SessionsPageResult>(
      `/api/sessions/${agent}?page=${page}&limit=${limit}`,
      opts,
    ),
  getSessionDetail: (agent: string, sessionId: string, limit = 8, opts: ApiRequestOptions = {}) =>
    json<{ ok: boolean; messages?: SessionTailMessage[]; error?: string }>(
      `/api/session-detail/${agent}/${encodeURIComponent(sessionId)}?limit=${limit}`,
      opts,
    ),
  installAgent: (agent: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; error?: string } & AgentStatusResponse>(
      '/api/agent-install',
      { agent },
      { timeoutMs: 600_000, ...opts },
    ),
  updateRuntimeAgent: (patch: Record<string, unknown>) =>
    post<{ ok: boolean; error?: string } & AgentStatusResponse>('/api/runtime-agent', patch),
  saveConfig: (patch: Record<string, unknown>) => post<{ ok: boolean; configPath?: string }>('/api/config', patch),
  validateTelegramConfig: (token: string, allowedChatIds = '', opts?: ApiRequestOptions) =>
    post<{ ok: boolean; error?: string | null; bot?: { username: string; displayName?: string }; normalizedAllowedChatIds?: string }>(
      '/api/validate-telegram-token',
      { token, allowedChatIds },
      opts,
    ),
  validateFeishuConfig: (appId: string, appSecret: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; error?: string | null; app?: { appId: string; displayName?: string | null } }>(
      '/api/validate-feishu-config',
      { appId, appSecret },
      opts,
    ),
  validateWeixinConfig: (baseUrl: string, botToken: string, accountId: string, opts?: ApiRequestOptions) =>
    post<WeixinValidationResult>(
      '/api/validate-weixin-config',
      { baseUrl, botToken, accountId },
      opts,
    ),
  startWeixinLogin: (baseUrl: string, opts?: ApiRequestOptions) =>
    post<WeixinLoginStartResult>(
      '/api/weixin-login/start',
      { baseUrl },
      opts,
    ),
  waitWeixinLogin: (sessionKey: string, baseUrl: string, opts?: ApiRequestOptions) =>
    post<WeixinLoginWaitResult>(
      '/api/weixin-login/wait',
      { sessionKey, baseUrl },
      opts,
    ),
  requestPermission: (permission: string) => post<PermissionRequestResult>('/api/open-preferences', { permission }),
  restart: () => post<{ ok: boolean; error?: string | null }>('/api/restart', {}),
  switchWorkdir: (path: string) => post<{ ok: boolean; workdir?: string; error?: string }>('/api/switch-workdir', { path }),
  lsDir: (dir?: string) => json<LsDirResult>(`/api/ls-dir${dir ? '?path=' + encodeURIComponent(dir) : ''}`),
  getBrowser: () => json<BrowserStatusResponse>('/api/browser'),
  setupBrowser: (opts?: ApiRequestOptions) =>
    post<BrowserSetupResponse>('/api/browser/setup', {}, { timeoutMs: 120_000, ...opts }),
  desktopInstall: (opts?: ApiRequestOptions) =>
    post<{ ok: boolean; installed?: boolean; error?: string }>('/api/desktop-install', {}, { timeoutMs: 300_000, ...opts }),
  desktopToggle: (enabled: boolean, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; enabled?: boolean; error?: string }>('/api/desktop-toggle', { enabled }, { timeoutMs: 60_000, ...opts }),
};
