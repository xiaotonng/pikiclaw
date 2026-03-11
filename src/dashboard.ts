/**
 * dashboard.ts — Web dashboard server for codeclaw configuration and monitoring.
 *
 * All config is read from / written to ~/.codeclaw/setting.json (no env vars).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, execSync } from 'node:child_process';
import { collectSetupState, isSetupReady, type SetupState } from './onboarding.js';
import { loadUserConfig, saveUserConfig, applyUserConfig, resolveUserWorkdir, type UserConfig } from './user-config.js';
import { listAgents, getSessionTail, getSessions, listModels, type UsageResult } from './code-agent.js';
import type { Agent } from './code-agent.js';
import { getDriver } from './agent-driver.js';
import { VERSION, type Bot } from './bot.js';
import { validateFeishuConfig, validateTelegramConfig } from './config-validation.js';
import { getDashboardHtml } from './dashboard-ui.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardOptions {
  port?: number;
  open?: boolean;
  bot?: Bot;
}

export interface DashboardServer {
  port: number;
  url: string;
  server: http.Server;
  close(): Promise<void>;
  attachBot(bot: Bot): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_STATUS_MODELS_TIMEOUT_MS = 1_500;
const AGENT_STATUS_USAGE_TIMEOUT_MS = 1_500;
const CHANNEL_STATUS_VALIDATION_TIMEOUT_MS = 1_500;
const CHANNEL_STATUS_CACHE_TTL_MS = 20_000;

function buildLocalChannelStates(config: Partial<UserConfig>): NonNullable<SetupState['channels']> {
  const telegramConfigured = !!String(config.telegramBotToken || '').trim();
  const feishuAppId = String(config.feishuAppId || '').trim();
  const feishuSecret = String(config.feishuAppSecret || '').trim();
  const feishuConfigured = !!(feishuAppId || feishuSecret);
  const feishuReady = !!(feishuAppId && feishuSecret);

  return [
    {
      channel: 'telegram',
      configured: telegramConfigured,
      ready: telegramConfigured,
      validated: false,
      status: telegramConfigured ? 'ready' : 'missing',
      detail: telegramConfigured ? 'Telegram credentials are configured.' : 'Telegram is not configured.',
    },
    {
      channel: 'feishu',
      configured: feishuConfigured,
      ready: feishuReady,
      validated: false,
      status: feishuConfigured ? (feishuReady ? 'ready' : 'invalid') : 'missing',
      detail: !feishuConfigured
        ? 'Feishu credentials are not configured.'
        : feishuReady
          ? 'Feishu credentials are configured.'
          : 'Both App ID and App Secret are required.',
    },
  ];
}

function getSetupState(config = loadUserConfig()): SetupState {
  const agents = listAgents().agents;
  const channels = buildLocalChannelStates(config);
  const readyChannel = channels.find(channel => channel.ready)?.channel;
  const configuredChannel = channels.find(channel => channel.configured)?.channel;
  return collectSetupState({
    agents,
    channel: readyChannel || configuredChannel || 'telegram',
    tokenProvided: channels.some(channel => channel.configured),
    channels,
  });
}

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

interface PermissionStatus { granted: boolean; checkable: boolean; detail: string }

function checkPermissions(): Record<string, PermissionStatus> {
  const r: Record<string, PermissionStatus> = {};
  if (process.platform !== 'darwin') {
    r.accessibility = { granted: true, checkable: false, detail: 'N/A' };
    r.screenRecording = { granted: true, checkable: false, detail: 'N/A' };
    r.fullDiskAccess = { granted: true, checkable: false, detail: 'N/A' };
    return r;
  }
  try {
    execSync("osascript -e 'tell application \"System Events\" to return 1' 2>/dev/null", { timeout: 3000 });
    r.accessibility = { granted: true, checkable: true, detail: '已授权' };
  } catch { r.accessibility = { granted: false, checkable: true, detail: '未授权' }; }
  try {
    execSync('screencapture -x /tmp/.codeclaw_perm_test.png 2>/dev/null && rm -f /tmp/.codeclaw_perm_test.png', { timeout: 5000 });
    r.screenRecording = { granted: true, checkable: true, detail: '已授权' };
  } catch { r.screenRecording = { granted: false, checkable: true, detail: '未授权' }; }
  try {
    execSync(`ls "${os.homedir()}/Library/Mail" 2>/dev/null`, { timeout: 3000 });
    r.fullDiskAccess = { granted: true, checkable: true, detail: '已授权' };
  } catch { r.fullDiskAccess = { granted: false, checkable: true, detail: '未授权' }; }
  return r;
}

async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startDashboard(opts: DashboardOptions = {}): Promise<DashboardServer> {
  const preferredPort = opts.port || 3939;
  let botRef = opts.bot || null;
  const htmlContent = getDashboardHtml({ version: VERSION });
  const runtimePrefs: {
    defaultAgent?: Agent;
    models: Partial<Record<Agent, string>>;
    efforts: Partial<Record<Agent, string>>;
  } = {
    models: {},
    efforts: {},
  };
  let channelStateCache: {
    key: string;
    expiresAt: number;
    channels: NonNullable<SetupState['channels']>;
  } | null = null;
  const knownAgents = new Set<Agent>(['claude', 'codex', 'gemini']);
  const defaultModels: Record<Agent, string> = {
    claude: 'claude-opus-4-6',
    codex: 'gpt-5.4',
    gemini: 'gemini-3.1-pro-preview',
  };
  const defaultEfforts: Partial<Record<Agent, string>> = {
    claude: 'high',
    codex: 'xhigh',
  };

  function isAgent(value: unknown): value is Agent {
    return typeof value === 'string' && knownAgents.has(value as Agent);
  }

  function emptyUsage(agent: Agent, error: string): UsageResult {
    return { ok: false, agent, source: null, capturedAt: null, status: null, windows: [], error };
  }

  function channelStateCacheKey(config: Partial<UserConfig>): string {
    return JSON.stringify({
      telegramBotToken: String(config.telegramBotToken || '').trim(),
      telegramAllowedChatIds: String(config.telegramAllowedChatIds || '').trim(),
      feishuAppId: String(config.feishuAppId || '').trim(),
      feishuAppSecret: String(config.feishuAppSecret || '').trim(),
    });
  }

  async function resolveChannelStates(config: Partial<UserConfig>): Promise<NonNullable<SetupState['channels']>> {
    const key = channelStateCacheKey(config);
    const now = Date.now();
    if (channelStateCache && channelStateCache.key === key && channelStateCache.expiresAt > now) {
      return channelStateCache.channels;
    }

    const fallback = buildLocalChannelStates(config);
    const [telegram, feishu] = await Promise.all([
      withTimeoutFallback(
        validateTelegramConfig(config.telegramBotToken, config.telegramAllowedChatIds).then(result => result.state),
        CHANNEL_STATUS_VALIDATION_TIMEOUT_MS,
        fallback[0],
      ),
      withTimeoutFallback(
        validateFeishuConfig(config.feishuAppId, config.feishuAppSecret).then(result => result.state),
        CHANNEL_STATUS_VALIDATION_TIMEOUT_MS,
        fallback[1],
      ),
    ]);

    const channels: NonNullable<SetupState['channels']> = [telegram, feishu];
    channelStateCache = {
      key,
      expiresAt: now + CHANNEL_STATUS_CACHE_TTL_MS,
      channels,
    };
    return channels;
  }

  async function buildValidatedSetupState(config = loadUserConfig()): Promise<SetupState> {
    const agents = listAgents().agents;
    const channels = await resolveChannelStates(config);
    const readyChannel = channels.find(channel => channel.ready)?.channel;
    const configuredChannel = channels.find(channel => channel.configured)?.channel;
    return collectSetupState({
      agents,
      channel: readyChannel || configuredChannel || 'telegram',
      tokenProvided: channels.some(channel => channel.configured),
      channels,
    });
  }

  function modelEnv(agent: Agent): string | undefined {
    switch (agent) {
      case 'claude': return process.env.CLAUDE_MODEL;
      case 'codex': return process.env.CODEX_MODEL;
      case 'gemini': return process.env.GEMINI_MODEL;
    }
  }

  function effortEnv(agent: Agent): string | undefined {
    switch (agent) {
      case 'claude': return process.env.CLAUDE_REASONING_EFFORT;
      case 'codex': return process.env.CODEX_REASONING_EFFORT;
      case 'gemini': return undefined;
    }
  }

  function setModelEnv(agent: Agent, value: string) {
    switch (agent) {
      case 'claude': process.env.CLAUDE_MODEL = value; break;
      case 'codex': process.env.CODEX_MODEL = value; break;
      case 'gemini': process.env.GEMINI_MODEL = value; break;
    }
  }

  function setEffortEnv(agent: Agent, value: string) {
    switch (agent) {
      case 'claude': process.env.CLAUDE_REASONING_EFFORT = value; break;
      case 'codex': process.env.CODEX_REASONING_EFFORT = value; break;
      case 'gemini': break;
    }
  }

  function getRuntimeDefaultAgent(config: Partial<UserConfig>): Agent {
    if (botRef) return botRef.defaultAgent;
    const raw = String(runtimePrefs.defaultAgent || config.defaultAgent || 'codex').trim().toLowerCase();
    return isAgent(raw) ? raw : 'codex';
  }

  function getRuntimeWorkdir(config: Partial<UserConfig>): string {
    return botRef?.workdir || resolveUserWorkdir({ config });
  }

  function getRuntimeModel(agent: Agent): string {
    if (botRef) return botRef.modelForAgent(agent) || defaultModels[agent];
    return String(runtimePrefs.models[agent] || modelEnv(agent) || defaultModels[agent]).trim();
  }

  function getRuntimeEffort(agent: Agent): string | null {
    if (agent === 'gemini') return null;
    if (botRef) return botRef.effortForAgent(agent);
    const value = String(runtimePrefs.efforts[agent] || effortEnv(agent) || defaultEfforts[agent] || '').trim().toLowerCase();
    return value || null;
  }

  async function buildAgentStatusResponse(config = loadUserConfig()) {
    const setupState = getSetupState(config);
    const workdir = getRuntimeWorkdir(config);
    const defaultAgent = getRuntimeDefaultAgent(config);
    const agents = await Promise.all(setupState.agents.map(async (agentState) => {
      const agentId = isAgent(agentState.agent) ? agentState.agent : null;
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

      const selectedModel = getRuntimeModel(agentId);
      const selectedEffort = getRuntimeEffort(agentId);
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const method = req.method?.toUpperCase() || 'GET';
    try {
      if (url.pathname === '/' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(htmlContent);
      }

      // Full state (config from file only)
      if (url.pathname === '/api/state' && method === 'GET') {
        const config = loadUserConfig();
        const setupState = await buildValidatedSetupState(config);
        const permissions = checkPermissions();
        return json(res, {
          version: VERSION,
          ready: isSetupReady(setupState),
          config,
          runtimeWorkdir: getRuntimeWorkdir(config),
          setupState,
          permissions,
          platform: process.platform,
          pid: process.pid,
          nodeVersion: process.versions.node,
          bot: botRef ? {
            workdir: botRef.workdir,
            defaultAgent: botRef.defaultAgent,
            uptime: Date.now() - botRef.startedAt,
            stats: botRef.stats,
            activeTasks: botRef.activeTasks.size,
            sessions: botRef.sessionStates.size,
          } : null,
        });
      }

      if (url.pathname === '/api/agent-status' && method === 'GET') {
        return json(res, await buildAgentStatusResponse());
      }

      // Host info
      if (url.pathname === '/api/host' && method === 'GET') {
        if (botRef) return json(res, botRef.getHostData());
        const cpus = os.cpus();
        return json(res, {
          hostName: os.hostname(), cpuModel: cpus[0]?.model || 'unknown',
          cpuCount: cpus.length, totalMem: os.totalmem(), freeMem: os.freemem(),
          platform: process.platform, arch: os.arch(),
        });
      }

      // Agents
      if (url.pathname === '/api/agents' && method === 'GET') {
        return json(res, { agents: getSetupState().agents });
      }

      // Sessions (per agent)
      if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && method === 'GET') {
        const agent = url.pathname.split('/')[3] as Agent;
        const workdir = botRef?.workdir || process.env.CODECLAW_WORKDIR || process.cwd();
        return json(res, await getSessions({ agent, workdir }));
      }

      // All sessions (all agents, for swim lane view)
      if (url.pathname === '/api/sessions' && method === 'GET') {
        const workdir = botRef?.workdir || process.env.CODECLAW_WORKDIR || process.cwd();
        const agents = listAgents().agents.filter(a => a.installed);
        const result: Record<string, any> = {};
        await Promise.all(agents.map(async a => {
          result[a.agent] = await getSessions({ agent: a.agent, workdir });
        }));
        return json(res, result);
      }

      // Session detail (tail messages)
      if (url.pathname.match(/^\/api\/session-detail\/[^/]+\/[^/]+$/) && method === 'GET') {
        const parts = url.pathname.split('/');
        const agent = parts[3] as Agent;
        const sessionId = decodeURIComponent(parts[4]);
        const workdir = botRef?.workdir || process.env.CODECLAW_WORKDIR || process.cwd();
        const limit = parseInt(url.searchParams.get('limit') || '6', 10);
        const tail = await getSessionTail({ agent, sessionId, workdir, limit });
        return json(res, tail);
      }

      // Permissions
      if (url.pathname === '/api/permissions' && method === 'GET') {
        return json(res, checkPermissions());
      }

      // Save config (to ~/.codeclaw/setting.json)
      if (url.pathname === '/api/config' && method === 'POST') {
        const body = await parseJsonBody(req);
        const merged = { ...loadUserConfig(), ...body };
        const configPath = saveUserConfig(merged);
        applyUserConfig(loadUserConfig());
        return json(res, { ok: true, configPath });
      }

      if (url.pathname === '/api/runtime-agent' && method === 'POST') {
        const body = await parseJsonBody(req);
        const config = loadUserConfig();
        const defaultAgent = body?.defaultAgent;
        const targetAgent = body?.agent;
        const model = typeof body?.model === 'string' ? body.model.trim() : '';
        const effort = typeof body?.effort === 'string' ? body.effort.trim().toLowerCase() : '';

        if (defaultAgent != null) {
          if (!isAgent(defaultAgent)) return json(res, { ok: false, error: 'Invalid defaultAgent' }, 400);
          runtimePrefs.defaultAgent = defaultAgent;
          process.env.DEFAULT_AGENT = defaultAgent;
          if (botRef) botRef.setDefaultAgent(defaultAgent);
        }

        if (model || effort) {
          if (!isAgent(targetAgent)) return json(res, { ok: false, error: 'Invalid agent' }, 400);
          if (model) {
            runtimePrefs.models[targetAgent] = model;
            setModelEnv(targetAgent, model);
            if (botRef) botRef.setModelForAgent(targetAgent, model);
          }
          if (effort && targetAgent !== 'gemini') {
            runtimePrefs.efforts[targetAgent] = effort;
            setEffortEnv(targetAgent, effort);
            if (botRef) botRef.setEffortForAgent(targetAgent, effort);
          }
        }

        return json(res, { ok: true, ...(await buildAgentStatusResponse(config)) });
      }

      // Validate Telegram token
      if (url.pathname === '/api/validate-telegram-token' && method === 'POST') {
        const body = await parseJsonBody(req);
        const result = await validateTelegramConfig(body.token || '', body.allowedChatIds || '');
        return json(res, {
          ok: result.state.ready,
          error: result.state.ready ? null : result.state.detail,
          bot: result.bot,
          normalizedAllowedChatIds: result.normalizedAllowedChatIds,
        });
      }

      // Validate Feishu credentials
      if (url.pathname === '/api/validate-feishu-config' && method === 'POST') {
        const body = await parseJsonBody(req);
        const startedAt = Date.now();
        const rawAppId = String(body.appId || '').trim();
        const maskedAppId = !rawAppId
          ? '(missing)'
          : rawAppId.length <= 10
            ? rawAppId
            : `${rawAppId.slice(0, 6)}...${rawAppId.slice(-4)}`;
        const ts = new Date().toISOString().slice(11, 19);
        process.stdout.write(`[dashboard ${ts}] [feishu-config] request app=${maskedAppId}\n`);
        const result = await validateFeishuConfig(body.appId || '', body.appSecret || '');
        process.stdout.write(
          `[dashboard ${ts}] [feishu-config] result app=${maskedAppId} ok=${result.state.ready} status=${result.state.status} elapsedMs=${Date.now() - startedAt}\n`
        );
        return json(res, {
          ok: result.state.ready,
          error: result.state.ready ? null : result.state.detail,
          app: result.app,
        });
      }

      // Open macOS preferences
      if (url.pathname === '/api/open-preferences' && method === 'POST') {
        const body = await parseJsonBody(req);
        if (process.platform === 'darwin') {
          const panes: Record<string, string> = {
            accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
            screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
            fullDiskAccess: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
          };
          const pane = panes[body.permission];
          if (pane) { exec(`open "${pane}"`); return json(res, { ok: true }); }
        }
        return json(res, { ok: false });
      }

      // Restart process
      if (url.pathname === '/api/restart' && method === 'POST') {
        json(res, { ok: true });
        setTimeout(() => process.exit(0), 300);
        return;
      }

      // Switch workdir
      if (url.pathname === '/api/switch-workdir' && method === 'POST') {
        const body = await parseJsonBody(req);
        const newPath = body.path;
        if (!newPath) return json(res, { ok: false, error: 'Missing path' }, 400);
        const resolvedPath = path.resolve(String(newPath).replace(/^~/, process.env.HOME || ''));
        if (botRef) {
          botRef.switchWorkdir(resolvedPath);
          return json(res, { ok: true, workdir: botRef.workdir });
        }
        process.env.CODECLAW_WORKDIR = resolvedPath;
        return json(res, { ok: true, workdir: resolvedPath });
      }

      // List directory entries for tree browser
      if (url.pathname === '/api/ls-dir' && method === 'GET') {
        const dir = url.searchParams.get('path') || os.homedir();
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
          const isGit = fs.existsSync(path.join(dir, '.git'));
          return json(res, { ok: true, path: dir, parent: path.dirname(dir), dirs, isGit });
        } catch (err) {
          return json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }

      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return new Promise<DashboardServer>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') server.listen(preferredPort + 1, onListening);
      else reject(err);
    });

    function onListening() {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : preferredPort;
      const dashUrl = `http://localhost:${actualPort}`;
      const ts = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`[codeclaw ${ts}] dashboard: ${dashUrl}\n`);
      if (opts.open !== false) {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${cmd} ${dashUrl}`);
      }
      resolve({
        port: actualPort, url: dashUrl, server,
        attachBot(bot: Bot) {
          botRef = bot;
          if (runtimePrefs.defaultAgent) bot.setDefaultAgent(runtimePrefs.defaultAgent);
          for (const [agent, model] of Object.entries(runtimePrefs.models)) {
            if (isAgent(agent) && typeof model === 'string' && model.trim()) bot.setModelForAgent(agent, model);
          }
          for (const [agent, effort] of Object.entries(runtimePrefs.efforts)) {
            if (isAgent(agent) && agent !== 'gemini' && typeof effort === 'string' && effort.trim()) bot.setEffortForAgent(agent, effort);
          }
        },
        close() { return new Promise<void>(r => server.close(() => r())); },
      });
    }

    server.listen(preferredPort, onListening);
  });
}
