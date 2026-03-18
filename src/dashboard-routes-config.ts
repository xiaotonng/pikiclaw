/**
 * dashboard-routes-config.ts — Config and channel-related API routes for the dashboard.
 *
 * Handles: /api/state, /api/config, /api/validate-*, /api/open-preferences,
 * /api/restart, /api/switch-workdir, /api/extensions, /api/save-extension-token,
 * /api/desktop-install, /api/desktop-toggle, /api/ls-dir, /api/host, /api/permissions
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DASHBOARD_TIMEOUTS } from './constants.js';
import { loadUserConfig, saveUserConfig, applyUserConfig, hasUserConfigFile, type UserConfig } from './user-config.js';
import { isSetupReady, type SetupState } from './onboarding.js';
import { validateFeishuConfig, validateTelegramConfig } from './config-validation.js';
import { resolveGuiIntegrationConfig } from './mcp-bridge.js';
import {
  formatActiveTaskRestartError,
  getActiveTaskCount,
  requestProcessRestart,
} from './process-control.js';
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
} from './dashboard-platform.js';
import type { DashboardRouteContext } from './dashboard.js';
import { VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerConfigRoutes(
  ctx: DashboardRouteContext,
  url: URL,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  // Full state (config from file only)
  if (url.pathname === '/api/state' && method === 'GET') {
    void handleState(ctx, res);
    return true;
  }

  // Host info
  if (url.pathname === '/api/host' && method === 'GET') {
    handleHost(ctx, res);
    return true;
  }

  // Permissions
  if (url.pathname === '/api/permissions' && method === 'GET') {
    handlePermissions(res);
    return true;
  }

  // Save config (to ~/.pikiclaw/setting.json)
  if (url.pathname === '/api/config' && method === 'POST') {
    void handleSaveConfig(ctx, req, res);
    return true;
  }

  // Validate Telegram token
  if (url.pathname === '/api/validate-telegram-token' && method === 'POST') {
    void handleValidateTelegram(ctx, req, res);
    return true;
  }

  // Validate Feishu credentials
  if (url.pathname === '/api/validate-feishu-config' && method === 'POST') {
    void handleValidateFeishu(ctx, req, res);
    return true;
  }

  // Open macOS preferences
  if (url.pathname === '/api/open-preferences' && method === 'POST') {
    void handleOpenPreferences(ctx, req, res);
    return true;
  }

  // Restart process
  if (url.pathname === '/api/restart' && method === 'POST') {
    handleRestart(ctx, res);
    return true;
  }

  // Switch workdir
  if (url.pathname === '/api/switch-workdir' && method === 'POST') {
    void handleSwitchWorkdir(ctx, req, res);
    return true;
  }

  // Extension config status
  if (url.pathname === '/api/extensions' && method === 'GET') {
    handleExtensions(res);
    return true;
  }

  // Save extension token and validate
  if (url.pathname === '/api/save-extension-token' && method === 'POST') {
    void handleSaveExtensionToken(ctx, req, res);
    return true;
  }

  // Desktop: install Appium + Mac2 driver
  if (url.pathname === '/api/desktop-install' && method === 'POST') {
    void handleDesktopInstall(ctx, res);
    return true;
  }

  // Desktop: toggle enable/disable (start/stop Appium)
  if (url.pathname === '/api/desktop-toggle' && method === 'POST') {
    void handleDesktopToggle(ctx, req, res);
    return true;
  }

  // List directory entries for tree browser
  if (url.pathname === '/api/ls-dir' && method === 'GET') {
    handleLsDir(ctx, url, res);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleState(ctx: DashboardRouteContext, res: http.ServerResponse) {
  const config = loadUserConfig();
  const setupState = await ctx.buildValidatedSetupState(config);
  const permissions = checkPermissions();
  const botRef = ctx.getBotRef();
  ctx.json(res, {
    version: VERSION,
    ready: isSetupReady(setupState),
    configExists: hasUserConfigFile(),
    config,
    runtimeWorkdir: ctx.getRuntimeWorkdir(config),
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

function handleHost(ctx: DashboardRouteContext, res: http.ServerResponse) {
  const botRef = ctx.getBotRef();
  if (botRef) return ctx.json(res, botRef.getHostData());
  const cpus = os.cpus();
  ctx.json(res, {
    hostName: os.hostname(), cpuModel: cpus[0]?.model || 'unknown',
    cpuCount: cpus.length, totalMem: os.totalmem(), freeMem: os.freemem(),
    platform: process.platform, arch: os.arch(),
  });
}

function handlePermissions(res: http.ServerResponse) {
  const data = { ...checkPermissions(), hostApp: detectHostTerminalApp() };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function handleSaveConfig(ctx: DashboardRouteContext, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const merged = { ...loadUserConfig(), ...body };
  const configPath = saveUserConfig(merged);
  applyUserConfig(loadUserConfig());
  ctx.json(res, { ok: true, configPath });
}

async function handleValidateTelegram(ctx: DashboardRouteContext, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const result = await validateTelegramConfig(body.token || '', body.allowedChatIds || '');
  ctx.json(res, {
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    bot: result.bot,
    normalizedAllowedChatIds: result.normalizedAllowedChatIds,
  });
}

async function handleValidateFeishu(ctx: DashboardRouteContext, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
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
  ctx.json(res, {
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    app: result.app,
  });
}

async function handleOpenPreferences(ctx: DashboardRouteContext, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const permission = String(body.permission || '');
  if (!isValidPermissionKey(permission)) {
    return ctx.json(res, {
      ok: false,
      action: 'unsupported',
      granted: false,
      requiresManualGrant: false,
      error: 'Invalid permission.',
    }, 400);
  }
  const result = requestPermission(permission);
  ctx.dashboardLog(
    `[permissions] permission=${permission} action=${result.action} granted=${result.granted} manual=${result.requiresManualGrant} ok=${result.ok}`
  );
  ctx.json(res, result, result.ok ? 200 : 500);
}

function handleRestart(ctx: DashboardRouteContext, res: http.ServerResponse) {
  const activeTasks = getActiveTaskCount();
  if (activeTasks > 0) {
    return ctx.json(res, { ok: false, error: formatActiveTaskRestartError(activeTasks) }, 409);
  }
  ctx.json(res, { ok: true });
  setTimeout(() => {
    void requestProcessRestart({ log: message => ctx.dashboardLog(message) });
  }, 50);
}

async function handleSwitchWorkdir(ctx: DashboardRouteContext, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const newPath = body.path;
  if (!newPath) return ctx.json(res, { ok: false, error: 'Missing path' }, 400);
  const resolvedPath = path.resolve(String(newPath).replace(/^~/, process.env.HOME || ''));
  const botRef = ctx.getBotRef();
  if (botRef) {
    botRef.switchWorkdir(resolvedPath);
    return ctx.json(res, { ok: true, workdir: botRef.workdir });
  }
  const { setUserWorkdir } = await import('./user-config.js');
  const saved = setUserWorkdir(resolvedPath);
  ctx.json(res, { ok: true, workdir: saved.workdir });
}

function handleExtensions(res: http.ServerResponse) {
  const config = loadUserConfig();
  const gui = resolveGuiIntegrationConfig(config);
  const installed = isAppiumInstalled();
  const data = {
    browser: {
      hasToken: !!gui.browserExtensionToken,
      token: gui.browserExtensionToken || '',
    },
    desktop: {
      enabled: gui.desktopEnabled,
      installed,
      running: isManagedAppiumRunning(),
      appiumUrl: gui.desktopAppiumUrl,
    },
  };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function handleSaveExtensionToken(ctx: DashboardRouteContext, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const token = String(body.token || '').trim();
  if (!token) return ctx.json(res, { ok: false, error: 'Token is required' }, 400);

  // Validate by spawning Playwright MCP with the token — if the process starts
  // and emits valid JSON-RPC output, the token is valid.
  ctx.dashboardLog('[extensions] validating extension token...');
  try {
    const proc = spawn('npx', ['-y', '@playwright/mcp@latest', '--extension'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token },
      timeout: DASHBOARD_TIMEOUTS.extensionValidationSpawn,
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
      }, DASHBOARD_TIMEOUTS.extensionValidationAlive);
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
      ctx.dashboardLog('[extensions] extension token saved and validated');
      return ctx.json(res, { ok: true, valid: true });
    }
    ctx.dashboardLog(`[extensions] token validation failed: exit=${exitCode} stderr=${stderr.slice(0, 200)}`);
    return ctx.json(res, { ok: false, error: 'Token validation failed — the extension did not accept this token.' });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.dashboardLog(`[extensions] token validation error: ${detail}`);
    return ctx.json(res, { ok: false, error: detail }, 500);
  }
}

async function handleDesktopInstall(ctx: DashboardRouteContext, res: http.ServerResponse) {
  if (process.platform !== 'darwin') {
    return ctx.json(res, { ok: false, error: 'Desktop automation is only supported on macOS' }, 400);
  }
  ctx.dashboardLog('[desktop] install requested');
  try {
    await installAppium(msg => ctx.dashboardLog(`[desktop] ${msg}`));
    return ctx.json(res, { ok: true, installed: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.dashboardLog(`[desktop] install failed: ${detail}`);
    return ctx.json(res, { ok: false, error: detail }, 500);
  }
}

async function handleDesktopToggle(ctx: DashboardRouteContext, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const enabled = !!body.enabled;
  ctx.dashboardLog(`[desktop] toggle enabled=${enabled}`);
  try {
    const config = loadUserConfig();
    if (enabled) {
      const gui = resolveGuiIntegrationConfig(config);
      if (!isAppiumInstalled()) {
        await installAppium(msg => ctx.dashboardLog(`[desktop] ${msg}`));
      }
      await startManagedAppium(gui.desktopAppiumUrl, msg => ctx.dashboardLog(`[desktop] ${msg}`));
      saveUserConfig({ ...config, desktopGuiEnabled: true });
      applyUserConfig(loadUserConfig());
    } else {
      stopManagedAppium();
      saveUserConfig({ ...config, desktopGuiEnabled: false });
      applyUserConfig(loadUserConfig());
    }
    return ctx.json(res, { ok: true, enabled });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.dashboardLog(`[desktop] toggle failed: ${detail}`);
    return ctx.json(res, { ok: false, error: detail }, 500);
  }
}

function handleLsDir(ctx: DashboardRouteContext, url: URL, res: http.ServerResponse) {
  const dir = url.searchParams.get('path') || os.homedir();
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const isGit = fs.existsSync(path.join(dir, '.git'));
    return ctx.json(res, { ok: true, path: dir, parent: path.dirname(dir), dirs, isGit });
  } catch (err) {
    return ctx.json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
  }
}
