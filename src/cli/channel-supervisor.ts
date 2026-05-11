/**
 * channel-supervisor.ts — Owns the set of running IM channel bots and
 * reconciles it against the current user config without restarting the
 * pikiclaw process.
 *
 * Subscribes to onUserConfigChange. Whenever the channels array or any
 * channel's credentials change, the supervisor stops the affected bot,
 * disposes its transport, and (if still configured) launches a fresh
 * instance with the new config — all in-process, leaving the dashboard,
 * other channels, and active coding sessions on unaffected bots running.
 */

import type { Bot } from '../bot/bot.js';
import type { ChannelName, UserConfig } from '../core/config/user-config.js';
import { loadUserConfig, onUserConfigChange } from '../core/config/user-config.js';
import { resolveConfiguredChannels } from './channels.js';
import type { DashboardServer } from '../dashboard/server.js';

interface RunningBot {
  bot: Bot;
  credSnapshot: string;
  runPromise: Promise<void>;
}

const CHANNEL_AFFECTING_KEYS = new Set<keyof UserConfig>([
  'channels',
  'telegramBotToken',
  'telegramAllowedChatIds',
  'feishuAppId',
  'feishuAppSecret',
  'weixinBaseUrl',
  'weixinBotToken',
  'weixinAccountId',
  'slackBotToken',
  'slackAppToken',
  'discordBotToken',
  'dingtalkClientId',
  'dingtalkClientSecret',
  'wecomBotId',
  'wecomBotSecret',
  'wecomEndpoint',
]);

/**
 * How long to wait between stopping a channel and starting a replacement
 * with new credentials. Some IM providers hold the old connection slot
 * server-side for a moment after we close the socket; if a new client
 * with the same credentials connects too quickly the server rejects with
 * "system busy" and the SDK ends up in a broken state.
 *
 * Feishu's lark SDK is the known offender — its WSClient handshake races
 * with a "PingInterval" setup that crashes when the server rejects the
 * second connect. Telegram (long-poll over HTTP) and Weixin (HTTP long-
 * poll) tolerate immediate replacement.
 */
