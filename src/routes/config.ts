/**
 * routes/config.ts — Hono route module for config, channel, extension,
 * permission, browser, and desktop API routes.
 *
 * Ported from dashboard-routes-config.ts.
 */

import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadUserConfig, saveUserConfig, applyUserConfig, hasUserConfigFile } from '../user-config.js';
import { isSetupReady } from '../onboarding.js';
import { validateFeishuConfig, validateTelegramConfig, validateWeixinConfig } from '../config-validation.js';
import { resolveGuiIntegrationConfig } from '../mcp-bridge.js';
import {
  normalizeWeixinBaseUrl,
  startWeixinQrLogin,
  waitForWeixinQrLogin,
} from '../weixin-api.js';
import {
  getManagedBrowserStatus,
  launchManagedBrowserSetup,
} from '../browser-profile.js';
import {
  formatActiveTaskRestartError,
  getActiveTaskCount,
  requestProcessRestart,
} from '../process-control.js';
import {
  checkPermissions,
  detectHostTerminalApp,
  installAppium,
  isAppiumInstalled,
  isManagedAppiumRunning,
  isValidPermissionKey,
  requestPermission,
  startManagedAppium,
  stopManagedAppium,
} from '../dashboard-platform.js';
import { VERSION } from '../version.js';
import { runtime } from '../runtime.js';
import { writeScopedLog } from '../logging.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildBrowserStatusResponse(config = loadUserConfig(), browserState = getManagedBrowserStatus()) {
  const gui = resolveGuiIntegrationConfig(config);
  const installed = isAppiumInstalled();
  return {
    browser: {
      status: gui.browserEnabled ? browserState.status : 'disabled',
      enabled: gui.browserEnabled,
      headlessMode: gui.browserHeadless ? 'headless' : 'headed',
      chromeInstalled: browserState.chromeInstalled,
      profileCreated: browserState.profileCreated,
      running: browserState.running,
      pid: browserState.pid,
      profileDir: browserState.profileDir || gui.browserProfileDir,
      detail: gui.browserEnabled
        ? browserState.detail
        : 'Browser automation is disabled. No browser MCP server will be injected into agent sessions. On macOS, operate your main browser directly with open, osascript, and screencapture when needed.',
    },
    desktop: {
      enabled: gui.desktopEnabled,
      installed,
      running: isManagedAppiumRunning(),
      appiumUrl: gui.desktopAppiumUrl,
    },
  };
}

type OpenTarget = 'vscode' | 'cursor' | 'windsurf' | 'finder' | 'default';

function isOpenTarget(value: unknown): value is OpenTarget {
  return value === 'vscode'
    || value === 'cursor'
    || value === 'windsurf'
    || value === 'finder'
    || value === 'default';
}

function runOpenCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 0) !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(detail || `Failed to run ${command} ${args.join(' ')}`);
  }
}

