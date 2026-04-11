import type {
  AgentStatusResponse,
  AppState,
  BrowserSetupResponse,
  BrowserStatusResponse,
  OpenTarget,
  GitChangesResult,
  HostInfo,
  LsDirResult,
  PermissionRequestResult,
  SessionHubResult,
  SessionMessagesResult,
  SkillInfo,
  StreamPlan,
  SessionTailMessage,
  SessionsPageResult,
  WorkspaceEntry,
  WeixinLoginStartResult,
  WeixinLoginWaitResult,
  WeixinValidationResult,
} from './types';

export interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
}

export interface SessionSendRequestOptions extends ApiRequestOptions {
  attachments?: File[];
  model?: string | null;
  effort?: string | null;
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
  checkAgentUpdate: (agent: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; error?: string } & AgentStatusResponse>('/api/agent-check-update', { agent }, { timeoutMs: 30_000, ...opts }),
  updateAgent: (agent: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; error?: string } & AgentStatusResponse>('/api/agent-update', { agent }, { timeoutMs: 600_000, ...opts }),
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
  lsDir: (dir?: string, includeFiles?: boolean, includeHidden?: boolean) => {
    const params = new URLSearchParams();
    if (dir) params.set('path', dir);
    if (includeFiles) params.set('files', '1');
    if (includeHidden) params.set('hidden', '1');
    const qs = params.toString();
    return json<LsDirResult>(`/api/ls-dir${qs ? '?' + qs : ''}`);
  },
  gitChanges: (dir: string) =>
    json<GitChangesResult>(`/api/git-changes?path=${encodeURIComponent(dir)}`),
  openDiff: (filePath: string, target?: OpenTarget) =>
    post<{ ok: boolean; error?: string }>('/api/open-diff', { filePath, target }),
  getBrowser: () => json<BrowserStatusResponse>('/api/browser'),
  setupBrowser: (opts?: ApiRequestOptions) =>
    post<BrowserSetupResponse>('/api/browser/setup', {}, { timeoutMs: 120_000, ...opts }),
  desktopInstall: (opts?: ApiRequestOptions) =>
    post<{ ok: boolean; installed?: boolean; error?: string }>('/api/desktop-install', {}, { timeoutMs: 300_000, ...opts }),
  desktopToggle: (enabled: boolean, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; enabled?: boolean; error?: string }>('/api/desktop-toggle', { enabled }, { timeoutMs: 60_000, ...opts }),

  // Skills
  getSkills: (workdir: string, opts?: ApiRequestOptions) =>
    json<{ ok: boolean; skills: SkillInfo[]; error?: string }>(
      `/api/session-hub/skills?workdir=${encodeURIComponent(workdir)}`,
      { timeoutMs: 5_000, ...opts },
    ),

  // Session hub
  getWorkspaces: () => json<{ ok: boolean; workspaces: WorkspaceEntry[] }>('/api/workspaces'),
  getWorkspaceSessions: (workdir: string, opts?: ApiRequestOptions) =>
    post<SessionHubResult>('/api/session-hub/sessions', { workdir }, opts),
  getSessionMessages: (
    workdir: string,
    agent: string,
    sessionId: string,
    query: { lastNTurns?: number; turnOffset?: number; turnLimit?: number; rich?: boolean } = {},
    opts?: ApiRequestOptions,
  ) =>
    post<SessionMessagesResult>(
      '/api/session-hub/session/messages',
      { workdir, agent, sessionId, rich: query.rich ?? true, lastNTurns: query.lastNTurns, turnOffset: query.turnOffset, turnLimit: query.turnLimit },
      opts,
    ),
  updateSessionStatus: (
    workdir: string,
    agent: string,
    sessionId: string,
    status: 'inbox' | 'active' | 'review' | 'done' | 'parked',
    opts?: ApiRequestOptions,
  ) =>
    post<{ ok: boolean; updated?: boolean; error?: string }>(
      '/api/session-hub/session/status',
      { workdir, agent, sessionId, status },
      opts,
    ),
  updateSessionNote: (
    workdir: string,
    agent: string,
    sessionId: string,
    note: string | null,
    opts?: ApiRequestOptions,
  ) =>
    post<{ ok: boolean; updated?: boolean; error?: string }>(
      '/api/session-hub/session/note',
      { workdir, agent, sessionId, note },
      opts,
    ),
  addWorkspace: (wsPath: string, name?: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; workspace?: WorkspaceEntry; error?: string }>('/api/workspaces', { path: wsPath, name }, opts),
  removeWorkspace: (wsPath: string, opts?: ApiRequestOptions) =>
    json<{ ok: boolean; removed?: boolean; error?: string }>('/api/workspaces', { ...opts, method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: wsPath }) }),

  // Editor integration
  openInEditor: (filePath: string, target?: OpenTarget) =>
    post<{ ok: boolean; error?: string }>('/api/open-in-editor', { filePath, target }),

  // Session interaction
  sendSessionMessage: (
    workdir: string,
    agent: string,
    sessionId: string,
    prompt: string,
    options: SessionSendRequestOptions = {},
  ) => {
    const {
      attachments = [],
      model,
      effort,
      ...opts
    } = options;
    const payload = {
      workdir,
      agent,
      sessionId,
      prompt,
      ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
      ...(typeof effort === 'string' && effort.trim() ? { effort: effort.trim() } : {}),
    };

    if (!attachments.length) {
      return post<{ ok: boolean; queued?: boolean; taskId?: string; sessionKey?: string; error?: string }>(
        '/api/session-hub/session/send',
        payload,
        { timeoutMs: 30_000, ...opts },
      );
    }

    const body = new FormData();
    body.set('workdir', workdir);
    body.set('agent', agent);
    body.set('sessionId', sessionId);
    body.set('prompt', prompt);
    if (typeof model === 'string' && model.trim()) body.set('model', model.trim());
    if (typeof effort === 'string' && effort.trim()) body.set('effort', effort.trim());
    for (const attachment of attachments) {
      body.append('attachments', attachment, attachment.name || 'image');
    }

    return json<{ ok: boolean; queued?: boolean; taskId?: string; sessionKey?: string; error?: string }>(
      '/api/session-hub/session/send',
      { method: 'POST', body, timeoutMs: 30_000, ...opts },
    );
  },
  recallSessionMessage: (taskId: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; recalled?: boolean; error?: string }>(
      '/api/session-hub/session/recall',
      { taskId },
      opts,
    ),
  steerSession: (taskId: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; steered?: boolean; error?: string }>(
      '/api/session-hub/session/steer',
      { taskId },
      opts,
    ),

  /** Poll current streaming state for a session. */
  getSessionStreamState: (agent: string, sessionId: string, opts?: ApiRequestOptions) =>
    json<{ ok: boolean; state: StreamSnapshot | null }>(
      `/api/session-hub/session/stream-state?agent=${encodeURIComponent(agent)}&sessionId=${encodeURIComponent(sessionId)}`,
      { timeoutMs: 5_000, ...opts },
    ),
};

/** Snapshot of the latest streaming state for a session (returned by polling endpoint). */
export interface StreamSnapshot {
  phase: 'queued' | 'streaming' | 'done';
  taskId: string;
  queuedTaskId?: string;
  text?: string;
  thinking?: string;
  activity?: string;
  plan?: StreamPlan | null;
  sessionId?: string | null;
  error?: string;
  updatedAt: number;
}
