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
} from './constants.js';

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
  debugPort: number;
  launchedAt: string;
}

const MANAGED_BROWSER_SETUP_STATE_FILENAME = 'managed-browser-setup.json';
const MANAGED_BROWSER_SHUTDOWN_TIMEOUT_MS = 5_000;
const MANAGED_BROWSER_SHUTDOWN_POLL_MS = 100;
const MANAGED_BROWSER_DEBUG_PORT = 39222;
const require = createRequire(import.meta.url);

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

export function getManagedBrowserMcpArgs(
  profileDir = getManagedBrowserProfileDir(),
  options: ManagedBrowserMcpOptions = {},
): string[] {
  if (options.cdpEndpoint) {
    return ['--cdp-endpoint', options.cdpEndpoint];
  }
  return [
    ...PLAYWRIGHT_MCP_BROWSER_ARGS,
    ...(options.headless ? ['--headless'] : []),
    '--user-data-dir',
    profileDir,
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
    `--remote-debugging-port=${MANAGED_BROWSER_DEBUG_PORT}`,
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
      debugPort: typeof parsed.debugPort === 'number' && parsed.debugPort > 0 ? parsed.debugPort : MANAGED_BROWSER_DEBUG_PORT,
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

function getManagedBrowserDebugEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function resolveManagedBrowserCdpEndpoint(port: number): Promise<string | null> {
  return resolveBrowserCdpEndpoint(getManagedBrowserDebugEndpoint(port));
}

async function waitForManagedBrowserCdpEndpoint(port: number, timeoutMs = 6_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = await resolveManagedBrowserCdpEndpoint(port);
    if (endpoint) return endpoint;
    await sleep(200);
  }
  return resolveManagedBrowserCdpEndpoint(port);
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
  const tracked = readManagedBrowserSetupState(profileDir);
  const runningState = resolveManagedBrowserRunningState(profileDir);
  if (runningState.running) {
    const cdpEndpoint = await resolveManagedBrowserCdpEndpoint(tracked?.debugPort || MANAGED_BROWSER_DEBUG_PORT);
    if (cdpEndpoint) {
      return {
        profileDir,
        closedPids: [],
        cdpEndpoint,
        connectionMode: 'attach',
      };
    }
  }

  const closedPids = await closeManagedBrowserProcesses(profileDir);
  if (!options.headless) {
    launchManagedBrowserSetup();
    const cdpEndpoint = await waitForManagedBrowserCdpEndpoint(MANAGED_BROWSER_DEBUG_PORT);
    if (cdpEndpoint) {
      return {
        profileDir,
        closedPids,
        cdpEndpoint,
        connectionMode: 'attach',
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
      debugPort: MANAGED_BROWSER_DEBUG_PORT,
      launchedAt: new Date().toISOString(),
    });
  }

  return { ...getManagedBrowserStatus(), pid: child.pid ?? null };
}
