/**
 * Managed browser profile directory for Playwright integration.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import {
  MANAGED_BROWSER_PROFILE_SUBPATH,
  PLAYWRIGHT_MCP_PACKAGE_NAME,
  PLAYWRIGHT_MCP_PACKAGE_SPEC,
  PLAYWRIGHT_MCP_BROWSER_ARGS,
} from './core/constants.js';

export type ManagedBrowserProfileStatus = 'ready' | 'needs_setup' | 'chrome_missing';

export interface ManagedBrowserStatus {
  status: ManagedBrowserProfileStatus;
  profileDir: string;
  profileCreated: boolean;
  chromeInstalled: boolean;
  running: boolean;
  pid: number | null;
  detail: string | null;
  chromeExecutable: string | null;
  launchCommand: string[];
}

export interface ManagedBrowserLaunchResult extends ManagedBrowserStatus {
  pid: number | null;
}

export interface ManagedBrowserAutomationPreparationResult {
  profileDir: string;
  closedPids: number[];
  cdpEndpoint: string | null;
  connectionMode: 'attach' | 'launch';
}

export interface ManagedBrowserAutomationOptions {
  headless?: boolean;
}

export interface ManagedBrowserMcpCommand {
  command: string;
  args: string[];
  source: 'local' | 'npx';
}

export interface ManagedBrowserMcpOptions {
  headless?: boolean;
  cdpEndpoint?: string | null;
}

interface ManagedBrowserSetupState {
  pid: number;
  profileDir: string;
  chromeExecutable: string;
  launchedAt: string;
}

const MANAGED_BROWSER_SETUP_STATE_FILENAME = 'managed-browser-setup.json';
const MANAGED_BROWSER_SHUTDOWN_TIMEOUT_MS = 5_000;
const MANAGED_BROWSER_SHUTDOWN_POLL_MS = 100;
const require = createRequire(import.meta.url);

/**
 * Read Chrome's `DevToolsActivePort` file from the managed profile dir.
 * Chrome writes this file when launched with `--remote-debugging-port=<n>`
 * (including `=0`, which lets the OS assign a free port). Format is two lines:
 *   <port>
 *   /devtools/browser/<id>
 * We use it to discover the actual port rather than hard-coding one.
 */
function readDevToolsActivePort(profileDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
    const firstLine = raw.split('\n')[0]?.trim();
    if (!firstLine) return null;
    const port = parseInt(firstLine, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return port;
  } catch {
    return null;
  }
}

