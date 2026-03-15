/**
 * dashboard.ts — Web dashboard server for pikiclaw configuration and monitoring.
 *
 * All config is read from / written to ~/.pikiclaw/setting.json (no env vars).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { collectSetupState, isSetupReady, type SetupState } from './onboarding.js';
import { loadUserConfig, saveUserConfig, applyUserConfig, resolveUserWorkdir, setUserWorkdir, hasUserConfigFile, type UserConfig } from './user-config.js';
import { listAgents, getSessionTail, getSessions, listModels, type AgentDetectOptions, type SessionInfo, type SessionListResult, type UsageResult } from './code-agent.js';
import type { Agent } from './code-agent.js';
import { getDriver } from './agent-driver.js';
import type { Bot } from './bot.js';
import { validateFeishuConfig, validateTelegramConfig } from './config-validation.js';
import { getDashboardHtml } from './dashboard-ui.js';
import { shouldCacheChannelStates } from './channel-states.js';
import { resolveGuiIntegrationConfig, type GuiIntegrationConfig } from './mcp-bridge.js';
import {
  formatActiveTaskRestartError,
  getActiveTaskCount,
  registerProcessRuntime,
  requestProcessRestart,
} from './process-control.js';
import { getSessionStatusForBot } from './session-status.js';
import { VERSION } from './version.js';

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

// Codex model discovery has to cold-start the app-server on some machines.
// If we fall back too quickly the dashboard only shows the current model.
const AGENT_STATUS_MODELS_TIMEOUT_MS = 4_000;
const AGENT_STATUS_USAGE_TIMEOUT_MS = 1_500;
const CHANNEL_STATUS_VALIDATION_TIMEOUT_MS = 3_000;
const CHANNEL_STATUS_CACHE_TTL_MS = 20_000;
const DEFAULT_SESSION_PAGE_SIZE = 6;
const MAX_SESSION_PAGE_SIZE = 30;

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

interface PermissionStatus { granted: boolean; checkable: boolean; detail: string }

type DashboardPermissionKey = 'accessibility' | 'screenRecording' | 'fullDiskAccess';
type PermissionRequestAction = 'already_granted' | 'prompted' | 'opened_settings' | 'unsupported';

interface PermissionRequestResult {
  ok: boolean;
  action: PermissionRequestAction;
  granted: boolean;
  requiresManualGrant: boolean;
  error?: string;
}

const permissionPaneUrls: Record<DashboardPermissionKey, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  fullDiskAccess: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
};

function runJxa(script: string, timeout = 5_000): string | null {
  try {
    return String(execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout })).trim().toLowerCase();
  } catch {
    return null;
  }
}

function checkAccessibilityPermission(): boolean | null {
  try {
    execFileSync('osascript', ['-e', 'tell application "System Events" to keystroke ""'], { stdio: 'ignore', timeout: 4_000 });
    return true;
  } catch {}
  const output = runJxa(
    'ObjC.bindFunction("CGPreflightPostEventAccess", ["bool", []]); console.log($.CGPreflightPostEventAccess());',
    4_000,
  );
  if (output == null) return null;
  return output === 'true';
}

function requestAccessibilityPermission(): boolean {
  return runJxa(
    'ObjC.bindFunction("CGRequestPostEventAccess", ["bool", []]); console.log($.CGRequestPostEventAccess());',
    6_000,
  ) !== null;
}

function checkScreenRecordingPermission(): boolean | null {
  const screenshotPath = path.join(os.tmpdir(), `.pikiclaw_perm_test_${process.pid}_${Date.now()}.png`);
  try {
    execFileSync('screencapture', ['-x', screenshotPath], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {} finally {
    try { fs.rmSync(screenshotPath, { force: true }); } catch {}
  }
  const output = runJxa(
    'ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); console.log($.CGPreflightScreenCaptureAccess());',
    4_000,
  );
  if (output == null) return null;
  return output === 'true';
}

function requestScreenRecordingPermission(): boolean {
  return runJxa(
    'ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]); console.log($.CGRequestScreenCaptureAccess());',
    6_000,
  ) !== null;
}

function openPermissionSettings(permission: DashboardPermissionKey): boolean {
  const pane = permissionPaneUrls[permission];
  if (!pane) return false;
  try {
    execFileSync('open', [pane], { stdio: 'ignore', timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/** Walk the process tree upward to find the host terminal / IDE that launched pikiclaw. Works on macOS and Linux. */
