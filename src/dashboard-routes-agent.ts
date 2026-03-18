/**
 * dashboard-routes-agent.ts — Agent, model, and session-related API routes for the dashboard.
 *
 * Handles: /api/agents, /api/agent-status, /api/agent-install, /api/runtime-agent,
 * /api/sessions, /api/sessions/:agent, /api/session-detail/:agent/:id
 */

import http from 'node:http';
import fs from 'node:fs';
import { getAgentInstallCommand, getAgentLabel, getAgentPackage } from './agent-npm.js';
import { loadUserConfig, saveUserConfig, applyUserConfig, resolveUserWorkdir, type UserConfig } from './user-config.js';
import { listAgents, getSessionTail, getSessions, listModels, normalizeClaudeModelId, type AgentDetectOptions, type SessionInfo, type SessionListResult, type UsageResult } from './code-agent.js';
import type { Agent } from './code-agent.js';
import { getDriver } from './agent-driver.js';
import type { Bot } from './bot.js';
import { collectSetupState, type SetupState } from './onboarding.js';
import { getSessionStatusForBot } from './session-status.js';
import type { DashboardRouteContext } from './dashboard.js';
import { DASHBOARD_TIMEOUTS, DASHBOARD_PAGINATION } from './constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_STATUS_MODELS_TIMEOUT_MS = DASHBOARD_TIMEOUTS.agentStatusModels;
const AGENT_STATUS_USAGE_TIMEOUT_MS = DASHBOARD_TIMEOUTS.agentStatusUsage;
const AGENT_INSTALL_TIMEOUT_MS = DASHBOARD_TIMEOUTS.agentInstall;
const DEFAULT_SESSION_PAGE_SIZE = DASHBOARD_PAGINATION.defaultPageSize;
const MAX_SESSION_PAGE_SIZE = DASHBOARD_PAGINATION.maxPageSize;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeoutFallback<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);

    promise
      .then(result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

function parsePageNumber(value: string | null, fallback = 0): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parsePageSize(value: string | null, fallback = DEFAULT_SESSION_PAGE_SIZE): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_SESSION_PAGE_SIZE);
}

function paginateSessionResult<T>(result: { ok: boolean; sessions: T[]; error: string | null }, page: number, limit: number) {
  const sessions = Array.isArray(result.sessions) ? result.sessions : [] as T[];
  const total = sessions.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * limit;
  return {
    ok: result.ok,
    error: result.error,
    sessions: sessions.slice(start, start + limit),
    page: safePage,
    limit,
    total,
    totalPages,
    hasMore: safePage + 1 < totalPages,
  };
}

type DashboardSessionInfo = SessionInfo & { isCurrent?: boolean };

function enrichSessionResultWithRuntimeStatus(result: SessionListResult, bot: Bot | null): SessionListResult & { sessions: DashboardSessionInfo[] } {
  return {
    ...result,
    sessions: result.sessions.map(session => {
      const status = bot ? getSessionStatusForBot(bot, session) : { isCurrent: false, isRunning: !!session.running };
      return {
        ...session,
        running: status.isRunning,
        runState: status.isRunning ? 'running' : session.runState,
        isCurrent: status.isCurrent,
      };
    }),
  };
}

function dedupeModels(models: { id: string; alias: string | null }[]): { id: string; alias: string | null }[] {
  const seen = new Set<string>();
  const deduped: { id: string; alias: string | null }[] = [];
  for (const model of models) {
    const id = String(model?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, alias: model.alias?.trim() || null });
  }
  return deduped;
}

import { spawn } from 'node:child_process';