function normalizeBrowserCdpEndpoint(endpoint: string): string {
  const value = String(endpoint || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

async function resolveBrowserCdpEndpoint(endpoint: string): Promise<string | null> {
  const normalizedEndpoint = normalizeBrowserCdpEndpoint(endpoint);
  if (!normalizedEndpoint) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${normalizedEndpoint}/json/version`, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as { webSocketDebuggerUrl?: unknown } | null;
    return typeof payload?.webSocketDebuggerUrl === 'string' ? normalizedEndpoint : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveOnPath(command: string): string | null {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(checker, [command], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    const lines = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines[0] || null;
  } catch {
    return null;
  }
}

function resolveCommonChromePaths(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(os.homedir(), 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
  }
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || '';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      programFiles ? path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      programFilesX86 ? path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    ].filter(Boolean);
  }
  return [];
}

function resolveMacBrowserAppName(chromeExecutable: string): string | null {
  if (process.platform !== 'darwin') return null;
  if (chromeExecutable.includes('/Chromium.app/')) return 'Chromium';
  if (chromeExecutable.includes('/Google Chrome.app/')) return 'Google Chrome';
  return null;
}

function normalizeManagedBrowserWindow(chromeExecutable: string): void {
  if (process.platform !== 'darwin') return;
  const appName = resolveMacBrowserAppName(chromeExecutable);
  if (!appName) return;
  const script = [
    'set screenBounds to {0, 0, 1440, 900}',
    'try',
    '  tell application "Finder" to set screenBounds to bounds of window of desktop',
    'end try',
    `tell application "${appName}"`,
    '  activate',
    '  delay 0.4',
    '  try',
    '    set zoomed of front window to true',
    '  end try',
    '  try',
    '    set bounds of front window to screenBounds',
    '  end try',
    'end tell',
  ].join('\n');
  setTimeout(() => {
    try {
      const proc = spawn('osascript', ['-e', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      proc.unref();
    } catch {}
  }, 700);
}

export function getManagedBrowserProfileDir(): string {
  return path.join(os.homedir(), MANAGED_BROWSER_PROFILE_SUBPATH);
}

export function ensureManagedBrowserProfileDir(): string {
  const profileDir = getManagedBrowserProfileDir();
  fs.mkdirSync(profileDir, { recursive: true });
  return profileDir;
}

function getPlaywrightMcpConfigPath(outputDir: string): string {
  return path.join(outputDir, 'playwright-mcp-config.json');
}

/**
 * Write the playwright/mcp config JSON used by every spawn. Currently it just
 * strips Playwright's default `--disable-blink-features=AutomationControlled`
 * arg so Chrome doesn't show its "unsupported command-line flag" infobar.
 * Playwright adds that flag to hide `navigator.webdriver`; removing it makes
 * the managed browser look like a normal session, which is what we want for
 * pikiclaw's logged-in automation profile.
 *
 * Idempotent: rewrites only when the content drifts.
 */
export function ensurePlaywrightMcpConfigFile(
  outputDir: string = path.dirname(getManagedBrowserProfileDir()),
): string {
  const configPath = getPlaywrightMcpConfigPath(outputDir);
  const desired = JSON.stringify({
    browser: {
      launchOptions: {
        ignoreDefaultArgs: ['--disable-blink-features=AutomationControlled'],
      },
    },
  }, null, 2);
  try {
    if (fs.readFileSync(configPath, 'utf8') === desired) return configPath;
  } catch {
    // File missing or unreadable — fall through to write.
  }
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(configPath, desired, 'utf8');
  return configPath;
}

export function getManagedBrowserMcpArgs(
  profileDir = getManagedBrowserProfileDir(),
  options: ManagedBrowserMcpOptions = {},
): string[] {
  const outputDir = path.dirname(profileDir);
  const configPath = getPlaywrightMcpConfigPath(outputDir);
  if (options.cdpEndpoint) {
    return ['--config', configPath, '--cdp-endpoint', options.cdpEndpoint, '--output-dir', outputDir];
  }
  return [
    '--config', configPath,
    ...PLAYWRIGHT_MCP_BROWSER_ARGS,
    ...(options.headless ? ['--headless'] : []),
    '--user-data-dir',
    profileDir,
    '--output-dir',
    outputDir,
  ];
}

export function resolveManagedBrowserMcpCliPath(): string | null {
  try {
    const packageJsonPath = require.resolve(`${PLAYWRIGHT_MCP_PACKAGE_NAME}/package.json`);
    const cliPath = path.join(path.dirname(packageJsonPath), 'cli.js');
    return fs.existsSync(cliPath) ? cliPath : null;
  } catch {
    return null;
  }
}

export function resolveManagedBrowserMcpCommand(
  profileDir = getManagedBrowserProfileDir(),
  options: ManagedBrowserMcpOptions = {},
): ManagedBrowserMcpCommand {
  const cliPath = resolveManagedBrowserMcpCliPath();
  const runtimeArgs = getManagedBrowserMcpArgs(profileDir, options);
  if (cliPath) {
    return {
      command: process.execPath,
      args: [cliPath, ...runtimeArgs],
      source: 'local',
    };
  }
  return {
    command: 'npx',
    args: ['-y', PLAYWRIGHT_MCP_PACKAGE_SPEC, ...runtimeArgs],
    source: 'npx',
  };
}

export function getManagedBrowserLaunchArgs(profileDir = getManagedBrowserProfileDir()): string[] {
  const windowArgs = process.platform === 'darwin'
    ? ['--start-maximized', '--start-fullscreen', '--window-position=0,0']
    : ['--start-maximized'];
  return [
    `--user-data-dir=${profileDir}`,
    // `=0` makes Chrome pick a free port and write it to <profileDir>/DevToolsActivePort,
    // which `readDevToolsActivePort` reads back. Hard-coding a port causes collisions
    // when another Chrome / debugger is already on it.
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    ...windowArgs,
    'about:blank',
  ];
}

export function findChromeExecutable(): string | null {
  for (const candidate of resolveCommonChromePaths()) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const commands = process.platform === 'win32'
    ? ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

  for (const command of commands) {
    const resolved = resolveOnPath(command);
    if (resolved) return resolved;
  }

  return null;
}

function getManagedBrowserSetupStatePath(profileDir = getManagedBrowserProfileDir()): string {
  return path.join(path.dirname(profileDir), MANAGED_BROWSER_SETUP_STATE_FILENAME);
}

function readManagedBrowserSetupState(profileDir = getManagedBrowserProfileDir()): ManagedBrowserSetupState | null {
  try {
    const raw = fs.readFileSync(getManagedBrowserSetupStatePath(profileDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ManagedBrowserSetupState>;
    if (!parsed || typeof parsed.pid !== 'number' || parsed.pid <= 0) return null;
    if (typeof parsed.profileDir !== 'string' || !parsed.profileDir.trim()) return null;
    if (typeof parsed.chromeExecutable !== 'string' || !parsed.chromeExecutable.trim()) return null;
    return {
      pid: parsed.pid,
      profileDir: parsed.profileDir,
      chromeExecutable: parsed.chromeExecutable,
      launchedAt: typeof parsed.launchedAt === 'string' ? parsed.launchedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function writeManagedBrowserSetupState(state: ManagedBrowserSetupState): void {
  const statePath = getManagedBrowserSetupStatePath(state.profileDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
}

function clearManagedBrowserSetupState(profileDir = getManagedBrowserProfileDir()): void {
  try {
    fs.rmSync(getManagedBrowserSetupStatePath(profileDir), { force: true });
  } catch {}
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommand(pid: number): string {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`],
        { encoding: 'utf8' },
      );
      if (result.status !== 0) return '';
      return String(result.stdout || '').trim();
    }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (result.status !== 0) return '';
    return String(result.stdout || '').trim();
  } catch {
    return '';
  }
}

