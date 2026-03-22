/**
 * dashboard.ts — Web dashboard server for pikiclaw configuration and monitoring.
 *
 * All config is read from / written to ~/.pikiclaw/setting.json (no env vars).
 *
 * Route handlers are split by responsibility:
 *   - dashboard-routes-config.ts  — config/channel/extension/permission routes
 *   - dashboard-routes-agent.ts   — agent/model/session routes
 *   - dashboard-platform.ts       — macOS permissions, terminal detection, Appium
 */

import http from 'node:http';
import { exec } from 'node:child_process';
import { collectSetupState, type SetupState } from './onboarding.js';
import { loadUserConfig, applyUserConfig, resolveUserWorkdir, type UserConfig } from './user-config.js';
import { listAgents, normalizeClaudeModelId, type AgentDetectOptions } from './code-agent.js';
import type { Agent } from './code-agent.js';
import type { Bot } from './bot.js';
import { validateFeishuConfig, validateTelegramConfig, validateWeixinConfig } from './config-validation.js';
import { getDashboardHtml } from './dashboard-ui.js';
import { shouldCacheChannelStates } from './channel-states.js';
import { registerProcessRuntime } from './process-control.js';
import { registerConfigRoutes } from './dashboard-routes-config.js';
import { registerAgentRoutes, type AgentRoutesDeps } from './dashboard-routes-agent.js';
import { VERSION } from './version.js';
import { DASHBOARD_TIMEOUTS } from './constants.js';

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

const DASHBOARD_PORT_RETRY_LIMIT = 10;

/**
 * Shared context passed to route handlers so they can access
 * server-level state without closing over the startDashboard() scope.
 */
