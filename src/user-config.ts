import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from './code-agent.js';

export type ChannelName = 'telegram' | 'feishu' | 'whatsapp';

export interface UserConfig {
  version: 1;
  channel?: ChannelName;
  /** Launch multiple channels simultaneously (comma-separated or array). */
  channels?: ChannelName[];
  defaultAgent?: Agent;
  defaultWorkdir?: string;
  telegramBotToken?: string;
  telegramAllowedChatIds?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
}

interface ApplyUserConfigOptions {
  overwrite?: boolean;
  clearMissing?: boolean;
  notify?: boolean;
}

interface SyncUserConfigOptions {
  intervalMs?: number;
  overrides?: Partial<UserConfig>;
  log?: (message: string) => void;
}

type UserConfigChangeListener = (config: Partial<UserConfig>, changedKeys: string[]) => void;

const MANAGED_ENV_KEYS = [
  'CODECLAW_CHANNEL',
  'DEFAULT_AGENT',
  'CODECLAW_WORKDIR',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
] as const;

let activeUserConfig: Partial<UserConfig> = {};
const userConfigListeners = new Set<UserConfigChangeListener>();
let userConfigSyncTimer: ReturnType<typeof setInterval> | null = null;
let userConfigSyncRefCount = 0;
let userConfigSyncRaw = '';
let userConfigSyncOverrides: Partial<UserConfig> = {};

function expandHomeDir(value: string): string {
  return value.replace(/^~/, process.env.HOME || '');
}

/**
 * Single canonical config path: ~/.codeclaw/setting.json
 * Both CLI and dashboard read/write this file exclusively.
 */
export function getUserConfigPath(): string {
  const custom = (process.env.CODECLAW_CONFIG || '').trim();
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), '.codeclaw', 'setting.json');
}

function loadJsonFile(filePath: string): Partial<UserConfig> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function loadUserConfig(): Partial<UserConfig> {
  return loadJsonFile(getUserConfigPath());
}

export function getActiveUserConfig(): Partial<UserConfig> {
  return activeUserConfig;
}

export function saveUserConfig(config: Partial<UserConfig>): string {
  const filePath = getUserConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export function updateUserConfig(patch: Partial<UserConfig>): string {
  return saveUserConfig({ ...loadUserConfig(), ...patch });
}

export function resolveUserWorkdir(opts: {
  workdir?: string | null;
  config?: Partial<UserConfig>;
  cwd?: string;
} = {}): string {
  const raw = String(
    opts.workdir
    || opts.config?.defaultWorkdir
    || process.env.CODECLAW_WORKDIR
    || opts.cwd
    || process.cwd(),
  ).trim();
  return path.resolve(expandHomeDir(raw));
}

function buildManagedEnv(config: Partial<UserConfig>): Record<(typeof MANAGED_ENV_KEYS)[number], string> {
  return {
    CODECLAW_CHANNEL: String(config.channel || '').trim(),
    DEFAULT_AGENT: String(config.defaultAgent || '').trim(),
    CODECLAW_WORKDIR: String(config.defaultWorkdir || '').trim()
      ? path.resolve(expandHomeDir(String(config.defaultWorkdir || '').trim()))
      : '',
    TELEGRAM_BOT_TOKEN: String(config.telegramBotToken || '').trim(),
    TELEGRAM_ALLOWED_CHAT_IDS: String(config.telegramAllowedChatIds || '').trim(),
    FEISHU_APP_ID: String(config.feishuAppId || '').trim(),
    FEISHU_APP_SECRET: String(config.feishuAppSecret || '').trim(),
  };
}

function notifyUserConfigListeners(config: Partial<UserConfig>, changedKeys: string[]) {
  for (const listener of userConfigListeners) {
    try {
      listener(config, changedKeys);
    } catch {}
  }
}

function readUserConfigRaw(): string {
  try {
    return fs.readFileSync(getUserConfigPath(), 'utf-8');
  } catch {
    return '';
  }
}

export function onUserConfigChange(listener: UserConfigChangeListener): () => void {
  userConfigListeners.add(listener);
  return () => userConfigListeners.delete(listener);
}

export function applyUserConfig(config: Partial<UserConfig>, _channel?: string, options: ApplyUserConfigOptions = {}): string[] {
  const overwrite = options.overwrite ?? true;
  const clearMissing = options.clearMissing ?? true;
  const notify = options.notify ?? true;
  const managed = buildManagedEnv(config);
  const changedKeys: string[] = [];

  for (const key of MANAGED_ENV_KEYS) {
    const next = managed[key];
    const prev = process.env[key] ?? '';
    if (!next) {
      if (clearMissing && key in process.env) {
        delete process.env[key];
        changedKeys.push(key);
      }
      continue;
    }
    if (!overwrite && prev) continue;
    if (prev !== next) {
      process.env[key] = next;
      changedKeys.push(key);
    }
  }

  activeUserConfig = { ...config };
  if (notify && changedKeys.length) notifyUserConfigListeners(activeUserConfig, changedKeys);
  return changedKeys;
}

export function startUserConfigSync(options: SyncUserConfigOptions = {}): () => void {
  const intervalMs = Math.max(250, Math.round(options.intervalMs ?? 1_000));
  if (options.overrides) userConfigSyncOverrides = { ...options.overrides };

  const syncNow = () => {
    const raw = readUserConfigRaw();
    if (raw === userConfigSyncRaw && userConfigSyncTimer) return;
    userConfigSyncRaw = raw;
    const merged = { ...loadUserConfig(), ...userConfigSyncOverrides };
    const changedKeys = applyUserConfig(merged, undefined, { overwrite: true, clearMissing: true, notify: true });
    if (changedKeys.length) options.log?.(`config reloaded from setting.json (${changedKeys.join(', ')})`);
  };

  syncNow();
  userConfigSyncRefCount++;
  if (!userConfigSyncTimer) {
    userConfigSyncTimer = setInterval(syncNow, intervalMs);
    userConfigSyncTimer.unref?.();
  }

  return () => {
    userConfigSyncRefCount = Math.max(0, userConfigSyncRefCount - 1);
    if (userConfigSyncRefCount > 0 || !userConfigSyncTimer) return;
    clearInterval(userConfigSyncTimer);
    userConfigSyncTimer = null;
    userConfigSyncRaw = '';
    userConfigSyncOverrides = {};
  };
}