function detectHostTerminalApp(): string | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  try {
    // Patterns to match in the comm/exe name (case-insensitive on Linux where names vary)
    // macOS: Terminal, iTerm2, Warp; Linux: gnome-terminal, konsole, xfce4-terminal, xterm, tilix, foot, sakura, terminology
    // Cross-platform: Alacritty, kitty, WezTerm, Hyper, VS Code, Cursor, Windsurf
    const patterns = [
      'Terminal', 'iTerm', 'Warp',
      'Alacritty', 'alacritty', 'kitty', 'WezTerm', 'wezterm', 'Hyper',
      'Code', 'Cursor', 'Windsurf',
      'konsole', 'xfce4-terminal', 'xterm', 'tilix', 'foot', 'sakura', 'terminology', 'tmux', 'screen',
    ];
    const caseList = patterns.map(p => `*${p}*`).join('|');
    const output = execSync(
      `pid=${process.pid} ; while [ "$pid" != "1" ] && [ -n "$pid" ]; do pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' '); comm=$(ps -o comm= -p "$pid" 2>/dev/null); case "$comm" in ${caseList}) echo "$comm"; exit 0;; esac; done`,
      { encoding: 'utf8', timeout: 3_000, shell: '/bin/sh' },
    ).trim();
    if (!output) return null;
    const base = path.basename(output);
    // Map comm name → human-readable display name
    const nameMap: [string, string][] = [
      // macOS
      ['iTerm', 'iTerm2'],
      ['Code Helper', 'VS Code'],
      ['Cursor Helper', 'Cursor'],
      ['Windsurf Helper', 'Windsurf'],
      // Cross-platform IDE wrappers (Linux uses "code" binary directly)
      ['code', 'VS Code'],
      ['cursor', 'Cursor'],
      ['windsurf', 'Windsurf'],
      // Terminal emulators
      ['gnome-terminal', 'GNOME Terminal'],
      ['xfce4-terminal', 'Xfce Terminal'],
      ['Terminal', 'Terminal'],
      ['Warp', 'Warp'],
      ['Alacritty', 'Alacritty'],
      ['alacritty', 'Alacritty'],
      ['kitty', 'kitty'],
      ['WezTerm', 'WezTerm'],
      ['wezterm', 'WezTerm'],
      ['Hyper', 'Hyper'],
      ['konsole', 'Konsole'],
      ['xterm', 'xterm'],
      ['tilix', 'Tilix'],
      ['foot', 'foot'],
      ['sakura', 'Sakura'],
      ['terminology', 'Terminology'],
      ['tmux', 'tmux'],
      ['screen', 'screen'],
    ];
    for (const [key, name] of nameMap) {
      if (base.includes(key)) return name;
    }
    return base;
  } catch {
    return null;
  }
}

function checkPermissions(): Record<string, PermissionStatus> {
  const r: Record<string, PermissionStatus> = {};
  if (process.platform !== 'darwin') {
    r.accessibility = { granted: true, checkable: false, detail: 'N/A' };
    r.screenRecording = { granted: true, checkable: false, detail: 'N/A' };
    r.fullDiskAccess = { granted: true, checkable: false, detail: 'N/A' };
    return r;
  }
  const accessibilityGranted = checkAccessibilityPermission();
  r.accessibility = {
    granted: accessibilityGranted === true,
    checkable: true,
    detail: accessibilityGranted === true ? '已授权' : '未授权',
  };

  const screenRecordingGranted = checkScreenRecordingPermission();
  r.screenRecording = {
    granted: screenRecordingGranted === true,
    checkable: true,
    detail: screenRecordingGranted === true ? '已授权' : '未授权',
  };

  try {
    execSync(`ls "${os.homedir()}/Library/Mail" 2>/dev/null`, { timeout: 3000 });
    r.fullDiskAccess = { granted: true, checkable: true, detail: '已授权' };
  } catch { r.fullDiskAccess = { granted: false, checkable: true, detail: '未授权' }; }
  return r;
}