function commandUsesManagedProfile(command: string, profileDir: string): boolean {
  const normalizedCommand = command.trim();
  return normalizedCommand.includes(`--user-data-dir=${profileDir}`)
    || normalizedCommand.includes(`--user-data-dir ${profileDir}`);
}

function isManagedBrowserRootProcess(command: string, profileDir: string): boolean {
  if (!commandUsesManagedProfile(command, profileDir)) return false;
  return !command.includes(' --type=');
}

function findManagedBrowserRootPids(profileDir = getManagedBrowserProfileDir()): number[] {
  if (process.platform === 'win32') {
    const tracked = readManagedBrowserSetupState(profileDir);
    if (!tracked || !isPidAlive(tracked.pid)) return [];
    return commandUsesManagedProfile(readProcessCommand(tracked.pid), profileDir) ? [tracked.pid] : [];
  }

  try {
    const result = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    if (result.status !== 0) return [];
    const lines = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const pids = new Set<number>();
    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2] || '';
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (!isManagedBrowserRootProcess(command, profileDir)) continue;
      pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

function resolveManagedBrowserRunningState(profileDir = getManagedBrowserProfileDir()): { running: boolean; pid: number | null } {
  const tracked = readManagedBrowserSetupState(profileDir);
  if (tracked) {
    const command = readProcessCommand(tracked.pid);
    if (isPidAlive(tracked.pid) && commandUsesManagedProfile(command, profileDir)) {
      return { running: true, pid: tracked.pid };
    }
    clearManagedBrowserSetupState(profileDir);
  }

  const rootPids = findManagedBrowserRootPids(profileDir);
  if (!rootPids.length) return { running: false, pid: null };
  return { running: true, pid: rootPids[0] ?? null };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPidExit(pid: number, timeoutMs = MANAGED_BROWSER_SHUTDOWN_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(MANAGED_BROWSER_SHUTDOWN_POLL_MS);
  }
  return !isPidAlive(pid);
}

async function terminatePid(pid: number): Promise<boolean> {
  if (!isPidAlive(pid)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isPidAlive(pid);
  }
  if (await waitForPidExit(pid)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
  return waitForPidExit(pid, 1_000);
}

export async function resolveManagedBrowserCdpEndpoint(profileDir = getManagedBrowserProfileDir()): Promise<string | null> {
  const port = readDevToolsActivePort(profileDir);
  if (!port) return null;
  return resolveBrowserCdpEndpoint(`http://127.0.0.1:${port}`);
}

async function waitForManagedBrowserCdpEndpoint(profileDir: string, timeoutMs = 6_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = await resolveManagedBrowserCdpEndpoint(profileDir);
    if (endpoint) return endpoint;
    await sleep(200);
  }
  return resolveManagedBrowserCdpEndpoint(profileDir);
}

/**
 * Hard-reset the managed browser: SIGKILL every root pid (skipping the SIGTERM
 * grace window) and wipe Chrome's session-restore files so the relaunch comes
 * up with a fresh `about:blank` instead of replaying the tabs that triggered
 * the failure. Used as the reactive recovery path when an agent stream sees an
 * MCP browser error (Connection closed / Frame has been detached) indicating
 * Chrome's CDP layer is wedged; a normal `closeManagedBrowserProcesses`
 * round-trip won't help because it would restore the same poisoned tabs.
 *
 * Trade-off: any unrelated user-opened tabs are dropped. Acceptable here
 * because this is invoked only after observing a real failure — the user has
 * already lost time, and recovery beats perpetuating the wedge.
 */
export async function forceCloseManagedBrowser(profileDir = getManagedBrowserProfileDir()): Promise<number[]> {
  const tracked = readManagedBrowserSetupState(profileDir);
  const candidates = new Set<number>(findManagedBrowserRootPids(profileDir));
  if (tracked?.pid) candidates.add(tracked.pid);

  const killedPids: number[] = [];
  for (const pid of candidates) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    if (await waitForPidExit(pid, 2_000)) killedPids.push(pid);
  }
  clearManagedBrowserSetupState(profileDir);

  const defaultDir = path.join(profileDir, 'Default');
  const sessionsDir = path.join(defaultDir, 'Sessions');
  try { fs.rmSync(sessionsDir, { recursive: true, force: true }); } catch {}
  for (const name of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
    try { fs.rmSync(path.join(defaultDir, name), { force: true }); } catch {}
  }
  return killedPids;
}

