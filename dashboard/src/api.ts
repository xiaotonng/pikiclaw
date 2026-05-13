import type {
  AgentStatusResponse,
  AppState,
  BrowserSetupResponse,
  BrowserStatusResponse,
  CliCatalogItem,
  CliStatus,
  InteractionSnapshot,
  OpenTarget,
  GitChangesResult,
  HostInfo,
  LocalModelsProbeResponse,
  LsDirResult,
  McpCatalogItem,
  McpHealthResult,
  McpSearchResult,
  McpServerConfig,
  PermissionRequestResult,
  SkillCatalogItem,
  RemoteSkillInfo,
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
  /**
   * When sent with an empty/pending sessionId because the user just switched
   * agent, these point at the live session of the agent they switched away
   * from. The backend reads that session, compacts it, and prepends the seed
   * to this turn's prompt — see `compactForHandover` in src/agent/handover.ts.
   */
  previousAgent?: string | null;
  previousSessionId?: string | null;
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
  validateSlackConfig: (botToken: string, appToken: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; error?: string | null; bot?: { userId: string; team: string | null; username: string | null } | null }>(
      '/api/validate-slack-config',
      { botToken, appToken },
      opts,
    ),
  validateDiscordConfig: (botToken: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; error?: string | null; bot?: { userId: string; username: string; applicationId: string | null } | null }>(
      '/api/validate-discord-config',
      { botToken },
      opts,
    ),
  validateDingtalkConfig: (clientId: string, clientSecret: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; error?: string | null; app?: { clientId: string } | null }>(
      '/api/validate-dingtalk-config',
      { clientId, clientSecret },
      opts,
    ),
  validateWecomConfig: (botId: string, botSecret: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; error?: string | null; bot?: { botId: string } | null }>(
      '/api/validate-wecom-config',
      { botId, botSecret },
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

  // MCP Extensions — catalog-first surface
  getMcpCatalog: (workdir?: string, scope?: 'global' | 'workspace' | 'both') => {
    const params = new URLSearchParams();
    if (workdir) params.set('workdir', workdir);
    if (scope) params.set('scope', scope);
    const qs = params.toString();
    return json<{ ok: boolean; items: McpCatalogItem[] }>(`/api/extensions/mcp/catalog${qs ? '?' + qs : ''}`);
  },
  installMcp: (catalogId: string, scope: 'global' | 'workspace', credentials?: Record<string, string>, workdir?: string, enable = true) =>
    post<{ ok: boolean; enabled?: boolean; error?: string }>(
      '/api/extensions/mcp/install',
      { catalogId, scope, credentials, workdir, enable },
    ),
  toggleMcp: (name: string, enabled: boolean, scope: 'global' | 'workspace', workdir?: string) =>
    post<{ ok: boolean; updated?: boolean; error?: string }>(
      '/api/extensions/mcp/toggle',
      { name, enabled, scope, workdir },
    ),
  updateMcpExtension: (name: string, patch: Partial<McpServerConfig>, scope: 'global' | 'workspace', workdir?: string) =>
    post<{ ok: boolean; updated?: boolean; error?: string }>('/api/extensions/mcp/update', { name, patch, scope, workdir }),
  removeMcp: (name: string, scope: 'global' | 'workspace', catalogId?: string, workdir?: string) =>
    post<{ ok: boolean; removed?: boolean; error?: string }>(
      '/api/extensions/mcp/remove',
      { name, scope, catalogId, workdir },
    ),
  addCustomMcp: (name: string, config: McpServerConfig, scope: 'global' | 'workspace', workdir?: string) =>
    post<{ ok: boolean; error?: string }>('/api/extensions/mcp/custom', { name, config, scope, workdir }),
  checkMcpHealth: (id: string, config: McpServerConfig, noCache = false, opts?: ApiRequestOptions) =>
    post<McpHealthResult>('/api/extensions/mcp/health', { id, config, noCache }, { timeoutMs: 15_000, ...opts }),
  searchMcp: (query: string) =>
    json<{ ok: boolean; results: McpSearchResult[] }>(`/api/extensions/mcp/search?q=${encodeURIComponent(query)}`),

  // MCP OAuth
  startMcpOAuth: (catalogId: string) =>
    post<{ ok: boolean; authUrl?: string; state?: string; error?: string }>(
      '/api/extensions/mcp/oauth/start',
      { catalogId },
      { timeoutMs: 30_000 },
    ),
  revokeMcpOAuth: (catalogId: string) =>
    post<{ ok: boolean; removed?: boolean; error?: string }>(
      '/api/extensions/mcp/oauth/revoke',
      { catalogId },
    ),

  // Skills — catalog-first surface
  getSkillsCatalog: (workdir: string | undefined, scope?: 'global' | 'workspace' | 'both', opts?: ApiRequestOptions) => {
    const params = new URLSearchParams();
    if (workdir) params.set('workdir', workdir);
    if (scope) params.set('scope', scope);
    return json<{ ok: boolean; items: SkillCatalogItem[]; installed: SkillInfo[] }>(
      `/api/extensions/skills/catalog?${params.toString()}`,
      { timeoutMs: 5_000, ...opts },
    );
  },
  installSkill: (source: string, global?: boolean, skill?: string, workdir?: string) =>
    post<{ ok: boolean; error?: string; output?: string }>(
      '/api/extensions/skills/install',
      { source, global, skill, workdir },
      { timeoutMs: 90_000 },
    ),
  removeExtensionSkill: (name: string, global?: boolean, workdir?: string) =>
    post<{ ok: boolean; error?: string }>('/api/extensions/skills/remove', { name, global, workdir }),
  listRepoSkills: (source: string, opts?: ApiRequestOptions) =>
    json<{ ok: boolean; skills: RemoteSkillInfo[]; partial?: boolean; error?: string }>(
      `/api/extensions/skills/list?source=${encodeURIComponent(source)}`,
      { timeoutMs: 15_000, ...opts },
    ),
  searchExtensionSkills: (query: string) =>
    json<{ ok: boolean; results: any[] }>(`/api/extensions/skills/search?q=${encodeURIComponent(query)}`),

  // Skills (legacy)
  getSkills: (workdir: string, opts?: ApiRequestOptions) =>
    json<{ ok: boolean; skills: SkillInfo[]; error?: string }>(
      `/api/session-hub/skills?workdir=${encodeURIComponent(workdir)}`,
      { timeoutMs: 5_000, ...opts },
    ),

  // CLI tools — catalog + auth lifecycle
  getCliCatalog: (opts?: ApiRequestOptions) =>
    json<{ ok: boolean; items: CliCatalogItem[]; error?: string }>(
      '/api/extensions/cli/catalog',
      { timeoutMs: 10_000, ...opts },
    ),
  refreshCli: (id: string) =>
    post<{ ok: boolean; status?: CliStatus; error?: string }>(
      '/api/extensions/cli/refresh',
      { id },
      { timeoutMs: 15_000 },
    ),
  startCliAuth: (id: string) =>
    post<{ ok: boolean; sessionId?: string; error?: string }>(
      '/api/extensions/cli/auth/start',
      { id },
    ),
  startCliInstall: (id: string) =>
    post<{ ok: boolean; sessionId?: string; error?: string }>(
      '/api/extensions/cli/install',
      { id },
    ),
  cancelCliAuth: (sessionId: string) =>
    post<{ ok: boolean; cancelled?: boolean; error?: string }>(
      '/api/extensions/cli/auth/cancel',
      { sessionId },
    ),
  applyCliToken: (id: string, values: Record<string, string>) =>
    post<{ ok: boolean; status?: CliStatus; error?: string }>(
      '/api/extensions/cli/auth/token',
      { id, values },
      { timeoutMs: 15_000 },
    ),
  logoutCli: (id: string) =>
    post<{ ok: boolean; status?: CliStatus; error?: string }>(
      '/api/extensions/cli/logout',
      { id },
      { timeoutMs: 15_000 },
    ),

  // Local model backends (Ollama / LM Studio)
  probeLocalModels: (opts?: ApiRequestOptions) =>
    json<LocalModelsProbeResponse>('/api/local-models/probe', { timeoutMs: 8_000, ...opts }),
  connectLocalBackend: (backend: 'ollama' | 'lmstudio') =>
    post<{ ok: boolean; providerId?: string; alreadyConnected?: boolean; error?: string }>(
      '/api/local-models/connect',
      { backend },
    ),
  /**
   * Pull a model via Ollama's streaming `/api/pull`. Returns an async iterator
   * over decoded NDJSON events so the caller can render a live progress bar.
   * The returned `cancel()` aborts the upstream pull as well.
   */
  pullLocalModel: (
    backend: 'ollama',
    model: string,
  ): { events: AsyncIterable<OllamaPullEvent>; cancel: () => void } => {
    const controller = new AbortController();
    const promise = fetch('/api/local-models/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend, model }),
      signal: controller.signal,
    });
    async function* iterate(): AsyncIterable<OllamaPullEvent> {
      const res = await promise;
      if (!res.ok || !res.body) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) detail = j.error;
        } catch { /* keep status */ }
        throw new Error(detail);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (!line) continue;
          try { yield JSON.parse(line) as OllamaPullEvent; } catch { /* skip malformed */ }
        }
      }
      const tail = buffer.trim();
      if (tail) {
        try { yield JSON.parse(tail) as OllamaPullEvent; } catch { /* skip */ }
      }
    }
    return { events: iterate(), cancel: () => controller.abort() };
  },

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
      previousAgent,
      previousSessionId,
      ...opts
    } = options;
    const prevAgent = typeof previousAgent === 'string' ? previousAgent.trim() : '';
    const prevSessionId = typeof previousSessionId === 'string' ? previousSessionId.trim() : '';
    const payload = {
      workdir,
      agent,
      sessionId,
      prompt,
      ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
      ...(typeof effort === 'string' && effort.trim() ? { effort: effort.trim() } : {}),
      ...(prevAgent && prevSessionId ? { previousAgent: prevAgent, previousSessionId: prevSessionId } : {}),
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
    if (prevAgent && prevSessionId) {
      body.set('previousAgent', prevAgent);
      body.set('previousSessionId', prevSessionId);
    }
    for (const attachment of attachments) {
      body.append('attachments', attachment, attachment.name || 'image');
    }

    return json<{ ok: boolean; queued?: boolean; taskId?: string; sessionKey?: string; error?: string }>(
      '/api/session-hub/session/send',
      { method: 'POST', body, timeoutMs: 30_000, ...opts },
    );
  },
  /**
   * Fork a session at `atTurn` and queue a new prompt against the freshly
   * created child. Returns the queued task plus the child's pending sessionKey
   * so the caller can navigate the UI into the new session immediately.
   */
  forkSession: (
    workdir: string,
    agent: string,
    parentSessionId: string,
    atTurn: number,
    prompt: string,
    options: { model?: string | null; effort?: string | null } = {},
    opts?: ApiRequestOptions,
  ) =>
    post<{ ok: boolean; queued?: boolean; taskId?: string; sessionKey?: string; error?: string }>(
      '/api/session-hub/session/fork',
      {
        workdir,
        agent,
        sessionId: parentSessionId,
        atTurn,
        prompt,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      },
      { timeoutMs: 30_000, ...opts },
    ),
  recallSessionMessage: (taskId: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; recalled?: boolean; error?: string }>(
      '/api/session-hub/session/recall',
      { taskId },
      opts,
    ),
  /**
   * Stop the running stream AND cancel every queued task for a session.
   * Backed by `bot.stopAllSessionTasks`; takes (agent, sessionId) so it works
   * even in the small window after `sendSessionMessage` where the client
   * hasn't received the streamTaskId yet.
   */
  stopSession: (agent: string, sessionId: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; interrupted?: boolean; cancelledQueued?: number; error?: string }>(
      '/api/session-hub/session/stop',
      { agent, sessionId },
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

  // Human-in-the-loop interaction (im_ask_user / Codex requestUserInput)
  /** Pick a predefined option as the answer to the current question. */
  interactionSelectOption: (
    promptId: string,
    value: string,
    requestFreeform?: boolean,
    opts?: ApiRequestOptions,
  ) =>
    post<{ ok: boolean; completed?: boolean; advanced?: boolean; error?: string }>(
      `/api/interaction/${encodeURIComponent(promptId)}/select`,
      { value, requestFreeform: !!requestFreeform },
      opts,
    ),
  /** Submit freeform text as the answer to the current question. */
  interactionSubmitText: (promptId: string, text: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; completed?: boolean; advanced?: boolean; error?: string }>(
      `/api/interaction/${encodeURIComponent(promptId)}/text`,
      { text },
      opts,
    ),
  /** Skip the current question (mark as answered with no value). */
  interactionSkip: (promptId: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; completed?: boolean; advanced?: boolean; error?: string }>(
      `/api/interaction/${encodeURIComponent(promptId)}/skip`,
      {},
      opts,
    ),
  /** Cancel the prompt entirely — the agent receives an error. */
  interactionCancel: (promptId: string, opts?: ApiRequestOptions) =>
    post<{ ok: boolean; cancelled?: boolean; error?: string }>(
      `/api/interaction/${encodeURIComponent(promptId)}/cancel`,
      {},
      opts,
    ),
};

/**
 * Single event from Ollama's `/api/pull` NDJSON stream. The set of `status`
 * strings is taken from Ollama's source and not exhaustive; treat `error`
 * presence as terminal failure and `status === 'success'` as terminal success.
 */
export interface OllamaPullEvent {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/** Snapshot of the latest streaming state for a session (returned by polling endpoint). */
export interface StreamSnapshot {
  phase: 'queued' | 'streaming' | 'done';
  taskId: string;
  /** Task IDs queued behind the currently displayed one, in enqueue order. */
  queuedTaskIds?: string[];
  /** Per-queued-task prompt previews (same order as queuedTaskIds). */
  queuedTasks?: Array<{ taskId: string; prompt: string }>;
  text?: string;
  thinking?: string;
  activity?: string;
  plan?: StreamPlan | null;
  sessionId?: string | null;
  error?: string;
  /** Active human-in-the-loop interaction prompts (im_ask_user / Codex user-input). */
  interactions?: InteractionSnapshot[];
  updatedAt: number;
}