function requestPermission(permission: DashboardPermissionKey): PermissionRequestResult {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      action: 'unsupported',
      granted: true,
      requiresManualGrant: false,
      error: 'Permission requests are only supported on macOS.',
    };
  }

  const current = checkPermissions()[permission];
  if (current?.granted) {
    return {
      ok: true,
      action: 'already_granted',
      granted: true,
      requiresManualGrant: false,
    };
  }

  if (permission === 'accessibility') {
    const prompted = requestAccessibilityPermission();
    if (!prompted) {
      const openedSettings = openPermissionSettings(permission);
      return openedSettings
        ? { ok: true, action: 'opened_settings', granted: false, requiresManualGrant: true }
        : { ok: false, action: 'unsupported', granted: false, requiresManualGrant: true, error: 'Failed to trigger Accessibility permission request.' };
    }
    return {
      ok: true,
      action: 'prompted',
      granted: !!checkPermissions().accessibility?.granted,
      requiresManualGrant: true,
    };
  }

  if (permission === 'screenRecording') {
    const prompted = requestScreenRecordingPermission();
    if (!prompted) {
      const openedSettings = openPermissionSettings(permission);
      return openedSettings
        ? { ok: true, action: 'opened_settings', granted: false, requiresManualGrant: true }
        : { ok: false, action: 'unsupported', granted: false, requiresManualGrant: true, error: 'Failed to trigger Screen Recording permission request.' };
    }
    return {
      ok: true,
      action: 'prompted',
      granted: !!checkPermissions().screenRecording?.granted,
      requiresManualGrant: true,
    };
  }

  if (permission === 'fullDiskAccess') {
    const openedSettings = openPermissionSettings(permission);
    return openedSettings
      ? { ok: true, action: 'opened_settings', granted: false, requiresManualGrant: true }
      : { ok: false, action: 'unsupported', granted: false, requiresManualGrant: true, error: 'Failed to open Full Disk Access settings.' };
  }

  return { ok: false, action: 'unsupported', granted: false, requiresManualGrant: true, error: 'Unknown permission.' };
}

async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Appium lifecycle management
// ---------------------------------------------------------------------------

const APPIUM_INSTALL_DIR = path.join(os.homedir(), '.pikiclaw', 'appium');
let managedAppiumProc: ChildProcess | null = null;

function findAppiumBin(): string | null {
  const localBin = path.join(APPIUM_INSTALL_DIR, 'node_modules', '.bin', 'appium');
  if (fs.existsSync(localBin)) return localBin;
  try {
    const result = execFileSync('which', ['appium'], { encoding: 'utf-8', timeout: 5_000 });
    return result.trim() || null;
  } catch { return null; }
}

function isAppiumInstalled(): boolean {
  const bin = findAppiumBin();
  if (!bin) return false;
  try {
    const out = execFileSync(bin, ['driver', 'list', '--installed', '--json'], { encoding: 'utf-8', timeout: 15_000 });
    return out.includes('mac2');
  } catch { return false; }
}

async function installAppium(log: (msg: string) => void): Promise<string> {
  fs.mkdirSync(APPIUM_INSTALL_DIR, { recursive: true });
  const pkgPath = path.join(APPIUM_INSTALL_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) fs.writeFileSync(pkgPath, '{"private":true}');

  const existingBin = findAppiumBin();
  if (!existingBin) {
    log('Installing Appium...');
    execFileSync('npm', ['install', '--save', 'appium'], { cwd: APPIUM_INSTALL_DIR, stdio: 'pipe', timeout: 300_000 });
  }
  const bin = findAppiumBin();
  if (!bin) throw new Error('Appium binary not found after install');

  try {
    const out = execFileSync(bin, ['driver', 'list', '--installed', '--json'], { encoding: 'utf-8', timeout: 15_000 });
    if (!out.includes('mac2')) {
      log('Installing Mac2 driver...');
      execFileSync(bin, ['driver', 'install', 'mac2'], { stdio: 'pipe', timeout: 120_000 });
    }
  } catch {
    log('Installing Mac2 driver...');
    execFileSync(bin, ['driver', 'install', 'mac2'], { stdio: 'pipe', timeout: 120_000 });
  }

  log('Appium installation complete.');
  return bin;
}

