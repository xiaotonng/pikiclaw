/**
 * runtime.ts — Singleton module holding the runtime state previously
 * scattered across startDashboard() closure variables.
 *
 * Provides bot ref management, runtime prefs (agent/model/effort),
 * channel state caching, and validated setup state construction.
 */

import { EventEmitter } from 'node:events';
import type { Bot } from '../bot/bot.js';
import type { Agent, AgentDetectOptions } from '../agent/index.js';
import type { UserConfig } from '../core/config/user-config.js';
import type { SetupState } from '../cli/onboarding.js';
import { loadUserConfig, resolveUserWorkdir } from '../core/config/user-config.js';
import { listAgents } from '../agent/index.js';
import { collectSetupState } from '../cli/onboarding.js';
import {
  validateDingtalkConfig,
  validateDiscordConfig,
  validateFeishuConfig,
  validateSlackConfig,
  validateTelegramConfig,
  validateWecomConfig,
  validateWeixinConfig,
} from '../core/config/validation.js';
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
  const slackBot = String(config.slackBotToken || '').trim();
  const slackApp = String(config.slackAppToken || '').trim();
  const slackConfigured = !!(slackBot || slackApp);
  const slackReady = !!(slackBot && slackApp);
  const discordToken = String(config.discordBotToken || '').trim();
  const discordConfigured = !!discordToken;
  const dingtalkId = String(config.dingtalkClientId || '').trim();
  const dingtalkSecret = String(config.dingtalkClientSecret || '').trim();
  const dingtalkConfigured = !!(dingtalkId || dingtalkSecret);
  const dingtalkReady = !!(dingtalkId && dingtalkSecret);
  const wecomId = String(config.wecomBotId || '').trim();
  const wecomSecret = String(config.wecomBotSecret || '').trim();
  const wecomConfigured = !!(wecomId || wecomSecret);
  const wecomReady = !!(wecomId && wecomSecret);

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
    {
      channel: 'slack',
      configured: slackConfigured,
      ready: false,
      validated: false,
      status: !slackConfigured ? 'missing' : slackReady ? 'checking' : 'invalid',
      detail: !slackConfigured
        ? 'Slack is not configured.'
        : slackReady
          ? 'Validating Slack credentials…'
          : 'Both Bot Token (xoxb-) and App-Level Token (xapp-) are required.',
    },
    {
      channel: 'discord',
      configured: discordConfigured,
      ready: false,
      validated: false,
      status: discordConfigured ? 'checking' : 'missing',
      detail: discordConfigured ? 'Validating Discord credentials…' : 'Discord is not configured.',
    },
    {
      channel: 'dingtalk',
      configured: dingtalkConfigured,
      ready: false,
      validated: false,
      status: !dingtalkConfigured ? 'missing' : dingtalkReady ? 'checking' : 'invalid',
      detail: !dingtalkConfigured
        ? 'DingTalk is not configured.'
        : dingtalkReady
          ? 'Validating DingTalk credentials…'
          : 'Both Client ID and Client Secret are required.',
    },
    {
      channel: 'wecom',
      configured: wecomConfigured,
      ready: false,
      validated: false,
      status: !wecomConfigured ? 'missing' : wecomReady ? 'checking' : 'invalid',
      detail: !wecomConfigured
        ? 'WeChat Work is not configured.'
        : wecomReady
          ? 'Validating WeChat Work credentials…'
          : 'Both Bot ID and Bot Secret are required.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Dashboard event bus — pushes changes to WebSocket clients
// ---------------------------------------------------------------------------

/**
 * Events emitted on the dashboard event bus.
 *
 * - `stream-update`    — a stream snapshot changed (new text, phase transition)
 * - `sessions-changed` — session list may have changed (stream done, status update)
 */
export type DashboardEventType = 'stream-update' | 'sessions-changed';

export interface DashboardEvent {
  type: DashboardEventType;
  /** agent:sessionId key for stream events, or workdir for session-list events */
  key?: string;
  /** Inline snapshot for stream-update (avoids a round-trip fetch) */
  snapshot?: unknown;
}

// ---------------------------------------------------------------------------
// Runtime singleton
// ---------------------------------------------------------------------------

class Runtime {
  private botRef: Bot | null = null;
  readonly runtimePrefs: RuntimePrefs = { models: {}, efforts: {} };

  /** Dashboard event bus — WebSocket connections subscribe to this. */
  readonly events = new EventEmitter();

  /** Emit a dashboard event to all connected WebSocket clients. */
  emitDashboardEvent(event: DashboardEvent): void {
    this.events.emit('dashboard-event', event);
  }
  /**
   * Per-channel validation cache. Keyed by channel name so that changing
   * one channel's credentials (or the channels array) doesn't invalidate
   * the cached validation result for unrelated channels — which would
   * otherwise flicker their UI status to "Validating…" until the next
   * poll completes.
   */
  private channelStateCache = new Map<NonNullable<SetupState['channels']>[number]['channel'], {
    key: string;
    expiresAt: number;
    state: NonNullable<SetupState['channels']>[number];
  }>();

  readonly knownAgents = new Set<Agent>(['claude', 'codex', 'gemini', 'hermes']);

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
      if (this.isAgent(agent) && typeof effort === 'string' && effort.trim()) bot.setEffortForAgent(agent, effort);
    }
    // Wire stream snapshots → dashboard WebSocket
    const prevPhases = new Map<string, string | null>();
    bot.onStreamSnapshot((sessionKey, snapshot) => {
      this.emitDashboardEvent({ type: 'stream-update', key: sessionKey, snapshot });
      // Emit sessions-changed on phase *transitions* (not every snapshot update)
      // so the sidebar refreshes when a session starts running, finishes, etc.
      const phase = snapshot && typeof snapshot === 'object' ? (snapshot as any).phase : null;
      const prev = prevPhases.get(sessionKey) ?? null;
      if (phase !== prev) {
        prevPhases.set(sessionKey, phase);
        if (!phase) prevPhases.delete(sessionKey); // clean up null entries
        this.emitDashboardEvent({ type: 'sessions-changed', key: sessionKey });
      }
    });
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
    if (this.botRef) return this.botRef.effortForAgent(agent);
    const value = String(this.runtimePrefs.efforts[agent] || resolveAgentEffort(config, agent) || '').trim().toLowerCase();
    return value || null;
  }

  // -- Channel state cache --

  private credKeyForChannel(
    channel: NonNullable<SetupState['channels']>[number]['channel'],
    config: Partial<UserConfig>,
  ): string {
    switch (channel) {
      case 'weixin':
        return JSON.stringify({
          baseUrl: String(config.weixinBaseUrl || '').trim(),
          token: String(config.weixinBotToken || '').trim(),
          accountId: String(config.weixinAccountId || '').trim(),
        });
      case 'telegram':
        return JSON.stringify({
          token: String(config.telegramBotToken || '').trim(),
          allowed: String(config.telegramAllowedChatIds || '').trim(),
        });
      case 'feishu':
        return JSON.stringify({
          appId: String(config.feishuAppId || '').trim(),
          appSecret: String(config.feishuAppSecret || '').trim(),
        });
      case 'slack':
        return JSON.stringify({
          botToken: String(config.slackBotToken || '').trim(),
          appToken: String(config.slackAppToken || '').trim(),
        });
      case 'discord':
        return JSON.stringify({ botToken: String(config.discordBotToken || '').trim() });
      case 'dingtalk':
        return JSON.stringify({
          clientId: String(config.dingtalkClientId || '').trim(),
          clientSecret: String(config.dingtalkClientSecret || '').trim(),
        });
      case 'wecom':
        return JSON.stringify({
          botId: String(config.wecomBotId || '').trim(),
          botSecret: String(config.wecomBotSecret || '').trim(),
        });
    }
  }

  private validateChannel(
    channel: NonNullable<SetupState['channels']>[number]['channel'],
    config: Partial<UserConfig>,
  ): Promise<NonNullable<SetupState['channels']>[number]> {
    switch (channel) {
      case 'weixin':
        // The Weixin getupdates endpoint is a long-poll that holds the
        // connection open for ~8s by default. For dashboard validation we
        // only care whether the credentials are accepted (bad creds return
        // an errcode quickly; good creds simply hold the poll). Use a
        // tight internal timeout so we resolve well within the dashboard's
        // CHANNEL_STATUS_VALIDATION_TIMEOUT_MS window — the abort path
        // returns ret=0 which is treated as "valid".
        return validateWeixinConfig(
          config.weixinBaseUrl,
          config.weixinBotToken,
          config.weixinAccountId,
          { timeoutMs: 2_000 },
        ).then(r => r.state);
      case 'telegram':
        return validateTelegramConfig(config.telegramBotToken, config.telegramAllowedChatIds).then(r => r.state);
      case 'feishu':
        return validateFeishuConfig(config.feishuAppId, config.feishuAppSecret).then(r => r.state);
      case 'slack':
        return validateSlackConfig(config.slackBotToken, config.slackAppToken).then(r => r.state);
      case 'discord':
        return validateDiscordConfig(config.discordBotToken).then(r => r.state);
      case 'dingtalk':
        return validateDingtalkConfig(config.dingtalkClientId, config.dingtalkClientSecret).then(r => r.state);
      case 'wecom':
        return validateWecomConfig(config.wecomBotId, config.wecomBotSecret).then(r => r.state);
    }
  }

  async resolveChannelStates(config: Partial<UserConfig>): Promise<NonNullable<SetupState['channels']>> {
    const now = Date.now();
    const fallback = buildLocalChannelStates(config);
    // Channels listed in the same order as buildLocalChannelStates().
    const channelOrder = fallback.map(state => state.channel);

    type Plan = {
      channel: NonNullable<SetupState['channels']>[number]['channel'];
      key: string;
      cached: NonNullable<SetupState['channels']>[number] | null;
      livePromise: Promise<NonNullable<SetupState['channels']>[number]> | null;
      fallback: NonNullable<SetupState['channels']>[number];
    };

    const plans: Plan[] = channelOrder.map((channel, idx) => {
      const key = this.credKeyForChannel(channel, config);
      const cached = this.channelStateCache.get(channel);
      if (cached && cached.key === key && cached.expiresAt > now) {
        return { channel, key, cached: cached.state, livePromise: null, fallback: fallback[idx] };
      }
      return { channel, key, cached: null, livePromise: this.validateChannel(channel, config), fallback: fallback[idx] };
    });

    const resolved = await Promise.all(plans.map(plan => {
      if (plan.cached) return Promise.resolve(plan.cached);
      return withTimeoutFallback(plan.livePromise!, CHANNEL_STATUS_VALIDATION_TIMEOUT_MS, plan.fallback);
    }));

    // Persist freshly-validated channels into the per-channel cache. If a
    // channel's validation timed out, keep the live promise alive in the
    // background so the next dashboard poll can pick up the real result
    // instantly instead of re-issuing the network call.
    plans.forEach((plan, i) => {
      if (!plan.livePromise) return;
      const state = resolved[i];
      if (shouldCacheChannelStates([state])) {
        this.channelStateCache.set(plan.channel, {
          key: plan.key,
          expiresAt: now + CHANNEL_STATUS_CACHE_TTL_MS,
          state,
        });
        return;
      }
      void plan.livePromise.then(bgState => {
        if (!shouldCacheChannelStates([bgState])) return;
        // Skip if newer credentials have replaced the cache for this channel.
        const current = this.channelStateCache.get(plan.channel);
        if (current && current.key !== plan.key) return;
        this.channelStateCache.set(plan.channel, {
          key: plan.key,
          expiresAt: Date.now() + CHANNEL_STATUS_CACHE_TTL_MS,
          state: bgState,
        });
      }).catch(() => {});
    });

    return resolved;
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
