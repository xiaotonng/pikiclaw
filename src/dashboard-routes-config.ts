/**
 * dashboard-routes-config.ts — Config and channel-related API routes for the dashboard.
 *
 * Handles: /api/state, /api/config, /api/validate-*, /api/open-preferences,
 * /api/restart, /api/switch-workdir, /api/browser, /api/browser/setup,
 * /api/desktop-install, /api/desktop-toggle, /api/ls-dir, /api/host, /api/permissions
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadUserConfig, saveUserConfig, applyUserConfig, hasUserConfigFile } from './user-config.js';
import { isSetupReady } from './onboarding.js';
import { validateFeishuConfig, validateTelegramConfig, validateWeixinConfig } from './config-validation.js';
import { resolveGuiIntegrationConfig } from './mcp-bridge.js';
import {
  normalizeWeixinBaseUrl,
  startWeixinQrLogin,
  waitForWeixinQrLogin,
} from './weixin-api.js';
import {
  getManagedBrowserStatus,
  launchManagedBrowserSetup,
} from './browser-profile.js';
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

  // Validate Weixin credentials
  if (url.pathname === '/api/validate-weixin-config' && method === 'POST') {
    void handleValidateWeixin(ctx, req, res);
    return true;
  }

  // Start Weixin QR login
  if (url.pathname === '/api/weixin-login/start' && method === 'POST') {
    void handleWeixinLoginStart(ctx, req, res);
    return true;
  }

  // Wait for Weixin QR login
  if (url.pathname === '/api/weixin-login/wait' && method === 'POST') {
    void handleWeixinLoginWait(ctx, req, res);
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

  // Browser profile status
  if (url.pathname === '/api/browser' && method === 'GET') {
    void handleBrowserStatus(res);
    return true;
  }

  // Launch managed browser profile for login/setup
  if (url.pathname === '/api/browser/setup' && method === 'POST') {
    void handleBrowserSetup(ctx, req, res);
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
  const [one, five, fifteen] = os.loadavg();
  ctx.json(res, {
    hostName: os.hostname(), cpuModel: cpus[0]?.model || 'unknown',
    cpuCount: cpus.length, totalMem: os.totalmem(), freeMem: os.freemem(),
    loadAverage: { one, five, fifteen },
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

async function handleValidateWeixin(ctx: DashboardRouteContext, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const result = await validateWeixinConfig(body.baseUrl || '', body.botToken || '', body.accountId || '');
  ctx.json(res, {
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    account: result.account,
    normalizedBaseUrl: result.normalizedBaseUrl,
  });
}

async function handleWeixinLoginStart(ctx: DashboardRouteContext, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const result = await startWeixinQrLogin({
    baseUrl: normalizeWeixinBaseUrl(body.baseUrl || ''),
    sessionKey: body.sessionKey || undefined,
  });
  ctx.json(res, result, result.ok ? 200 : 500);
}

async function handleWeixinLoginWait(ctx: DashboardRouteContext, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await ctx.parseJsonBody(req);
  const result = await waitForWeixinQrLogin({
    baseUrl: normalizeWeixinBaseUrl(body.baseUrl || ''),
    sessionKey: String(body.sessionKey || '').trim(),
  });
  ctx.json(res, result, result.ok ? 200 : 500);
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

async function handleBrowserStatus(res: http.ServerResponse) {
  const config = loadUserConfig();
  const data = await buildBrowserStatusResponse(config);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function handleBrowserSetup(ctx: DashboardRouteContext, _req: http.IncomingMessage, res: http.ServerResponse) {
  ctx.dashboardLog('[browser] setup requested');
  try {
    const config = loadUserConfig();
    const gui = resolveGuiIntegrationConfig(config);
    if (!gui.browserEnabled) {
      return ctx.json(res, {
        ok: false,
        error: 'Browser automation is disabled. Enable it first if you want pikiclaw to launch the managed browser profile.',
      }, 400);
    }
    const launch = launchManagedBrowserSetup();
    ctx.dashboardLog(`[browser] launched managed profile at ${launch.profileDir} pid=${launch.pid ?? 'unknown'}`);
    const payload = await buildBrowserStatusResponse(config, launch);
    return ctx.json(res, {
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
    ctx.dashboardLog(`[browser] setup failed: ${detail}`);
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
