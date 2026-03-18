/**
 * dashboard-platform.ts — Platform-specific logic for the pikiclaw dashboard.
 *
 * macOS permission checks, terminal detection, Appium process management,
 * JXA scripts, and other OS-level utilities.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import {
  DASHBOARD_PERMISSION_TIMEOUTS,
  DASHBOARD_APPIUM_TIMEOUTS,
  DASHBOARD_TIMEOUTS,
} from './constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PermissionStatus { granted: boolean; checkable: boolean; detail: string }

export type DashboardPermissionKey = 'accessibility' | 'screenRecording' | 'fullDiskAccess';
export type PermissionRequestAction = 'already_granted' | 'prompted' | 'opened_settings' | 'unsupported';

export interface PermissionRequestResult {
  ok: boolean;
  action: PermissionRequestAction;
  granted: boolean;
  requiresManualGrant: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Permission pane URLs (macOS)
// ---------------------------------------------------------------------------

const permissionPaneUrls: Record<DashboardPermissionKey, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  fullDiskAccess: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
};

// ---------------------------------------------------------------------------
// JXA helpers
// ---------------------------------------------------------------------------

function runJxa(script: string, timeout = DASHBOARD_PERMISSION_TIMEOUTS.jxaDefault): string | null {
  try {
    return String(execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout })).trim().toLowerCase();
  } catch {
    return null;
  }
}

function checkAccessibilityPermission(): boolean | null {
  try {
    execFileSync('osascript', ['-e', 'tell application "System Events" to keystroke ""'], { stdio: 'ignore', timeout: DASHBOARD_PERMISSION_TIMEOUTS.accessibilityProbe });
    return true;
  } catch {}
  const output = runJxa(
    'ObjC.bindFunction("CGPreflightPostEventAccess", ["bool", []]); console.log($.CGPreflightPostEventAccess());',
    DASHBOARD_PERMISSION_TIMEOUTS.accessibilityPreflight,
  );
  if (output == null) return null;
  return output === 'true';
}

function requestAccessibilityPermission(): boolean {
  return runJxa(
    'ObjC.bindFunction("CGRequestPostEventAccess", ["bool", []]); console.log($.CGRequestPostEventAccess());',
    DASHBOARD_PERMISSION_TIMEOUTS.accessibilityRequest,
  ) !== null;
}

function checkScreenRecordingPermission(): boolean | null {
  const screenshotPath = path.join(os.tmpdir(), `.pikiclaw_perm_test_${process.pid}_${Date.now()}.png`);
  try {
    execFileSync('screencapture', ['-x', screenshotPath], { stdio: 'ignore', timeout: DASHBOARD_PERMISSION_TIMEOUTS.screenRecordingProbe });
    return true;
  } catch {} finally {
    try { fs.rmSync(screenshotPath, { force: true }); } catch {}
  }
  const output = runJxa(
    'ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); console.log($.CGPreflightScreenCaptureAccess());',
    DASHBOARD_PERMISSION_TIMEOUTS.screenRecordingPreflight,
  );
  if (output == null) return null;
  return output === 'true';
}

function requestScreenRecordingPermission(): boolean {
  return runJxa(
    'ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]); console.log($.CGRequestScreenCaptureAccess());',
    DASHBOARD_PERMISSION_TIMEOUTS.screenRecordingRequest,
  ) !== null;
}

function openPermissionSettings(permission: DashboardPermissionKey): boolean {
  const pane = permissionPaneUrls[permission];
  if (!pane) return false;
  try {
    execFileSync('open', [pane], { stdio: 'ignore', timeout: DASHBOARD_PERMISSION_TIMEOUTS.openSystemPreferences });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

export function checkPermissions(): Record<string, PermissionStatus> {
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

export function requestPermission(permission: DashboardPermissionKey): PermissionRequestResult {
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

export function isValidPermissionKey(value: string): value is DashboardPermissionKey {
  return value in permissionPaneUrls;
}

// ---------------------------------------------------------------------------
// Terminal detection
// ---------------------------------------------------------------------------

/** Walk the process tree upward to find the host terminal / IDE that launched pikiclaw. Works on macOS and Linux. */
export function detectHostTerminalApp(): string | null {
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
      { encoding: 'utf8', timeout: DASHBOARD_PERMISSION_TIMEOUTS.detectTerminal, shell: '/bin/sh' },
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

// ---------------------------------------------------------------------------
// Appium lifecycle management
// ---------------------------------------------------------------------------

const APPIUM_INSTALL_DIR = path.join(os.homedir(), '.pikiclaw', 'appium');
let managedAppiumProc: ChildProcess | null = null;

export function findAppiumBin(): string | null {
  const localBin = path.join(APPIUM_INSTALL_DIR, 'node_modules', '.bin', 'appium');
  if (fs.existsSync(localBin)) return localBin;
  try {
    const result = execFileSync('which', ['appium'], { encoding: 'utf-8', timeout: DASHBOARD_APPIUM_TIMEOUTS.whichAppium });
    return result.trim() || null;
  } catch { return null; }
}

export function isAppiumInstalled(): boolean {
  const bin = findAppiumBin();
  if (!bin) return false;
  try {
    const out = execFileSync(bin, ['driver', 'list', '--installed', '--json'], { encoding: 'utf-8', timeout: DASHBOARD_APPIUM_TIMEOUTS.driverList });
    return out.includes('mac2');
  } catch { return false; }
}

export async function installAppium(log: (msg: string) => void): Promise<string> {
  fs.mkdirSync(APPIUM_INSTALL_DIR, { recursive: true });
  const pkgPath = path.join(APPIUM_INSTALL_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) fs.writeFileSync(pkgPath, '{"private":true}');

  const existingBin = findAppiumBin();
  if (!existingBin) {
    log('Installing Appium...');
    execFileSync('npm', ['install', '--save', 'appium'], { cwd: APPIUM_INSTALL_DIR, stdio: 'pipe', timeout: DASHBOARD_APPIUM_TIMEOUTS.npmInstallAppium });
  }
  const bin = findAppiumBin();
  if (!bin) throw new Error('Appium binary not found after install');

  try {
    const out = execFileSync(bin, ['driver', 'list', '--installed', '--json'], { encoding: 'utf-8', timeout: DASHBOARD_APPIUM_TIMEOUTS.driverList });
    if (!out.includes('mac2')) {
      log('Installing Mac2 driver...');
      execFileSync(bin, ['driver', 'install', 'mac2'], { stdio: 'pipe', timeout: DASHBOARD_APPIUM_TIMEOUTS.driverInstallMac2 });
    }
  } catch {
    log('Installing Mac2 driver...');
    execFileSync(bin, ['driver', 'install', 'mac2'], { stdio: 'pipe', timeout: DASHBOARD_APPIUM_TIMEOUTS.driverInstallMac2 });
  }

  log('Appium installation complete.');
  return bin;
}

function checkAppiumReachable(appiumUrl: string): Promise<boolean> {
  return new Promise(resolve => {
    const url = new URL('/status', appiumUrl);
    const req = http.get(url, { timeout: DASHBOARD_TIMEOUTS.appiumReachable }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export async function startManagedAppium(appiumUrl: string, log: (msg: string) => void): Promise<void> {
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
    await new Promise(r => setTimeout(r, DASHBOARD_TIMEOUTS.appiumStartPoll));
    if (await checkAppiumReachable(appiumUrl)) {
      log('Appium server is ready.');
      return;
    }
  }
  stopManagedAppium();
  throw new Error('Appium server failed to start within 30 seconds');
}

export function stopManagedAppium(): void {
  if (managedAppiumProc && !managedAppiumProc.killed) {
    managedAppiumProc.kill();
    managedAppiumProc = null;
  }
}

export function isManagedAppiumRunning(): boolean {
  return managedAppiumProc != null && !managedAppiumProc.killed;
}