function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; error: string | null }> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_yes: 'true' },
    });
    const timeoutMs = Math.max(500, opts.timeoutMs ?? DASHBOARD_TIMEOUTS.runCommand);
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      resolve({ ok: false, stdout, stderr, error: `Timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: err.message });
    });
    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        error: code === 0 ? null : (stderr.trim() || stdout.trim() || `Exited with code ${code}`),
      });
    });
  });
}

async function installAgentViaNpm(agent: Agent, log: (msg: string) => void): Promise<void> {
  const pkg = getAgentPackage(agent);
  if (!pkg) throw new Error(`Unsupported agent: ${agent}`);
  log(`Installing ${getAgentLabel(agent)} via npm...`);
  const result = await runCommand('npm', ['install', '-g', `${pkg}@latest`], {
    timeoutMs: AGENT_INSTALL_TIMEOUT_MS,
  });
  if (!result.ok) throw new Error(result.error || `Failed to install ${pkg}`);
  log(`${getAgentLabel(agent)} installation complete.`);
}

// ---------------------------------------------------------------------------
// Agent status builder (shared with runtime-agent route)
// ---------------------------------------------------------------------------

export interface AgentRoutesDeps {
  knownAgents: Set<Agent>;
  defaultModels: Record<Agent, string>;
  defaultEfforts: Partial<Record<Agent, string>>;
  runtimePrefs: {
    defaultAgent?: Agent;
    models: Partial<Record<Agent, string>>;
    efforts: Partial<Record<Agent, string>>;
  };
  getBotRef(): Bot | null;
  getRuntimeWorkdir(config: Partial<UserConfig>): string;
  getRuntimeDefaultAgent(config: Partial<UserConfig>): Agent;
  getRuntimeModel(agent: Agent, config?: Partial<UserConfig>): string;
  getRuntimeEffort(agent: Agent, config?: Partial<UserConfig>): string | null;
  isAgent(value: unknown): value is Agent;
  getSetupState(config?: Partial<UserConfig>, agentOptions?: AgentDetectOptions): SetupState;
  setModelEnv(agent: Agent, value: string): void;
  setEffortEnv(agent: Agent, value: string): void;
}

function emptyUsage(agent: Agent, error: string): UsageResult {
  return { ok: false, agent, source: null, capturedAt: null, status: null, windows: [], error };
}

async function buildAgentStatusResponse(deps: AgentRoutesDeps, config = loadUserConfig(), agentOptions: AgentDetectOptions = {}) {
  const setupState = deps.getSetupState(config, { includeVersion: true, ...agentOptions });
  const workdir = deps.getRuntimeWorkdir(config);
  const defaultAgent = deps.getRuntimeDefaultAgent(config);
  const agents = await Promise.all(setupState.agents.map(async (agentState) => {
    const agentId = deps.isAgent(agentState.agent) ? agentState.agent : null;
    if (!agentId) {
      return {
        ...agentState,
        selectedModel: null,
        selectedEffort: null,
        isDefault: false,
        models: [],
        usage: null,
      };
    }

    const selectedModel = deps.getRuntimeModel(agentId, config);
    const selectedEffort = deps.getRuntimeEffort(agentId, config);
    let models: { id: string; alias: string | null }[] = [];
    let usage: UsageResult = emptyUsage(agentId, 'Agent not installed.');

    if (agentState.installed) {
      const modelFallback = selectedModel ? [{ id: selectedModel, alias: null }] : [];
      try {
        const driver = getDriver(agentId);
        const cachedUsage = driver.getUsage({ agent: agentId, model: selectedModel });
        const [resolvedModels, resolvedUsage] = await Promise.all([
          withTimeoutFallback(
            listModels(agentId, { workdir, currentModel: selectedModel }).then(result => dedupeModels([
              ...modelFallback,
              ...result.models,
            ])),
            AGENT_STATUS_MODELS_TIMEOUT_MS,
            modelFallback,
          ),
          driver.getUsageLive
            ? withTimeoutFallback(
              driver.getUsageLive({ agent: agentId, model: selectedModel }),
              AGENT_STATUS_USAGE_TIMEOUT_MS,
              cachedUsage,
            )
            : Promise.resolve(cachedUsage),
        ]);
        models = resolvedModels;
        usage = resolvedUsage;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        usage = emptyUsage(agentId, detail || 'Usage query failed.');
      }
    }

    return {
      ...agentState,
      selectedModel,
      selectedEffort,
      isDefault: agentId === defaultAgent,
      models,
      usage,
    };
  }));

  return { defaultAgent, workdir, agents };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAgentRoutes(
  ctx: DashboardRouteContext,
  deps: AgentRoutesDeps,
  url: URL,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (url.pathname === '/api/agent-status' && method === 'GET') {
    void handleAgentStatus(ctx, deps, res);
    return true;
  }

  if (url.pathname === '/api/agent-install' && method === 'POST') {
    void handleAgentInstall(ctx, deps, req, res);
    return true;
  }

  if (url.pathname === '/api/agents' && method === 'GET') {
    handleAgents(ctx, deps, res);
    return true;
  }

  if (url.pathname === '/api/runtime-agent' && method === 'POST') {
    void handleRuntimeAgent(ctx, deps, req, res);
    return true;
  }

  // Sessions (per agent)
  if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && method === 'GET') {
    void handleSessionsByAgent(ctx, deps, url, res);
    return true;
  }

  // All sessions (all agents, for swim lane view)
  if (url.pathname === '/api/sessions' && method === 'GET') {
    void handleAllSessions(ctx, deps, url, res);
    return true;
  }

  // Session detail (tail messages)
  if (url.pathname.match(/^\/api\/session-detail\/[^/]+\/[^/]+$/) && method === 'GET') {
    void handleSessionDetail(ctx, deps, url, res);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleAgentStatus(ctx: DashboardRouteContext, deps: AgentRoutesDeps, res: http.ServerResponse) {
  ctx.json(res, await buildAgentStatusResponse(deps));
}

async function handleAgentInstall(ctx: DashboardRouteContext, deps: AgentRoutesDeps, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const agent = String(body?.agent || '').trim();
  if (!deps.isAgent(agent)) return ctx.json(res, { ok: false, error: 'Invalid agent' }, 400);
  ctx.dashboardLog(`[agents] install requested agent=${agent} command="${getAgentInstallCommand(agent) || '(unknown)'}"`);
  try {
    await installAgentViaNpm(agent, msg => ctx.dashboardLog(`[agents] ${msg}`));
    return ctx.json(res, { ok: true, ...(await buildAgentStatusResponse(deps, loadUserConfig(), { refresh: true })) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.dashboardLog(`[agents] install failed agent=${agent} error=${detail}`);
    return ctx.json(res, { ok: false, error: detail }, 500);
  }
}

function handleAgents(ctx: DashboardRouteContext, deps: AgentRoutesDeps, res: http.ServerResponse) {
  ctx.json(res, { agents: deps.getSetupState(loadUserConfig(), { includeVersion: true }).agents });
}

async function handleRuntimeAgent(ctx: DashboardRouteContext, deps: AgentRoutesDeps, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const config = loadUserConfig();
  const nextConfig: Partial<UserConfig> = { ...config };
  const defaultAgent = body?.defaultAgent;
  const targetAgent = body?.agent;
  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  const effort = typeof body?.effort === 'string' ? body.effort.trim().toLowerCase() : '';
  const botRef = deps.getBotRef();

  if (defaultAgent != null) {
    if (!deps.isAgent(defaultAgent)) return ctx.json(res, { ok: false, error: 'Invalid defaultAgent' }, 400);
    deps.runtimePrefs.defaultAgent = defaultAgent;
    process.env.DEFAULT_AGENT = defaultAgent;
    nextConfig.defaultAgent = defaultAgent;
    if (botRef) botRef.setDefaultAgent(defaultAgent);
  }

  if (model || effort) {
    if (!deps.isAgent(targetAgent)) return ctx.json(res, { ok: false, error: 'Invalid agent' }, 400);
    if (model) {
      deps.runtimePrefs.models[targetAgent] = model;
      deps.setModelEnv(targetAgent, model);
      if (targetAgent === 'claude') nextConfig.claudeModel = model;
      if (targetAgent === 'codex') nextConfig.codexModel = model;
      if (targetAgent === 'gemini') nextConfig.geminiModel = model;
      if (botRef) botRef.setModelForAgent(targetAgent, model);
    }
    if (effort && targetAgent !== 'gemini') {
      deps.runtimePrefs.efforts[targetAgent] = effort;
      deps.setEffortEnv(targetAgent, effort);
      if (targetAgent === 'claude') nextConfig.claudeReasoningEffort = effort;
      if (targetAgent === 'codex') nextConfig.codexReasoningEffort = effort;
      if (botRef) botRef.setEffortForAgent(targetAgent, effort);
    }
  }

  saveUserConfig(nextConfig);
  applyUserConfig(nextConfig);
  return ctx.json(res, { ok: true, ...(await buildAgentStatusResponse(deps, nextConfig)) });
}

async function handleSessionsByAgent(ctx: DashboardRouteContext, deps: AgentRoutesDeps, url: URL, res: http.ServerResponse) {
  const agent = url.pathname.split('/')[3] as Agent;
  const config = loadUserConfig();
  const workdir = ctx.getRequestWorkdir(config);
  const page = parsePageNumber(url.searchParams.get('page'));
  const limit = parsePageSize(url.searchParams.get('limit'));
  const botRef = deps.getBotRef();
  ctx.dashboardLog(
    `[sessions] endpoint=single agent=${agent} resolvedWorkdir=${workdir} exists=${fs.existsSync(workdir)} ` +
    `configWorkdir=${String(config.workdir || '(none)')} botWorkdir=${botRef?.workdir || '(none)'} ` +
    `page=${page} limit=${limit}`
  );
  const result = await getSessions({ agent, workdir });
  const paged = paginateSessionResult(enrichSessionResultWithRuntimeStatus(result, botRef), page, limit);
  ctx.dashboardLog(
    `[sessions] endpoint=single agent=${agent} ok=${paged.ok} total=${paged.total} ` +
    `returned=${paged.sessions.length} error=${paged.error || '(none)'}`
  );
  ctx.json(res, paged);
}

async function handleAllSessions(ctx: DashboardRouteContext, deps: AgentRoutesDeps, url: URL, res: http.ServerResponse) {
  const config = loadUserConfig();
  const workdir = ctx.getRequestWorkdir(config);
  const page = parsePageNumber(url.searchParams.get('page'));
  const limit = parsePageSize(url.searchParams.get('limit'));
  const botRef = deps.getBotRef();
  ctx.dashboardLog(
    `[sessions] endpoint=all resolvedWorkdir=${workdir} exists=${fs.existsSync(workdir)} ` +
    `configWorkdir=${String(config.workdir || '(none)')} botWorkdir=${botRef?.workdir || '(none)'} ` +
    `page=${page} limit=${limit}`
  );
  const agents = listAgents().agents.filter(a => a.installed);
  const result: Record<string, any> = {};
  await Promise.all(agents.map(async a => {
    const agentResult = await getSessions({ agent: a.agent, workdir });
    result[a.agent] = paginateSessionResult(enrichSessionResultWithRuntimeStatus(agentResult, botRef), page, limit);
    const paged = result[a.agent];
    ctx.dashboardLog(
      `[sessions] endpoint=all agent=${a.agent} ok=${!!paged?.ok} total=${paged?.total ?? 0} ` +
      `returned=${Array.isArray(paged?.sessions) ? paged.sessions.length : 0} error=${paged?.error || '(none)'}`
    );
  }));
  ctx.json(res, result);
}

async function handleSessionDetail(ctx: DashboardRouteContext, deps: AgentRoutesDeps, url: URL, res: http.ServerResponse) {
  const parts = url.pathname.split('/');
  const agent = parts[3] as Agent;
  const sessionId = decodeURIComponent(parts[4]);
  const config = loadUserConfig();
  const workdir = ctx.getRequestWorkdir(config);
  const limit = parseInt(url.searchParams.get('limit') || '6', 10);
  const botRef = deps.getBotRef();
  ctx.dashboardLog(
    `[sessions] endpoint=detail agent=${agent} session=${sessionId} limit=${limit} resolvedWorkdir=${workdir} ` +
    `exists=${fs.existsSync(workdir)} configWorkdir=${String(config.workdir || '(none)')} botWorkdir=${botRef?.workdir || '(none)'}`
  );
  const tail = await getSessionTail({ agent, sessionId, workdir, limit });
  ctx.dashboardLog(`[sessions] endpoint=detail agent=${agent} session=${sessionId} ok=${tail.ok} messages=${tail.messages.length} error=${tail.error || '(none)'}`);
  ctx.json(res, tail);
}