function checkAppiumReachable(appiumUrl: string): Promise<boolean> {
  return new Promise(resolve => {
    const url = new URL('/status', appiumUrl);
    const req = http.get(url, { timeout: 3_000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startManagedAppium(appiumUrl: string, log: (msg: string) => void): Promise<void> {
  if (await checkAppiumReachable(appiumUrl)) {
    log('Appium server is already running.');
    return;
  }
  stopManagedAppium();

  const bin = findAppiumBin();
  if (!bin) throw new Error('Appium is not installed');

  const port = new URL(appiumUrl).port || '4723';
  log('Starting Appium server...');
  managedAppiumProc = spawn(bin, ['--port', port, '--log-level', 'warn'], { stdio: 'ignore' });
  managedAppiumProc.unref();
  managedAppiumProc.on('exit', () => { managedAppiumProc = null; });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1_000));
    if (await checkAppiumReachable(appiumUrl)) {
      log('Appium server is ready.');
      return;
    }
  }
  stopManagedAppium();
  throw new Error('Appium server failed to start within 30 seconds');
}

function stopManagedAppium(): void {
  if (managedAppiumProc && !managedAppiumProc.killed) {
    managedAppiumProc.kill();
    managedAppiumProc = null;
  }
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function dashboardLog(message: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[dashboard ${ts}] ${message}\n`);
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
    if (shouldCacheChannelStates(channels)) {
      channelStateCache = {
        key,
        expiresAt: now + CHANNEL_STATUS_CACHE_TTL_MS,
        channels,
      };
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
      case 'claude': return String(config.claudeModel || '').trim() || undefined;
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
    return String(runtimePrefs.models[agent] || configModel(config, agent) || modelEnv(agent) || defaultModels[agent]).trim();
  }

  function getRuntimeEffort(agent: Agent, config = loadUserConfig()): string | null {
    if (agent === 'gemini') return null;
    if (botRef) return botRef.effortForAgent(agent);
    const value = String(runtimePrefs.efforts[agent] || configEffort(config, agent) || effortEnv(agent) || defaultEfforts[agent] || '').trim().toLowerCase();
    return value || null;
  }

  async function buildAgentStatusResponse(config = loadUserConfig()) {
    const setupState = getSetupState(config, { includeVersion: true });
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

      const selectedModel = getRuntimeModel(agentId, config);
      const selectedEffort = getRuntimeEffort(agentId, config);
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
          configExists: hasUserConfigFile(),
          config,
          runtimeWorkdir: getRuntimeWorkdir(config),
          setupState,
          permissions,
          hostApp: detectHostTerminalApp(),
          platform: process.platform,
          pid: process.pid,
          nodeVersion: process.versions.node,
          bot: botRef ? {
            workdir: botRef.workdir,
            defaultAgent: botRef.defaultAgent,
            uptime: Date.now() - botRef.startedAt,
            connected: botRef.connected,
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
        return json(res, { agents: getSetupState(loadUserConfig(), { includeVersion: true }).agents });
      }

      // Sessions (per agent)
      if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && method === 'GET') {
        const agent = url.pathname.split('/')[3] as Agent;
        const config = loadUserConfig();
        const workdir = getRequestWorkdir(config);
        const page = parsePageNumber(url.searchParams.get('page'));
        const limit = parsePageSize(url.searchParams.get('limit'));
        dashboardLog(
          `[sessions] endpoint=single agent=${agent} resolvedWorkdir=${workdir} exists=${fs.existsSync(workdir)} ` +
          `configWorkdir=${String(config.workdir || '(none)')} botWorkdir=${botRef?.workdir || '(none)'} ` +
          `page=${page} limit=${limit}`
        );
        const result = await getSessions({ agent, workdir });
        const paged = paginateSessionResult(enrichSessionResultWithRuntimeStatus(result, botRef), page, limit);
        dashboardLog(
          `[sessions] endpoint=single agent=${agent} ok=${paged.ok} total=${paged.total} ` +
          `returned=${paged.sessions.length} error=${paged.error || '(none)'}`
        );
        return json(res, paged);
      }

      // All sessions (all agents, for swim lane view)
      if (url.pathname === '/api/sessions' && method === 'GET') {
        const config = loadUserConfig();
        const workdir = getRequestWorkdir(config);
        const page = parsePageNumber(url.searchParams.get('page'));
        const limit = parsePageSize(url.searchParams.get('limit'));
        dashboardLog(
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
          dashboardLog(
            `[sessions] endpoint=all agent=${a.agent} ok=${!!paged?.ok} total=${paged?.total ?? 0} ` +
            `returned=${Array.isArray(paged?.sessions) ? paged.sessions.length : 0} error=${paged?.error || '(none)'}`
          );
        }));
        return json(res, result);
      }

      // Session detail (tail messages)
      if (url.pathname.match(/^\/api\/session-detail\/[^/]+\/[^/]+$/) && method === 'GET') {
        const parts = url.pathname.split('/');
        const agent = parts[3] as Agent;
        const sessionId = decodeURIComponent(parts[4]);
        const config = loadUserConfig();
        const workdir = getRequestWorkdir(config);
        const limit = parseInt(url.searchParams.get('limit') || '6', 10);
        dashboardLog(
          `[sessions] endpoint=detail agent=${agent} session=${sessionId} limit=${limit} resolvedWorkdir=${workdir} ` +
          `exists=${fs.existsSync(workdir)} configWorkdir=${String(config.workdir || '(none)')} botWorkdir=${botRef?.workdir || '(none)'}`
        );
        const tail = await getSessionTail({ agent, sessionId, workdir, limit });
        dashboardLog(`[sessions] endpoint=detail agent=${agent} session=${sessionId} ok=${tail.ok} messages=${tail.messages.length} error=${tail.error || '(none)'}`);
        return json(res, tail);
      }

      // Permissions
      if (url.pathname === '/api/permissions' && method === 'GET') {
        return json(res, { ...checkPermissions(), hostApp: detectHostTerminalApp() });
      }

      // Save config (to ~/.pikiclaw/setting.json)
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
        const nextConfig: Partial<UserConfig> = { ...config };
        const defaultAgent = body?.defaultAgent;
        const targetAgent = body?.agent;
        const model = typeof body?.model === 'string' ? body.model.trim() : '';
        const effort = typeof body?.effort === 'string' ? body.effort.trim().toLowerCase() : '';

        if (defaultAgent != null) {
          if (!isAgent(defaultAgent)) return json(res, { ok: false, error: 'Invalid defaultAgent' }, 400);
          runtimePrefs.defaultAgent = defaultAgent;
          process.env.DEFAULT_AGENT = defaultAgent;
          nextConfig.defaultAgent = defaultAgent;
          if (botRef) botRef.setDefaultAgent(defaultAgent);
        }

        if (model || effort) {
          if (!isAgent(targetAgent)) return json(res, { ok: false, error: 'Invalid agent' }, 400);
          if (model) {
            runtimePrefs.models[targetAgent] = model;
            setModelEnv(targetAgent, model);
            if (targetAgent === 'claude') nextConfig.claudeModel = model;
            if (targetAgent === 'codex') nextConfig.codexModel = model;
            if (targetAgent === 'gemini') nextConfig.geminiModel = model;
            if (botRef) botRef.setModelForAgent(targetAgent, model);
          }
          if (effort && targetAgent !== 'gemini') {
            runtimePrefs.efforts[targetAgent] = effort;
            setEffortEnv(targetAgent, effort);
            if (targetAgent === 'claude') nextConfig.claudeReasoningEffort = effort;
            if (targetAgent === 'codex') nextConfig.codexReasoningEffort = effort;
            if (botRef) botRef.setEffortForAgent(targetAgent, effort);
          }
        }

        saveUserConfig(nextConfig);
        applyUserConfig(nextConfig);
        return json(res, { ok: true, ...(await buildAgentStatusResponse(nextConfig)) });
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
        const permission = String(body.permission || '') as DashboardPermissionKey;
        if (!permissionPaneUrls[permission]) {
          return json(res, {
            ok: false,
            action: 'unsupported',
            granted: false,
            requiresManualGrant: false,
            error: 'Invalid permission.',
          }, 400);
        }
        const result = requestPermission(permission);
        dashboardLog(
          `[permissions] permission=${permission} action=${result.action} granted=${result.granted} manual=${result.requiresManualGrant} ok=${result.ok}`
        );
        return json(res, result, result.ok ? 200 : 500);
      }

      // Restart process
      if (url.pathname === '/api/restart' && method === 'POST') {
        const activeTasks = getActiveTaskCount();
        if (activeTasks > 0) {
          return json(res, { ok: false, error: formatActiveTaskRestartError(activeTasks) }, 409);
        }
        json(res, { ok: true });
        setTimeout(() => {
          void requestProcessRestart({ log: message => dashboardLog(message) });
        }, 50);
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
        const saved = setUserWorkdir(resolvedPath);
        return json(res, { ok: true, workdir: saved.workdir });
      }

      // Extension config status
      if (url.pathname === '/api/extensions' && method === 'GET') {
        const config = loadUserConfig();
        const gui = resolveGuiIntegrationConfig(config);
        const installed = isAppiumInstalled();
        return json(res, {
          browser: {
            hasToken: !!gui.browserExtensionToken,
            token: gui.browserExtensionToken || '',
          },
          desktop: {
            enabled: gui.desktopEnabled,
            installed,
            running: managedAppiumProc != null && !managedAppiumProc.killed,
            appiumUrl: gui.desktopAppiumUrl,
          },
        });
      }

      // Save extension token and validate
      if (url.pathname === '/api/save-extension-token' && method === 'POST') {
        const body = await parseJsonBody(req);
        const token = String(body.token || '').trim();
        if (!token) return json(res, { ok: false, error: 'Token is required' }, 400);

        // Validate by spawning Playwright MCP with the token — if the process starts
        // and emits valid JSON-RPC output, the token is valid.
        dashboardLog('[extensions] validating extension token...');
        try {
          const { spawn } = await import('node:child_process');
          const proc = spawn('npx', ['-y', '@playwright/mcp@latest', '--extension'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token },
            timeout: 12_000,
          });
          let stdout = '';
          proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
          let stderr = '';
          proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
          const exitCode = await new Promise<number | null>((resolve) => {
            const timer = setTimeout(() => {
              // Process staying alive means it connected successfully (MCP stdio server)
              proc.kill('SIGTERM');
              resolve(0);
            }, 5_000);
            proc.on('exit', (code) => { clearTimeout(timer); resolve(code); });
            proc.on('error', () => { clearTimeout(timer); resolve(1); });
          });

          // If the process started and didn't immediately exit with an error, the token is good.
          // MCP stdio servers stay alive waiting for input, so a timeout kill is expected success.
          const valid = exitCode === 0 || exitCode === null;
          if (valid) {
            const config = loadUserConfig();
            saveUserConfig({ ...config, browserGuiExtensionToken: token });
            applyUserConfig(loadUserConfig());
            dashboardLog('[extensions] extension token saved and validated');
            return json(res, { ok: true, valid: true });
          }
          dashboardLog(`[extensions] token validation failed: exit=${exitCode} stderr=${stderr.slice(0, 200)}`);
          return json(res, { ok: false, error: 'Token validation failed — the extension did not accept this token.' });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          dashboardLog(`[extensions] token validation error: ${detail}`);
          return json(res, { ok: false, error: detail }, 500);
        }
      }

      // Desktop: install Appium + Mac2 driver
      if (url.pathname === '/api/desktop-install' && method === 'POST') {
        if (process.platform !== 'darwin') {
          return json(res, { ok: false, error: 'Desktop automation is only supported on macOS' }, 400);
        }
        dashboardLog('[desktop] install requested');
        try {
          await installAppium(msg => dashboardLog(`[desktop] ${msg}`));
          return json(res, { ok: true, installed: true });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          dashboardLog(`[desktop] install failed: ${detail}`);
          return json(res, { ok: false, error: detail }, 500);
        }
      }

      // Desktop: toggle enable/disable (start/stop Appium)
      if (url.pathname === '/api/desktop-toggle' && method === 'POST') {
        const body = await parseJsonBody(req);
        const enabled = !!body.enabled;
        dashboardLog(`[desktop] toggle enabled=${enabled}`);
        try {
          const config = loadUserConfig();
          if (enabled) {
            const gui = resolveGuiIntegrationConfig(config);
            if (!isAppiumInstalled()) {
              await installAppium(msg => dashboardLog(`[desktop] ${msg}`));
            }
            await startManagedAppium(gui.desktopAppiumUrl, msg => dashboardLog(`[desktop] ${msg}`));
            saveUserConfig({ ...config, desktopGuiEnabled: true });
            applyUserConfig(loadUserConfig());
          } else {
            stopManagedAppium();
            saveUserConfig({ ...config, desktopGuiEnabled: false });
            applyUserConfig(loadUserConfig());
          }
          return json(res, { ok: true, enabled });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          dashboardLog(`[desktop] toggle failed: ${detail}`);
          return json(res, { ok: false, error: detail }, 500);
        }
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
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') server.listen(preferredPort + 1, onListening);
      else reject(err);
    });
    server.on('close', () => {
      unregisterProcessRuntime();
    });

    function onListening() {
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

    server.listen(preferredPort, onListening);
  });
}
