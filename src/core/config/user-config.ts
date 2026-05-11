/**
 * Persistent user configuration (~/.pikiclaw/setting.json) load/save/sync.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../../agent/index.js';
import { USER_CONFIG_SYNC_DEFAULT_INTERVAL_MS } from '../constants.js';
import { expandTilde } from '../platform.js';

export type ChannelName = 'telegram' | 'feishu' | 'weixin' | 'slack' | 'discord' | 'dingtalk' | 'wecom';

/** MCP server configuration — compatible with .mcp.json standard format. */
export interface McpServerConfig {
  /** Transport type (default: stdio). */
  type?: 'stdio' | 'http';
  /** Command to spawn the server (stdio). */
  command?: string;
  /** Arguments for the command (stdio). */
  args?: string[];
  /** Environment variables for the server process. */
  env?: Record<string, string>;
  /** HTTP endpoint URL (http type). */
  url?: string;
  /** HTTP headers (http type). */
  headers?: Record<string, string>;
  /** Whether this server is enabled (default: true). */
  enabled?: boolean;
  /** When true in workspace .mcp.json, overrides a global extension to disable it. */
  disabled?: boolean;
  /** Catalog id this server was installed from (for state lookup). Undefined for custom servers. */
  catalogId?: string;
}

/** OAuth token record stored for a remote MCP server. */
export interface McpOAuthTokenRecord {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  /** Dynamic client registration result or pre-configured. */
  clientId: string;
  clientSecret?: string;
  /** Discovered or pre-declared endpoints. */
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** Resource URL this token is bound to (the MCP server URL). */
  resource: string;
  /** Issuer (authorization server). */
  issuer?: string;
}

export interface WorkspaceEntry {
  /** Absolute path to project directory */
  path: string;
  /** User-defined display name */
  name: string;
  /** Sort order (lower = higher priority) */
  order?: number;
  /** Preferred default agent for this workspace */
  preferredAgent?: string;
  /** When the workspace was registered */
  addedAt: string;
}

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
  geminiReasoningEffort?: string;
  hermesModel?: string;
  hermesReasoningEffort?: string;
  workdir?: string;
  workspaces?: WorkspaceEntry[];
  telegramBotToken?: string;
  telegramAllowedChatIds?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  weixinBaseUrl?: string;
  weixinBotToken?: string;
  weixinAccountId?: string;
  /** Slack — Socket Mode requires both bot token (xoxb-) and app token (xapp-). */
  slackBotToken?: string;
  slackAppToken?: string;
  /** Discord — Bot token from Developer Portal (Bot page). */
  discordBotToken?: string;
  /** DingTalk — Stream Mode auth: AppKey (clientId) + AppSecret (clientSecret). */
  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  /** WeChat Work / 企业微信 智能机器人 — Smart Bot WebSocket auth. */
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomEndpoint?: string;
  browserEnabled?: boolean;
  browserHeadless?: boolean;
  /** Extension configuration — global MCP servers, OAuth tokens, and skills. */
  extensions?: {
    mcp?: Record<string, McpServerConfig>;
    /** OAuth tokens keyed by MCP server id (same key as extensions.mcp). */
    mcpTokens?: Record<string, McpOAuthTokenRecord>;
  };
  /**
   * Model layer — Provider+Profile abstraction for BYOK across all agents.
   * Imported as a structural type so this file stays free of cross-layer deps.
   */
  models?: {
    providers?: Record<string, unknown>;
    profiles?: Record<string, unknown>;
    activeProfileByAgent?: Record<string, string | null>;
  };
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
  'WEIXIN_BASE_URL',
  'WEIXIN_BOT_TOKEN',
  'WEIXIN_ACCOUNT_ID',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'DISCORD_BOT_TOKEN',
  'DINGTALK_CLIENT_ID',
  'DINGTALK_CLIENT_SECRET',
  'WECOM_BOT_ID',
  'WECOM_BOT_SECRET',
  'WECOM_ENDPOINT',
] as const;
const USER_CONFIG_DIRNAME = '.pikiclaw';
const USER_CONFIG_FILENAME = 'setting.json';