function openPathWithTarget(filePath: string, target: OpenTarget, isDirectory: boolean) {
  if (process.platform === 'darwin') {
    switch (target) {
      case 'finder':
        runOpenCommand('open', isDirectory ? [filePath] : ['-R', filePath]);
        return;
      case 'default':
        runOpenCommand('open', [filePath]);
        return;
      case 'cursor':
        runOpenCommand('open', ['-a', 'Cursor', filePath]);
        return;
      case 'windsurf':
        runOpenCommand('open', ['-a', 'Windsurf', filePath]);
        return;
      case 'vscode':
      default:
        runOpenCommand('open', ['-a', 'Visual Studio Code', filePath]);
        return;
    }
  }

  if (process.platform === 'win32') {
    switch (target) {
      case 'cursor':
        runOpenCommand('cursor', [filePath]);
        return;
      case 'windsurf':
        runOpenCommand('windsurf', [filePath]);
        return;
      case 'finder':
      case 'default':
        runOpenCommand('cmd', ['/c', 'start', '', filePath]);
        return;
      case 'vscode':
      default:
        runOpenCommand('code', [filePath]);
        return;
    }
  }

  switch (target) {
    case 'cursor':
      runOpenCommand('cursor', [filePath]);
      return;
    case 'windsurf':
      runOpenCommand('windsurf', [filePath]);
      return;
    case 'finder':
    case 'default':
      runOpenCommand('xdg-open', [filePath]);
      return;
    case 'vscode':
    default:
      runOpenCommand('code', [filePath]);
      return;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const app = new Hono();

// Full state (config from file only)
app.get('/api/state', async (c) => {
  const config = loadUserConfig();
  const setupState = await runtime.buildValidatedSetupState(config);
  const permissions = checkPermissions();
  const botRef = runtime.getBotRef();
  return c.json({
    version: VERSION,
    ready: isSetupReady(setupState),
    configExists: hasUserConfigFile(),
    config,
    runtimeWorkdir: runtime.getRuntimeWorkdir(config),
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
});

// Host info
app.get('/api/host', (c) => {
  const botRef = runtime.getBotRef();
  if (botRef) return c.json(botRef.getHostData());
  const cpus = os.cpus();
  const [one, five, fifteen] = os.loadavg();
  return c.json({
    hostName: os.hostname(), cpuModel: cpus[0]?.model || 'unknown',
    cpuCount: cpus.length, totalMem: os.totalmem(), freeMem: os.freemem(),
    loadAverage: { one, five, fifteen },
    platform: process.platform, arch: os.arch(),
  });
});

// Permissions
app.get('/api/permissions', (c) => {
  const data = { ...checkPermissions(), hostApp: detectHostTerminalApp() };
  return c.json(data);
});

// Save config (to ~/.pikiclaw/setting.json)
app.post('/api/config', async (c) => {
  const body = await c.req.json();
  const merged = { ...loadUserConfig(), ...body };
  const configPath = saveUserConfig(merged);
  applyUserConfig(loadUserConfig());
  return c.json({ ok: true, configPath });
});

// Validate Telegram token
app.post('/api/validate-telegram-token', async (c) => {
  const body = await c.req.json();
  const result = await validateTelegramConfig(body.token || '', body.allowedChatIds || '');
  return c.json({
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    bot: result.bot,
    normalizedAllowedChatIds: result.normalizedAllowedChatIds,
  });
});

// Validate Feishu credentials
app.post('/api/validate-feishu-config', async (c) => {
  const body = await c.req.json();
  const startedAt = Date.now();
  const rawAppId = String(body.appId || '').trim();
  const maskedAppId = !rawAppId
    ? '(missing)'
    : rawAppId.length <= 10
      ? rawAppId
      : `${rawAppId.slice(0, 6)}...${rawAppId.slice(-4)}`;
  writeScopedLog('dashboard', `[feishu-config] request app=${maskedAppId}`, { level: 'debug' });
  const result = await validateFeishuConfig(body.appId || '', body.appSecret || '');
  writeScopedLog(
    'dashboard',
    `[feishu-config] result app=${maskedAppId} ok=${result.state.ready} status=${result.state.status} elapsedMs=${Date.now() - startedAt}`,
    { level: 'debug' },
  );
  return c.json({
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    app: result.app,
  });
});

// Validate Weixin credentials
app.post('/api/validate-weixin-config', async (c) => {
  const body = await c.req.json();
  const result = await validateWeixinConfig(body.baseUrl || '', body.botToken || '', body.accountId || '');
  return c.json({
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    account: result.account,
    normalizedBaseUrl: result.normalizedBaseUrl,
  });
});

// Start Weixin QR login
app.post('/api/weixin-login/start', async (c) => {
  const body = await c.req.json();
  const result = await startWeixinQrLogin({
    baseUrl: normalizeWeixinBaseUrl(body.baseUrl || ''),
    sessionKey: body.sessionKey || undefined,
  });
  return c.json(result, result.ok ? 200 : 500);
});

// Wait for Weixin QR login
app.post('/api/weixin-login/wait', async (c) => {
  const body = await c.req.json();
  const result = await waitForWeixinQrLogin({
    baseUrl: normalizeWeixinBaseUrl(body.baseUrl || ''),
    sessionKey: String(body.sessionKey || '').trim(),
  });
  return c.json(result, result.ok ? 200 : 500);
});

// Open macOS preferences
app.post('/api/open-preferences', async (c) => {
  const body = await c.req.json();
  const permission = String(body.permission || '');
  if (!isValidPermissionKey(permission)) {
    return c.json({
      ok: false,
      action: 'unsupported',
      granted: false,
      requiresManualGrant: false,
      error: 'Invalid permission.',
    }, 400);
  }
  const result = requestPermission(permission);
  runtime.log(
    `[permissions] permission=${permission} action=${result.action} granted=${result.granted} manual=${result.requiresManualGrant} ok=${result.ok}`
  );
  return c.json(result, result.ok ? 200 : 500);
});

// Restart process
app.post('/api/restart', (c) => {
  const activeTasks = getActiveTaskCount();
  if (activeTasks > 0) {
    return c.json({ ok: false, error: formatActiveTaskRestartError(activeTasks) }, 409);
  }
  setTimeout(() => {
    void requestProcessRestart({ log: message => runtime.log(message) });
  }, 50);
  return c.json({ ok: true });
});

// Switch workdir
app.post('/api/switch-workdir', async (c) => {
  const body = await c.req.json();
  const newPath = body.path;
  if (!newPath) return c.json({ ok: false, error: 'Missing path' }, 400);
  const resolvedPath = path.resolve(String(newPath).replace(/^~/, process.env.HOME || ''));
  const botRef = runtime.getBotRef();
  if (botRef) {
    botRef.switchWorkdir(resolvedPath);
    return c.json({ ok: true, workdir: botRef.workdir });
  }
  const { setUserWorkdir } = await import('../user-config.js');
  const saved = setUserWorkdir(resolvedPath);
  return c.json({ ok: true, workdir: saved.workdir });
});

// Browser profile status
app.get('/api/browser', async (c) => {
  const config = loadUserConfig();
  const data = await buildBrowserStatusResponse(config);
  return c.json(data);
});

// Launch managed browser profile for login/setup
app.post('/api/browser/setup', async (c) => {
  runtime.log('[browser] setup requested');
  try {
    const config = loadUserConfig();
    const gui = resolveGuiIntegrationConfig(config);
    if (!gui.browserEnabled) {
      return c.json({
        ok: false,
        error: 'Browser automation is disabled. Enable it first if you want pikiclaw to launch the managed browser profile.',
      }, 400);
    }
    const launch = launchManagedBrowserSetup();
    runtime.log(`[browser] launched managed profile at ${launch.profileDir} pid=${launch.pid ?? 'unknown'}`);
    const payload = await buildBrowserStatusResponse(config, launch);
    return c.json({
      ok: true,
      browser: {
        ...payload.browser,
        detail: launch.running
          ? 'Managed browser is open. Sign in to the sites you want pikiclaw to reuse. If it is still open later, pikiclaw will close it automatically before browser automation starts.'
          : payload.browser.detail,
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.log(`[browser] setup failed: ${detail}`);
    return c.json({ ok: false, error: detail }, 500);
  }
});

// Desktop: install Appium + Mac2 driver
app.post('/api/desktop-install', async (c) => {
  if (process.platform !== 'darwin') {
    return c.json({ ok: false, error: 'Desktop automation is only supported on macOS' }, 400);
  }
  runtime.log('[desktop] install requested');
  try {
    await installAppium(msg => runtime.log(`[desktop] ${msg}`));
    return c.json({ ok: true, installed: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.log(`[desktop] install failed: ${detail}`);
    return c.json({ ok: false, error: detail }, 500);
  }
});

// Desktop: toggle enable/disable (start/stop Appium)
app.post('/api/desktop-toggle', async (c) => {
  const body = await c.req.json();
  const enabled = !!body.enabled;
  runtime.log(`[desktop] toggle enabled=${enabled}`);
  try {
    const config = loadUserConfig();
    if (enabled) {
      const gui = resolveGuiIntegrationConfig(config);
      if (!isAppiumInstalled()) {
        await installAppium(msg => runtime.log(`[desktop] ${msg}`));
      }
      await startManagedAppium(gui.desktopAppiumUrl, msg => runtime.log(`[desktop] ${msg}`));
      saveUserConfig({ ...config, desktopGuiEnabled: true });
      applyUserConfig(loadUserConfig());
    } else {
      stopManagedAppium();
      saveUserConfig({ ...config, desktopGuiEnabled: false });
      applyUserConfig(loadUserConfig());
    }
    return c.json({ ok: true, enabled });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.log(`[desktop] toggle failed: ${detail}`);
    return c.json({ ok: false, error: detail }, 500);
  }
});

// List directory entries for tree browser
app.get('/api/ls-dir', (c) => {
  const dir = c.req.query('path') || os.homedir();
  const includeFiles = c.req.query('files') === '1';
  const includeHidden = c.req.query('hidden') === '1';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter(e => (includeHidden || !e.name.startsWith('.')) && (includeFiles || e.isDirectory()))
      .map(e => ({ name: e.name, path: path.join(dir, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const isGit = fs.existsSync(path.join(dir, '.git'));
    return c.json({ ok: true, path: dir, parent: path.dirname(dir), dirs, isGit });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Open file/directory in a selected editor or file browser
app.post('/api/open-in-editor', async (c) => {
  try {
    const body = await c.req.json();
    const filePath = typeof body?.filePath === 'string' ? body.filePath.trim() : '';
    const target = isOpenTarget(body?.target) ? body.target : 'vscode';
    if (!filePath) return c.json({ ok: false, error: 'filePath is required' }, 400);
    if (!fs.existsSync(filePath)) return c.json({ ok: false, error: 'Path not found' }, 404);
    const stat = fs.statSync(filePath);
    openPathWithTarget(filePath, target, stat.isDirectory());
    return c.json({ ok: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.log(`[open-in-editor] failed: ${detail}`);
    return c.json({ ok: false, error: detail }, 500);
  }
});

export default app;