export interface DashboardRouteContext {
  json(res: http.ServerResponse, data: unknown, status?: number): void;
  parseJsonBody(req: http.IncomingMessage): Promise<any>;
  dashboardLog(message: string): void;
  getBotRef(): Bot | null;
  getRuntimeWorkdir(config: Partial<UserConfig>): string;
  getRequestWorkdir(config?: Partial<UserConfig>): string;
  buildValidatedSetupState(config?: Partial<UserConfig>, agentOptions?: AgentDetectOptions): Promise<SetupState>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_STATUS_VALIDATION_TIMEOUT_MS = DASHBOARD_TIMEOUTS.channelStatusValidation;
const CHANNEL_STATUS_CACHE_TTL_MS = DASHBOARD_TIMEOUTS.channelStatusCacheTtl;

function buildLocalChannelStates(config: Partial<UserConfig>): NonNullable<SetupState['channels']> {
  const weixinBaseUrl = String(config.weixinBaseUrl || '').trim();
  const weixinBotToken = String(config.weixinBotToken || '').trim();
  const weixinAccountId = String(config.weixinAccountId || '').trim();
  const weixinConfigured = !!(weixinBaseUrl || weixinBotToken || weixinAccountId);
  const weixinReady = !!(weixinBaseUrl && weixinBotToken && weixinAccountId);
  const telegramConfigured = !!String(config.telegramBotToken || '').trim();
  const feishuAppId = String(config.feishuAppId || '').trim();
  const feishuSecret = String(config.feishuAppSecret || '').trim();
  const feishuConfigured = !!(feishuAppId || feishuSecret);
  const feishuReady = !!(feishuAppId && feishuSecret);

  return [
    {
      channel: 'weixin',
      configured: weixinConfigured,
      ready: false,
      validated: false,
      status: !weixinConfigured ? 'missing' : weixinReady ? 'checking' : 'invalid',
      detail: !weixinConfigured
        ? 'Weixin is not configured.'
        : weixinReady
          ? 'Validating Weixin credentials...'
          : 'Base URL, Bot Token, and Account ID are required.',
    },
    {
      channel: 'telegram',
      configured: telegramConfigured,
      ready: false,
      validated: false,
      status: telegramConfigured ? 'checking' : 'missing',
      detail: telegramConfigured ? 'Validating Telegram credentials…' : 'Telegram is not configured.',
    },
    {
      channel: 'feishu',
      configured: feishuConfigured,
      ready: false,
      validated: false,
      status: !feishuConfigured ? 'missing' : feishuReady ? 'checking' : 'invalid',
      detail: !feishuConfigured
        ? 'Feishu credentials are not configured.'
        : feishuReady
          ? 'Validating Feishu credentials…'
          : 'Both App ID and App Secret are required.',
    },
  ];
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

function getSetupState(config = loadUserConfig(), agentOptions: AgentDetectOptions = {}): SetupState {
  const agents = listAgents(agentOptions).agents;
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

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function dashboardLog(message: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[dashboard ${ts}] ${message}\n`);
}

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
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

  function channelStateCacheKey(config: Partial<UserConfig>): string {
    return JSON.stringify({
      weixinBaseUrl: String(config.weixinBaseUrl || '').trim(),
      weixinBotToken: String(config.weixinBotToken || '').trim(),
      weixinAccountId: String(config.weixinAccountId || '').trim(),
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
    const weixinPromise = validateWeixinConfig(config.weixinBaseUrl, config.weixinBotToken, config.weixinAccountId).then(result => result.state);
    const telegramPromise = validateTelegramConfig(config.telegramBotToken, config.telegramAllowedChatIds).then(result => result.state);
    const feishuPromise = validateFeishuConfig(config.feishuAppId, config.feishuAppSecret).then(result => result.state);

    const [weixin, telegram, feishu] = await Promise.all([
      withTimeoutFallback(weixinPromise, CHANNEL_STATUS_VALIDATION_TIMEOUT_MS, fallback[0]),
      withTimeoutFallback(telegramPromise, CHANNEL_STATUS_VALIDATION_TIMEOUT_MS, fallback[1]),
      withTimeoutFallback(feishuPromise, CHANNEL_STATUS_VALIDATION_TIMEOUT_MS, fallback[2]),
    ]);

    const channels: NonNullable<SetupState['channels']> = [weixin, telegram, feishu];
    if (shouldCacheChannelStates(channels)) {
      channelStateCache = {
        key,
        expiresAt: now + CHANNEL_STATUS_CACHE_TTL_MS,
        channels,
      };
    } else {
      // Validation timed out — let it finish in the background and populate cache
      // so the next frontend poll picks up the result instantly.
      void Promise.all([weixinPromise, telegramPromise, feishuPromise]).then(([bgWeixin, bgTelegram, bgFeishu]) => {
        const bgChannels: NonNullable<SetupState['channels']> = [bgWeixin, bgTelegram, bgFeishu];
        if (!shouldCacheChannelStates(bgChannels)) return;
        // Only update if no newer config has replaced the cache
        if (channelStateCache && channelStateCache.key !== key) return;
        channelStateCache = {
          key,
          expiresAt: Date.now() + CHANNEL_STATUS_CACHE_TTL_MS,
          channels: bgChannels,
        };
      }).catch(() => {});
    }
    return channels;
  }

  async function buildValidatedSetupState(config = loadUserConfig(), agentOptions: AgentDetectOptions = {}): Promise<SetupState> {
    const agents = listAgents(agentOptions).agents;
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

  function configModel(config: Partial<UserConfig>, agent: Agent): string | undefined {
    switch (agent) {
      case 'claude': return normalizeClaudeModelId(config.claudeModel || '') || undefined;
      case 'codex': return String(config.codexModel || '').trim() || undefined;
      case 'gemini': return String(config.geminiModel || '').trim() || undefined;
    }
  }

  function configEffort(config: Partial<UserConfig>, agent: Agent): string | undefined {
    switch (agent) {
      case 'claude': return String(config.claudeReasoningEffort || '').trim().toLowerCase() || undefined;
      case 'codex': return String(config.codexReasoningEffort || '').trim().toLowerCase() || undefined;
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

  function getRequestWorkdir(config = loadUserConfig()): string {
    return getRuntimeWorkdir(config);
  }

  function getRuntimeModel(agent: Agent, config = loadUserConfig()): string {
    if (botRef) return botRef.modelForAgent(agent) || defaultModels[agent];
    const value = String(runtimePrefs.models[agent] || configModel(config, agent) || modelEnv(agent) || defaultModels[agent]).trim();
    return agent === 'claude' ? normalizeClaudeModelId(value) : value;
  }

  function getRuntimeEffort(agent: Agent, config = loadUserConfig()): string | null {
    if (agent === 'gemini') return null;
    if (botRef) return botRef.effortForAgent(agent);
    const value = String(runtimePrefs.efforts[agent] || configEffort(config, agent) || effortEnv(agent) || defaultEfforts[agent] || '').trim().toLowerCase();
    return value || null;
  }

  // -- Shared context for route handlers --

  const routeCtx: DashboardRouteContext = {
    json,
    parseJsonBody,
    dashboardLog,
    getBotRef: () => botRef,
    getRuntimeWorkdir,
    getRequestWorkdir,
    buildValidatedSetupState,
  };

  const agentDeps: AgentRoutesDeps = {
    knownAgents,
    defaultModels,
    defaultEfforts,
    runtimePrefs,
    getBotRef: () => botRef,
    getRuntimeWorkdir,
    getRuntimeDefaultAgent,
    getRuntimeModel,
    getRuntimeEffort,
    isAgent,
    getSetupState,
    setModelEnv,
    setEffortEnv,
  };

  // -- HTTP server --

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const method = req.method?.toUpperCase() || 'GET';
    try {
      // Serve dashboard HTML
      if (url.pathname === '/' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(htmlContent);
      }

      // Config / channel / extension / permission routes
      if (registerConfigRoutes(routeCtx, url, method, req, res)) return;

      // Agent / model / session routes
      if (registerAgentRoutes(routeCtx, agentDeps, url, method, req, res)) return;

      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  const unregisterProcessRuntime = registerProcessRuntime({
    label: 'dashboard',
    prepareForRestart: () => new Promise<void>(resolve => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    }),
  });

  return new Promise<DashboardServer>((resolve, reject) => {
    let nextPort = preferredPort;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      server.off('error', onError);
      server.off('listening', onListening);
      reject(err);
    };

    const onError = (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (err.code === 'EADDRINUSE') {
        if (nextPort >= preferredPort + DASHBOARD_PORT_RETRY_LIMIT) {
          fail(new Error(`Dashboard ports ${preferredPort}-${preferredPort + DASHBOARD_PORT_RETRY_LIMIT} are already in use.`));
          return;
        }
        nextPort += 1;
        server.listen(nextPort);
        return;
      }
      fail(err);
    };

    server.on('error', onError);
    server.on('close', () => {
      unregisterProcessRuntime();
    });
    server.on('listening', onListening);

    function onListening() {
      if (settled) return;
      settled = true;
      server.off('error', onError);
      server.off('listening', onListening);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : preferredPort;
      const dashUrl = `http://localhost:${actualPort}`;
      const ts = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`[pikiclaw ${ts}] dashboard: ${dashUrl}\n`);
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
        close() {
          return new Promise<void>(resolveClose => {
            if (!server.listening) {
              unregisterProcessRuntime();
              resolveClose();
              return;
            }
            server.close(() => {
              unregisterProcessRuntime();
              resolveClose();
            });
          });
        },
      });
    }

    server.listen(preferredPort);
  });
}