let activeUserConfig: Partial<UserConfig> = {};
const userConfigListeners = new Set<UserConfigChangeListener>();
let userConfigSyncTimer: ReturnType<typeof setInterval> | null = null;
let userConfigSyncRefCount = 0;
let userConfigSyncRaw = '';
let userConfigSyncOverrides: Partial<UserConfig> = {};

const expandHomeDir = expandTilde;

/** Normalize workspace entries — resolve paths, deduplicate, sort by order. */
function normalizeWorkspaces(raw: unknown): WorkspaceEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: WorkspaceEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rawPath = typeof (item as any).path === 'string' ? (item as any).path.trim() : '';
    if (!rawPath) continue;
    const resolved = path.resolve(expandHomeDir(rawPath));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    entries.push({
      path: resolved,
      name: typeof (item as any).name === 'string' && (item as any).name.trim()
        ? (item as any).name.trim()
        : path.basename(resolved),
      order: typeof (item as any).order === 'number' ? (item as any).order : entries.length,
      preferredAgent: typeof (item as any).preferredAgent === 'string' && (item as any).preferredAgent.trim()
        ? (item as any).preferredAgent.trim()
        : undefined,
      addedAt: typeof (item as any).addedAt === 'string' && (item as any).addedAt.trim()
        ? (item as any).addedAt
        : new Date().toISOString(),
    });
  }
  entries.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  return entries;
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
  const next: Record<string, unknown> = { ...config };
  const workdir = typeof next.workdir === 'string' && next.workdir.trim() ? next.workdir.trim() : '';
  if (workdir) next.workdir = resolveUserWorkdir({ workdir });
  else delete next.workdir;
  if (typeof next.browserEnabled !== 'boolean' && typeof next.browserUseProfile === 'boolean') {
    next.browserEnabled = next.browserUseProfile;
  }
  if (typeof next.browserHeadless !== 'boolean' && typeof next.browserGuiHeadless === 'boolean') {
    next.browserHeadless = next.browserGuiHeadless;
  }
  delete next.browserUseProfile;
  delete next.browserCdpEndpoint;
  delete next.browserGuiEnabled;
  delete next.browserGuiHeadless;
  delete next.browserGuiIsolated;
  delete next.browserGuiUseExtension;
  delete next.browserGuiExtensionToken;
  if (Array.isArray(next.workspaces)) {
    next.workspaces = normalizeWorkspaces(next.workspaces);
  } else {
    delete next.workspaces;
  }
  return next as Partial<UserConfig>;
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
    WEIXIN_BASE_URL: String(config.weixinBaseUrl || '').trim(),
    WEIXIN_BOT_TOKEN: String(config.weixinBotToken || '').trim(),
    WEIXIN_ACCOUNT_ID: String(config.weixinAccountId || '').trim(),
    SLACK_BOT_TOKEN: String(config.slackBotToken || '').trim(),
    SLACK_APP_TOKEN: String(config.slackAppToken || '').trim(),
    DISCORD_BOT_TOKEN: String(config.discordBotToken || '').trim(),
    DINGTALK_CLIENT_ID: String(config.dingtalkClientId || '').trim(),
    DINGTALK_CLIENT_SECRET: String(config.dingtalkClientSecret || '').trim(),
    WECOM_BOT_ID: String(config.wecomBotId || '').trim(),
    WECOM_BOT_SECRET: String(config.wecomBotSecret || '').trim(),
    WECOM_ENDPOINT: String(config.wecomEndpoint || '').trim(),
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
  // Don't pin workdir into userConfigSyncOverrides: the periodic sync reads
  // setting.json fresh each tick, so an external `npx pikiclaw@latest` that
  // updates the file should be honored, not clobbered by an in-memory lock.
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

// ---------------------------------------------------------------------------
// Workspace registry
// ---------------------------------------------------------------------------

