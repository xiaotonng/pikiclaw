/**
 * runtime.ts — Singleton module holding the runtime state previously
 * scattered across startDashboard() closure variables.
 *
 * Provides bot ref management, runtime prefs (agent/model/effort),
 * channel state caching, and validated setup state construction.
 */

import type { Bot } from '../bot/bot.js';
import type { Agent, AgentDetectOptions } from '../agent/index.js';
import type { UserConfig } from '../core/config/user-config.js';
import type { SetupState } from '../cli/onboarding.js';
import { loadUserConfig, resolveUserWorkdir } from '../core/config/user-config.js';
import { listAgents } from '../agent/index.js';
import { collectSetupState } from '../cli/onboarding.js';
import { validateFeishuConfig, validateTelegramConfig, validateWeixinConfig } from '../core/config/validation.js';
import { shouldCacheChannelStates } from '../channels/states.js';
import { DASHBOARD_TIMEOUTS } from '../core/constants.js';
import { withTimeoutFallback } from '../core/utils.js';
import { writeScopedLog, type LogLevel } from '../core/logging.js';
import {
  DEFAULT_AGENT_EFFORTS,
  DEFAULT_AGENT_MODELS,
  resolveAgentEffort,
  resolveAgentModel,
  setAgentEffortEnv,
  setAgentModelEnv,
} from '../core/config/runtime-config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_STATUS_VALIDATION_TIMEOUT_MS = DASHBOARD_TIMEOUTS.channelStatusValidation;
const CHANNEL_STATUS_CACHE_TTL_MS = DASHBOARD_TIMEOUTS.channelStatusCacheTtl;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuntimePrefs {
  defaultAgent?: Agent;
  models: Partial<Record<Agent, string>>;
  efforts: Partial<Record<Agent, string>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Runtime singleton
// ---------------------------------------------------------------------------

class Runtime {
  private botRef: Bot | null = null;
  readonly runtimePrefs: RuntimePrefs = { models: {}, efforts: {} };
  private channelStateCache: {
    key: string;
    expiresAt: number;
    channels: NonNullable<SetupState['channels']>;
  } | null = null;

  readonly knownAgents = new Set<Agent>(['claude', 'codex', 'gemini']);

  readonly defaultModels: Record<Agent, string> = DEFAULT_AGENT_MODELS;

  readonly defaultEfforts: Partial<Record<Agent, string>> = DEFAULT_AGENT_EFFORTS;

  // -- Bot ref management --

  getBotRef(): Bot | null {
    return this.botRef;
  }

  attachBot(bot: Bot): void {
    this.botRef = bot;
    if (this.runtimePrefs.defaultAgent) bot.setDefaultAgent(this.runtimePrefs.defaultAgent);
    for (const [agent, model] of Object.entries(this.runtimePrefs.models)) {
      if (this.isAgent(agent) && typeof model === 'string' && model.trim()) bot.setModelForAgent(agent, model);
    }
    for (const [agent, effort] of Object.entries(this.runtimePrefs.efforts)) {
      if (this.isAgent(agent) && agent !== 'gemini' && typeof effort === 'string' && effort.trim()) bot.setEffortForAgent(agent, effort);
    }
  }

  // -- Type guards --

  isAgent(value: unknown): value is Agent {
    return typeof value === 'string' && this.knownAgents.has(value as Agent);
  }

  // -- Workdir --

  getRuntimeWorkdir(config: Partial<UserConfig>): string {
    return this.botRef?.workdir || resolveUserWorkdir({ config });
  }

  getRequestWorkdir(config = loadUserConfig()): string {
    return this.getRuntimeWorkdir(config);
  }

  // -- Agent / model / effort --

  getRuntimeDefaultAgent(config: Partial<UserConfig>): Agent {
    if (this.botRef) return this.botRef.defaultAgent;
    const raw = String(this.runtimePrefs.defaultAgent || config.defaultAgent || 'codex').trim().toLowerCase();
    return this.isAgent(raw) ? raw : 'codex';
  }

  setModelEnv(agent: Agent, value: string): void {
    setAgentModelEnv(agent, value);
  }

  setEffortEnv(agent: Agent, value: string): void {
    setAgentEffortEnv(agent, value);
  }

  getRuntimeModel(agent: Agent, config = loadUserConfig()): string {
    if (this.botRef) return this.botRef.modelForAgent(agent) || this.defaultModels[agent];
    return String(this.runtimePrefs.models[agent] || resolveAgentModel(config, agent)).trim();
  }

  getRuntimeEffort(agent: Agent, config = loadUserConfig()): string | null {
    if (agent === 'gemini') return null;
    if (this.botRef) return this.botRef.effortForAgent(agent);
    const value = String(this.runtimePrefs.efforts[agent] || resolveAgentEffort(config, agent) || '').trim().toLowerCase();
    return value || null;
  }

  // -- Channel state cache --

  private channelStateCacheKey(config: Partial<UserConfig>): string {
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

  async resolveChannelStates(config: Partial<UserConfig>): Promise<NonNullable<SetupState['channels']>> {
    const key = this.channelStateCacheKey(config);
    const now = Date.now();
    if (this.channelStateCache && this.channelStateCache.key === key && this.channelStateCache.expiresAt > now) {
      return this.channelStateCache.channels;
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
      this.channelStateCache = {
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
        if (this.channelStateCache && this.channelStateCache.key !== key) return;
        this.channelStateCache = {
          key,
          expiresAt: Date.now() + CHANNEL_STATUS_CACHE_TTL_MS,
          channels: bgChannels,
        };
      }).catch(() => {});
    }
    return channels;
  }

  // -- Setup state --

  getSetupState(config = loadUserConfig(), agentOptions: AgentDetectOptions = {}): SetupState {
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

  async buildValidatedSetupState(config = loadUserConfig(), agentOptions: AgentDetectOptions = {}): Promise<SetupState> {
    const agents = listAgents(agentOptions).agents;
    const channels = await this.resolveChannelStates(config);
    const readyChannel = channels.find(channel => channel.ready)?.channel;
    const configuredChannel = channels.find(channel => channel.configured)?.channel;
    return collectSetupState({
      agents,
      channel: readyChannel || configuredChannel || 'telegram',
      tokenProvided: channels.some(channel => channel.configured),
      channels,
    });
  }

  // -- Logging --

  log(message: string, level: LogLevel = 'info'): void {
    writeScopedLog('dashboard', message, { level });
  }

  debug(message: string): void {
    this.log(message, 'debug');
  }

  warn(message: string): void {
    this.log(message, 'warn');
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const runtime = new Runtime();