const CHANNEL_REPLACE_SETTLE_MS: Record<ChannelName, number> = {
  telegram: 0,
  weixin: 0,
  feishu: 5_000,
  // The Slack / Discord / DingTalk / WeChat-Work providers all hold the
  // single-bot socket slot for a moment after disconnect; give them a
  // small grace window so token rotation doesn't trip "already connected"
  // style errors on the immediate replacement connection.
  slack: 3_000,
  discord: 3_000,
  dingtalk: 3_000,
  wecom: 3_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function snapshotCredsForChannel(channel: ChannelName, config: Partial<UserConfig>): string {
  switch (channel) {
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
    case 'weixin':
      return JSON.stringify({
        baseUrl: String(config.weixinBaseUrl || '').trim(),
        token: String(config.weixinBotToken || '').trim(),
        accountId: String(config.weixinAccountId || '').trim(),
      });
    case 'slack':
      return JSON.stringify({
        botToken: String(config.slackBotToken || '').trim(),
        appToken: String(config.slackAppToken || '').trim(),
      });
    case 'discord':
      return JSON.stringify({
        botToken: String(config.discordBotToken || '').trim(),
      });
    case 'dingtalk':
      return JSON.stringify({
        clientId: String(config.dingtalkClientId || '').trim(),
        clientSecret: String(config.dingtalkClientSecret || '').trim(),
      });
    case 'wecom':
      return JSON.stringify({
        botId: String(config.wecomBotId || '').trim(),
        botSecret: String(config.wecomBotSecret || '').trim(),
        endpoint: String(config.wecomEndpoint || '').trim(),
      });
  }
}

async function createBotForChannel(channel: ChannelName): Promise<Bot> {
  switch (channel) {
    case 'telegram': {
      const { TelegramBot } = await import('../channels/telegram/bot.js');
      return new TelegramBot();
    }
    case 'feishu': {
      const { FeishuBot } = await import('../channels/feishu/bot.js');
      return new FeishuBot();
    }
    case 'weixin': {
      const { WeixinBot } = await import('../channels/weixin/bot.js');
      return new WeixinBot();
    }
    case 'slack': {
      const { SlackBot } = await import('../channels/slack/bot.js');
      return new SlackBot();
    }
    case 'discord': {
      const { DiscordBot } = await import('../channels/discord/bot.js');
      return new DiscordBot();
    }
    case 'dingtalk': {
      const { DingtalkBot } = await import('../channels/dingtalk/bot.js');
      return new DingtalkBot();
    }
    case 'wecom': {
      const { WeComBot } = await import('../channels/wecom/bot.js');
      return new WeComBot();
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

export interface ChannelSupervisorOpts {
  dashboard: DashboardServer | null;
  log: (message: string) => void;
}

export class ChannelSupervisor {
  private readonly running = new Map<ChannelName, RunningBot>();
  private readonly dashboard: DashboardServer | null;
  private readonly log: (message: string) => void;
  private reconcileInFlight = false;
  private reconcilePending = false;
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(opts: ChannelSupervisorOpts) {
    this.dashboard = opts.dashboard;
    this.log = opts.log;
  }

  /**
   * Initial launch + subscribe to config changes. Idempotent: calling
   * twice is a no-op for the second call.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reconcile(loadUserConfig());
    this.unsubscribe = onUserConfigChange((config, changedKeys) => {
      if (!changedKeys.some(key => CHANNEL_AFFECTING_KEYS.has(key as keyof UserConfig))) return;
      void this.reconcile(config);
    });
  }

  /** Stop every running channel and unsubscribe from config changes. */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const channels = [...this.running.keys()];
    await Promise.all(channels.map(channel => this.stopChannel(channel)));
  }

  /** Reconcile running bots against the desired channel set + credentials. */
  async reconcile(config: Partial<UserConfig>): Promise<void> {
    if (this.reconcileInFlight) {
      this.reconcilePending = true;
      return;
    }
    this.reconcileInFlight = true;
    try {
      let current = config;
      while (true) {
        this.reconcilePending = false;
        await this.doReconcile(current);
        if (!this.reconcilePending) break;
        // Newer config arrived during reconcile — re-read from disk so the
        // next pass acts on the latest state.
        current = loadUserConfig();
      }
    } finally {
      this.reconcileInFlight = false;
    }
  }

  private async doReconcile(config: Partial<UserConfig>): Promise<void> {
    const desired = resolveConfiguredChannels({ config });
    const desiredSet = new Set(desired);

    // Stop channels that are no longer desired OR whose credentials changed.
    const toStop: ChannelName[] = [];
    for (const [channel, entry] of this.running) {
      if (!desiredSet.has(channel)) {
        toStop.push(channel);
        continue;
      }
      if (snapshotCredsForChannel(channel, config) !== entry.credSnapshot) {
        toStop.push(channel);
      }
    }
    if (toStop.length) {
      await Promise.all(toStop.map(channel => this.stopChannel(channel)));
    }

    // For channels being replaced (still desired, just stopped above for
    // credential rotation), wait the per-channel settle delay so the
    // remote server has time to release the old connection slot before
    // we open a new one.
    const replacing = toStop.filter(channel => desiredSet.has(channel));
    const settleMs = replacing.reduce(
      (max, channel) => Math.max(max, CHANNEL_REPLACE_SETTLE_MS[channel] ?? 0),
      0,
    );
    if (settleMs > 0) {
      this.log(`waiting ${settleMs}ms for ${replacing.join(', ')} to settle before relaunch`);
      await sleep(settleMs);
    }

    // Start channels that should be running but aren't (either added or
    // just stopped above due to credential rotation).
    for (const channel of desired) {
      if (this.running.has(channel)) continue;
      try {
        await this.startChannel(channel, config);
      } catch (err) {
        this.log(`channel ${channel}: failed to start — ${describeError(err)}`);
      }
    }
  }

  private async startChannel(channel: ChannelName, config: Partial<UserConfig>): Promise<void> {
    this.log(`channel ${channel}: starting`);
    const bot = await createBotForChannel(channel);
    if (this.dashboard) this.dashboard.attachBot(bot);
    const runPromise = bot.run().catch((err: unknown) => {
      this.log(`channel ${channel}: run() exited with error — ${describeError(err)}`);
    });
    this.running.set(channel, {
      bot,
      credSnapshot: snapshotCredsForChannel(channel, config),
      runPromise,
    });
  }

  private async stopChannel(channel: ChannelName): Promise<void> {
    const entry = this.running.get(channel);
    if (!entry) return;
    this.log(`channel ${channel}: stopping`);
    // Remove from the map up-front so a concurrent reconcile pass doesn't
    // try to stop the same instance twice.
    this.running.delete(channel);
    try {
      entry.bot.requestStop();
    } catch (err) {
      this.log(`channel ${channel}: requestStop threw — ${describeError(err)}`);
    }
    try {
      await entry.runPromise;
    } catch {}
    this.log(`channel ${channel}: stopped`);
  }
}