/** Load registered workspaces from config. Returns empty array if none. */
export function loadWorkspaces(): WorkspaceEntry[] {
  const config = loadUserConfig();
  return normalizeWorkspaces(config.workspaces);
}

/** Add a workspace. Returns the new entry. Deduplicates by resolved path. */
export function addWorkspace(workspacePath: string, name?: string): WorkspaceEntry {
  const resolved = path.resolve(expandHomeDir(workspacePath));
  const config = loadUserConfig();
  const workspaces = normalizeWorkspaces(config.workspaces);

  const existing = workspaces.find(w => w.path === resolved);
  if (existing) {
    if (name) existing.name = name;
    saveUserConfig({ ...config, workspaces });
    return existing;
  }

  const entry: WorkspaceEntry = {
    path: resolved,
    name: name?.trim() || path.basename(resolved),
    order: workspaces.length,
    addedAt: new Date().toISOString(),
  };
  workspaces.push(entry);
  saveUserConfig({ ...config, workspaces });
  return entry;
}

/** Remove a workspace by path. Returns true if removed. */
export function removeWorkspace(workspacePath: string): boolean {
  const resolved = path.resolve(expandHomeDir(workspacePath));
  const config = loadUserConfig();
  const workspaces = normalizeWorkspaces(config.workspaces);
  const before = workspaces.length;
  const filtered = workspaces.filter(w => w.path !== resolved);
  if (filtered.length === before) return false;
  saveUserConfig({ ...config, workspaces: filtered });
  return true;
}

/** Rename a workspace. Returns the updated entry or null if not found. */
export function renameWorkspace(workspacePath: string, newName: string): WorkspaceEntry | null {
  const resolved = path.resolve(expandHomeDir(workspacePath));
  const config = loadUserConfig();
  const workspaces = normalizeWorkspaces(config.workspaces);
  const entry = workspaces.find(w => w.path === resolved);
  if (!entry) return null;
  entry.name = newName.trim() || entry.name;
  saveUserConfig({ ...config, workspaces });
  return entry;
}

/** Reorder workspaces by providing paths in desired order. */
export function reorderWorkspaces(orderedPaths: string[]): WorkspaceEntry[] {
  const config = loadUserConfig();
  const workspaces = normalizeWorkspaces(config.workspaces);
  const byPath = new Map(workspaces.map(w => [w.path, w]));
  const reordered: WorkspaceEntry[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < orderedPaths.length; i++) {
    const resolved = path.resolve(expandHomeDir(orderedPaths[i]));
    const entry = byPath.get(resolved);
    if (entry && !seen.has(resolved)) {
      entry.order = i;
      reordered.push(entry);
      seen.add(resolved);
    }
  }

  // Append any workspaces not in the ordered list
  for (const entry of workspaces) {
    if (!seen.has(entry.path)) {
      entry.order = reordered.length;
      reordered.push(entry);
    }
  }

  saveUserConfig({ ...config, workspaces: reordered });
  return reordered;
}

/** Update workspace preferences (preferredAgent, etc.) */
export function updateWorkspace(workspacePath: string, patch: Partial<Pick<WorkspaceEntry, 'name' | 'preferredAgent' | 'order'>>): WorkspaceEntry | null {
  const resolved = path.resolve(expandHomeDir(workspacePath));
  const config = loadUserConfig();
  const workspaces = normalizeWorkspaces(config.workspaces);
  const entry = workspaces.find(w => w.path === resolved);
  if (!entry) return null;
  if (patch.name !== undefined) entry.name = patch.name.trim() || entry.name;
  if (patch.preferredAgent !== undefined) entry.preferredAgent = patch.preferredAgent || undefined;
  if (patch.order !== undefined) entry.order = patch.order;
  saveUserConfig({ ...config, workspaces });
  return entry;
}

/** Find a workspace entry by path. */
export function findWorkspace(workspacePath: string): WorkspaceEntry | null {
  const resolved = path.resolve(expandHomeDir(workspacePath));
  return loadWorkspaces().find(w => w.path === resolved) || null;
}