async function closeManagedBrowserProcesses(profileDir: string): Promise<number[]> {
  const tracked = readManagedBrowserSetupState(profileDir);
  const candidates = new Set<number>(findManagedBrowserRootPids(profileDir));
  if (tracked?.pid) candidates.add(tracked.pid);

  const closedPids: number[] = [];
  for (const pid of candidates) {
    if (await terminatePid(pid)) closedPids.push(pid);
  }

  const remaining = findManagedBrowserRootPids(profileDir);
  if (remaining.length) {
    throw new Error(
      `Managed browser profile is still in use by pid ${remaining.join(', ')}. Close the setup browser before retrying.`,
    );
  }

  clearManagedBrowserSetupState(profileDir);
  return closedPids;
}

export async function prepareManagedBrowserForAutomation(
  profileDir = getManagedBrowserProfileDir(),
  options: ManagedBrowserAutomationOptions = {},
): Promise<ManagedBrowserAutomationPreparationResult> {
  // CDP probe is the authoritative signal: if the managed Chrome answers on
  // its debug port, attach to it regardless of what the setup-state file or
  // the process table say. The ps-based running-state check is heuristic and
  // can be wrong after a daemon restart, which would otherwise kill the
  // user's live (and signed-in) browser.
  const reachableEndpoint = await resolveManagedBrowserCdpEndpoint(profileDir);
  if (reachableEndpoint) {
    return {
      profileDir,
      closedPids: [],
      cdpEndpoint: reachableEndpoint,
      connectionMode: 'attach',
    };
  }

  const closedPids = await closeManagedBrowserProcesses(profileDir);
  if (!options.headless) {
    launchManagedBrowserSetup();
    const cdpEndpoint = await waitForManagedBrowserCdpEndpoint(profileDir);
    if (cdpEndpoint) {
      return {
        profileDir,
        closedPids,
        cdpEndpoint,
        connectionMode: 'launch',
      };
    }
  }

  return {
    profileDir,
    closedPids,
    cdpEndpoint: null,
    connectionMode: 'launch',
  };
}

export function getManagedBrowserStatus(): ManagedBrowserStatus {
  const profileDir = getManagedBrowserProfileDir();
  const profileCreated = fs.existsSync(profileDir);
  const chromeExecutable = findChromeExecutable();
  const chromeInstalled = !!chromeExecutable;
  const runningState = resolveManagedBrowserRunningState(profileDir);
  return {
    status: chromeInstalled
      ? profileCreated
        ? 'ready'
        : 'needs_setup'
      : 'chrome_missing',
    profileDir,
    profileCreated,
    chromeInstalled,
    running: runningState.running,
    pid: runningState.pid,
    detail: chromeInstalled
      ? runningState.running
        ? 'Managed browser is open for sign-in. pikiclaw will close it automatically before browser automation starts.'
        : profileCreated
        ? 'Managed browser profile is ready. Launch it to confirm login state. If it is still open later, pikiclaw will close it automatically before browser automation starts.'
        : 'Chrome is installed. Launch the managed browser once and sign in to the sites you need. If it is still open later, pikiclaw will close it automatically before browser automation starts.'
      : 'Chrome is not available on this machine. Install Google Chrome or Chromium to use browser automation.',
    chromeExecutable,
    launchCommand: chromeExecutable ? [chromeExecutable, ...getManagedBrowserLaunchArgs(profileDir)] : [],
  };
}

export function launchManagedBrowserSetup(): ManagedBrowserLaunchResult {
  const profileDir = ensureManagedBrowserProfileDir();
  const chromeExecutable = findChromeExecutable();
  if (!chromeExecutable) {
    throw new Error('Chrome is not available on this machine');
  }

  const existing = resolveManagedBrowserRunningState(profileDir);
  if (existing.running) {
    normalizeManagedBrowserWindow(chromeExecutable);
    return { ...getManagedBrowserStatus(), pid: existing.pid };
  }

  const child = spawn(chromeExecutable, getManagedBrowserLaunchArgs(profileDir), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  normalizeManagedBrowserWindow(chromeExecutable);

  if (child.pid) {
    writeManagedBrowserSetupState({
      pid: child.pid,
      profileDir,
      chromeExecutable,
      launchedAt: new Date().toISOString(),
    });
  }

  return { ...getManagedBrowserStatus(), pid: child.pid ?? null };
}
