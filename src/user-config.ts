import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from './code-agent.js';
import { USER_CONFIG_SYNC_DEFAULT_INTERVAL_MS } from './constants.js';

export type ChannelName = 'telegram' | 'feishu' | 'whatsapp';

export interface UserConfig {
  version: 1;
  channel?: ChannelName;
  /** Launch multiple channels simultaneously (comma-separated or array). */
  channels?: ChannelName[];
  defaultAgent?: Agent;
  agentAutoUpdate?: boolean;
  claudeModel?: string;
  claudeReasoningEffort?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  geminiModel?: string;
  workdir?: string;
  telegramBotToken?: string;
  telegramAllowedChatIds?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  browserGuiEnabled?: boolean;
  browserGuiHeadless?: boolean;
  browserGuiIsolated?: boolean;
  browserGuiUseExtension?: boolean;
  browserGuiExtensionToken?: string;
  desktopGuiEnabled?: boolean;
  desktopAppiumUrl?: string;
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
  'PIKICLAW_CHANNEL',
  'PIKICLAW_WORKDIR',
  'DEFAULT_AGENT',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
] as const;
const USER_CONFIG_DIRNAME = '.pikiclaw';
const USER_CONFIG_FILENAME = 'setting.json';

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
 * Single canonical config path: ~/.pikiclaw/setting.json
 * Both CLI and dashboard read/write this file exclusively.
 */
export function getDevUserConfigPath(): string {
  return path.join(os.homedir(), USER_CONFIG_DIRNAME, 'dev', USER_CONFIG_FILENAME);
}

export function getUserConfigPath(): string {
  const custom = (process.env.PIKICLAW_CONFIG || '').trim();
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), USER_CONFIG_DIRNAME, USER_CONFIG_FILENAME);
}

function loadJsonFile(filePath: string): Partial<UserConfig> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? normalizeUserConfig(parsed) : {};
  } catch {
    return {};
  }
}

function normalizeUserConfig(config: Partial<UserConfig>): Partial<UserConfig> {
  const next = { ...config };
  const workdir = typeof next.workdir === 'string' && next.workdir.trim() ? next.workdir.trim() : '';
  if (workdir) next.workdir = resolveUserWorkdir({ workdir });
  else delete next.workdir;
  return next;
}

export function loadUserConfig(): Partial<UserConfig> {
  return loadJsonFile(getUserConfigPath());
}

export function hasUserConfigFile(): boolean {
  try {
    return fs.existsSync(getUserConfigPath());
  } catch {
    return false;
  }
}

export function getActiveUserConfig(): Partial<UserConfig> {
  return activeUserConfig;
}

export function saveUserConfig(config: Partial<UserConfig>): string {
  const filePath = getUserConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, ...normalizeUserConfig(config) }, null, 2)}\n`, { mode: 0o600 });
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
    || opts.config?.workdir
    || process.env.PIKICLAW_WORKDIR
    || opts.cwd
    || process.cwd(),
  ).trim();
  return path.resolve(expandHomeDir(raw));
}

function buildManagedEnv(config: Partial<UserConfig>): Record<(typeof MANAGED_ENV_KEYS)[number], string> {
  const configuredWorkdir = config.workdir || '';
  return {
    PIKICLAW_CHANNEL: String(config.channel || '').trim(),
    PIKICLAW_WORKDIR: configuredWorkdir ? resolveUserWorkdir({ workdir: configuredWorkdir }) : '',
    DEFAULT_AGENT: String(config.defaultAgent || '').trim(),
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

function configValuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return a === b;
}

function diffConfigKeys(prev: Partial<UserConfig>, next: Partial<UserConfig>): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (!configValuesEqual(prev[key as keyof UserConfig], next[key as keyof UserConfig])) changed.push(key);
  }
  return changed;
}

export function applyUserConfig(config: Partial<UserConfig>, _channel?: string, options: ApplyUserConfigOptions = {}): string[] {
  const overwrite = options.overwrite ?? true;
  const clearMissing = options.clearMissing ?? true;
  const notify = options.notify ?? true;
  const managed = buildManagedEnv(config);
  const changedKeys: string[] = [];
  const prevConfig = activeUserConfig;

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
  const configChangedKeys = diffConfigKeys(prevConfig, activeUserConfig);
  const notifyKeys = [...new Set([...changedKeys, ...configChangedKeys])];
  if (notify && notifyKeys.length) notifyUserConfigListeners(activeUserConfig, notifyKeys);
  return changedKeys;
}

export function setUserWorkdir(workdir: string, options: { notify?: boolean } = {}): {
  configPath: string;
  workdir: string;
  config: Partial<UserConfig>;
} {
  const resolvedWorkdir = resolveUserWorkdir({ workdir });
  const config = normalizeUserConfig({ ...loadUserConfig(), workdir: resolvedWorkdir });
  const configPath = saveUserConfig(config);
  // Update sync overrides so the periodic config sync doesn't revert the change
  if (userConfigSyncOverrides.workdir !== undefined || userConfigSyncTimer) {
    userConfigSyncOverrides = { ...userConfigSyncOverrides, workdir: resolvedWorkdir };
  }
  applyUserConfig(config, undefined, { overwrite: true, clearMissing: true, notify: options.notify ?? true });
  return { configPath, workdir: resolvedWorkdir, config };
}

export function startUserConfigSync(options: SyncUserConfigOptions = {}): () => void {
  const intervalMs = Math.max(250, Math.round(options.intervalMs ?? USER_CONFIG_SYNC_DEFAULT_INTERVAL_MS));
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
