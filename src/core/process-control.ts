/**
 * Process lifecycle: restart coordination, watchdog, and process tree termination.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export const PROCESS_RESTART_EXIT_CODE = 75;
export const PROCESS_RESTART_STATE_FILE_ENV = 'PIKICLAW_RESTART_STATE_FILE';

interface RestartStateFile {
  version: 1;
  env: Record<string, string>;
}

export interface ProcessRuntimeRegistration {
  label?: string;
  getActiveTaskCount?: () => number;
  prepareForRestart?: () => void | Promise<void>;
  buildRestartEnv?: () => Record<string, string>;
}

export interface ProcessRestartResult {
  ok: boolean;
  restarting: boolean;
  error: string | null;
  activeTasks: number;
}

interface ProcessRestartOptions {
  argv?: string[];
  restartCmd?: string;
  log?: (message: string) => void;
  exit?: (code?: number) => never | void;
}

const runtimes = new Map<number, ProcessRuntimeRegistration>();
let nextRuntimeId = 1;
let restartInFlight = false;

export function shellSplit(str: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of str) {
    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (cur) args.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) args.push(cur);
  return args;
}

function isNpxBinary(bin: string): boolean {
  return path.basename(bin, path.extname(bin)).toLowerCase() === 'npx';
}

export function ensureNonInteractiveRestartArgs(bin: string, args: string[]): string[] {
  if (!isNpxBinary(bin)) return args;
  if (args.includes('--yes') || args.includes('-y')) return args;
  return ['--yes', ...args];
}

export function getDefaultRestartCmd(): string {
  const argv0 = process.argv[0] ?? '';
  const argv1 = process.argv[1] ?? '';
  if (argv1.endsWith('.ts') || argv1.includes('/tsx') || argv1.includes('/ts-node')) {
    const isTsxLoader = !argv0.includes('/tsx')
      && process.execArgv?.some(arg => arg.includes('tsx'));
    const parts = isTsxLoader ? ['tsx', argv1] : process.argv.slice(0, 2);
    return parts.map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ');
  }
  // Running from an installed package (e.g. npm install -g) — reuse the same entry point
  if (argv1.endsWith('.js') && (argv1.includes('pikiclaw') || argv1.includes('pikiclaw'))) {
    const nodeBin = argv0.includes(' ') ? `"${argv0}"` : argv0;
    const entry = argv1.includes(' ') ? `"${argv1}"` : argv1;
    return `${nodeBin} ${entry}`;
  }
  return 'npx --yes pikiclaw@latest';
}

export function buildRestartCommand(argv: string[], restartCmd = process.env.PIKICLAW_RESTART_CMD || getDefaultRestartCmd()) {
  const [bin, ...rawArgs] = shellSplit(restartCmd);
  return {
    bin,
    args: [...ensureNonInteractiveRestartArgs(bin, rawArgs), ...argv],
  };
}

export function registerProcessRuntime(runtime: ProcessRuntimeRegistration): () => void {
  const id = nextRuntimeId++;
  runtimes.set(id, runtime);
  return () => {
    runtimes.delete(id);
  };
}

export function getRegisteredRuntimeCount(): number {
  return runtimes.size;
}

export function getActiveTaskCount(): number {
  let total = 0;
  for (const runtime of runtimes.values()) {
    total += Math.max(0, runtime.getActiveTaskCount?.() || 0);
  }
  return total;
}

export function formatActiveTaskRestartError(activeTasks: number): string {
  return `${activeTasks} task(s) still running. Wait for them to finish or try again.`;
}

export function createRestartStateFilePath(ownerPid = process.pid): string {
  const dir = path.join(os.tmpdir(), 'pikiclaw');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `restart-${ownerPid}.json`);
}

export function clearRestartStateFile(filePath: string | null | undefined): void {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch {}
}

export function writeRestartStateFile(filePath: string, env: Record<string, string>): void {
  const payload: RestartStateFile = { version: 1, env };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
}

export function consumeRestartStateFile(filePath: string | null | undefined): Record<string, string> {
  if (!filePath) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as RestartStateFile;
    if (parsed?.version !== 1 || !parsed.env || typeof parsed.env !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed.env)
        .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
        .map(([key, value]) => [key, value.trim()]),
    );
  } catch {
    return {};
  } finally {
    clearRestartStateFile(filePath);
  }
}

function mergeEnvValues(target: Record<string, string>, patch: Record<string, string>) {
  for (const [key, rawValue] of Object.entries(patch)) {
    const value = rawValue.trim();
    if (!value) continue;
    if (!target[key]) {
      target[key] = value;
      continue;
    }
    const merged = new Set([
      ...target[key].split(',').map(item => item.trim()).filter(Boolean),
      ...value.split(',').map(item => item.trim()).filter(Boolean),
    ]);
    target[key] = [...merged].join(',');
  }
}

function collectRestartEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const runtime of runtimes.values()) {
    const patch = runtime.buildRestartEnv?.() || {};
    mergeEnvValues(env, patch);
  }
  return env;
}

async function prepareRuntimesForRestart(log?: (message: string) => void) {
  for (const runtime of [...runtimes.values()]) {
    const label = runtime.label ? `${runtime.label}: ` : '';
    try {
      await runtime.prepareForRestart?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.(`restart cleanup failed (${label}${message})`);
    }
  }
}

function buildRestartEnvForSpawn(extraEnv: Record<string, string>) {
  const env = {
    ...process.env,
    ...extraEnv,
    npm_config_yes: process.env.npm_config_yes || 'true',
  } as Record<string, string>;
  delete env.PIKICLAW_DAEMON_CHILD;
  delete env[PROCESS_RESTART_STATE_FILE_ENV];
  return env;
}

function spawnReplacementProcess(bin: string, args: string[], env: Record<string, string>, log?: (message: string) => void) {
  // npx/npx.cmd needs shell resolution; node.exe does not
  const needsShell = process.platform === 'win32' && !bin.endsWith('node.exe');
  const child = spawn(needsShell ? `"${bin}"` : bin, args, {
    stdio: 'inherit',
    detached: true,
    shell: needsShell || undefined,
    env,
    cwd: process.cwd(),
  });
  child.unref();
  log?.(`restart: new process spawned (PID ${child.pid})`);
  return child;
}

export async function requestProcessRestart(opts: ProcessRestartOptions = {}): Promise<ProcessRestartResult> {
  const activeTasks = getActiveTaskCount();
  if (activeTasks > 0) {
    return {
      ok: false,
      restarting: false,
      error: formatActiveTaskRestartError(activeTasks),
      activeTasks,
    };
  }
  if (restartInFlight) {
    return {
      ok: true,
      restarting: true,
      error: null,
      activeTasks: 0,
    };
  }

  restartInFlight = true;
  const log = opts.log;
  const exit = opts.exit || process.exit;

  try {
    const extraEnv = collectRestartEnv();
    await prepareRuntimesForRestart(log);

    if (process.env.PIKICLAW_DAEMON_CHILD === '1') {
      const restartStateFile = process.env[PROCESS_RESTART_STATE_FILE_ENV];
      if (restartStateFile) {
        if (Object.keys(extraEnv).length) writeRestartStateFile(restartStateFile, extraEnv);
        else clearRestartStateFile(restartStateFile);
      }
      log?.('restart: handing off to daemon supervisor');
      exit(PROCESS_RESTART_EXIT_CODE);
      return { ok: true, restarting: true, error: null, activeTasks: 0 };
    }

    const { bin, args } = buildRestartCommand(opts.argv || process.argv.slice(2), opts.restartCmd);
    log?.(`restart: spawning \`${bin} ${args.join(' ')}\``);
    spawnReplacementProcess(bin, args, buildRestartEnvForSpawn(extraEnv), log);
    exit(0);
    return { ok: true, restarting: true, error: null, activeTasks: 0 };
  } catch (err) {
    restartInFlight = false;
    return {
      ok: false,
      restarting: false,
      error: err instanceof Error ? err.message : String(err),
      activeTasks: 0,
    };
  }
}

export interface TerminateProcessTreeOptions {
  signal?: NodeJS.Signals | number;
  forceSignal?: NodeJS.Signals | number | null;
  forceAfterMs?: number;
}

export function terminateProcessTree(target: ChildProcess | { pid?: number | undefined } | number | null | undefined, opts: TerminateProcessTreeOptions = {}) {
  const pid = typeof target === 'number' ? target : target?.pid;
  if (!pid || pid <= 0) return;

  const signal = opts.signal ?? 'SIGTERM';
  const forceSignal = opts.forceSignal ?? null;
  const forceAfterMs = opts.forceAfterMs ?? 0;

  const killPid = (targetPid: number, nextSignal: NodeJS.Signals | number) => {
    try {
      if (process.platform === 'win32') {
        const args = ['/pid', String(targetPid), '/t'];
        if (nextSignal === 'SIGKILL') args.push('/f');
        const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
        killer.unref();
        return;
      }
      process.kill(-targetPid, nextSignal);
    } catch {
      try { process.kill(targetPid, nextSignal); } catch {}
    }
  };

  killPid(pid, signal);

  if (forceSignal == null || forceAfterMs <= 0 || forceSignal === signal) return;
  const timer = setTimeout(() => killPid(pid, forceSignal), forceAfterMs);
  timer.unref?.();
}
