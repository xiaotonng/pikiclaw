import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AgentInfo } from './code-agent.js';
import { getAgentLabel, getAgentPackage } from './agent-npm.js';
import type { UserConfig } from './user-config.js';
import { AGENT_UPDATE_TIMEOUTS } from './constants.js';

const AGENT_UPDATE_LOCK_STALE_MS = AGENT_UPDATE_TIMEOUTS.lockStale;
const AGENT_UPDATE_COMMAND_TIMEOUT_MS = AGENT_UPDATE_TIMEOUTS.commandTimeout;

type AgentUpdateStrategy =
  | { kind: 'npm'; pkg: string }
  | { kind: 'skip'; reason: string };

function updaterLockPath(): string {
  return path.join(os.homedir(), '.pikiclaw', 'agent-auto-update.lock');
}

function normalizeBooleanEnv(value: string | undefined): boolean | null {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^(1|true|yes|on)$/i.test(text)) return true;
  if (/^(0|false|no|off)$/i.test(text)) return false;
  return null;
}

export function agentAutoUpdateEnabled(config: Partial<UserConfig>): boolean {
  const env = normalizeBooleanEnv(process.env.PIKICLAW_AGENT_AUTO_UPDATE);
  if (env != null) return env;
  if (typeof config.agentAutoUpdate === 'boolean') return config.agentAutoUpdate;
  return true;
}

export function extractAgentSemver(value: unknown): string | null {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0] || null;
}

function isPathInside(parentDir: string, childPath: string): boolean {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export function resolveAgentUpdateStrategy(agent: Pick<AgentInfo, 'agent' | 'path'>, npmPrefix: string | null): AgentUpdateStrategy {
  const id = String(agent.agent || '').trim();
  const pkg = getAgentPackage(id);
  if (!pkg) return { kind: 'skip', reason: 'unsupported agent' };

  const binPath = String(agent.path || '').trim();
  const npmBinDir = npmPrefix ? path.join(path.resolve(npmPrefix), 'bin') : null;
  const npmManaged = !!(binPath && npmBinDir && isPathInside(npmBinDir, binPath));
  if (npmManaged) return { kind: 'npm', pkg };
  return { kind: 'skip', reason: 'non-npm install path' };
}

function labelForAgent(agent: string): string {
  return getAgentLabel(agent);
}

async function runCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_yes: 'true' },
    });
    const timeoutMs = Math.max(500, opts.timeoutMs ?? AGENT_UPDATE_COMMAND_TIMEOUT_MS);
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      resolve({ ok: false, code: null, stdout, stderr, error: `Timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: err.message });
    });
    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        error: code === 0 ? null : (stderr.trim() || stdout.trim() || `Exited with code ${code}`),
      });
    });
  });
}

async function getNpmGlobalPrefix(): Promise<string | null> {
  const result = await runCommand('npm', ['prefix', '-g'], { timeoutMs: AGENT_UPDATE_TIMEOUTS.npmPrefix });
  return result.ok ? result.stdout.trim().split('\n')[0] || null : null;
}

async function getLatestPackageVersion(pkg: string): Promise<string | null> {
  const result = await runCommand('npm', ['view', pkg, 'version', '--json'], { timeoutMs: AGENT_UPDATE_TIMEOUTS.npmView });
  if (!result.ok) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed.trim() || null : null;
  } catch {
    return raw.replace(/^"+|"+$/g, '').trim() || null;
  }
}

function acquireUpdateLock(log: (message: string) => void): (() => void) | null {
  const filePath = updaterLockPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs > AGENT_UPDATE_LOCK_STALE_MS) fs.rmSync(filePath, { force: true });
  } catch {}

  try {
    fs.writeFileSync(filePath, `${process.pid}\n`, { flag: 'wx' });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { fs.rmSync(filePath, { force: true }); } catch {}
    };
  } catch {
    log('agent auto-update already running in another process; skipping this startup check');
    return null;
  }
}

async function updateViaNpm(pkg: string): Promise<{ ok: boolean; detail: string | null }> {
  const result = await runCommand('npm', ['install', '-g', `${pkg}@latest`]);
  return { ok: result.ok, detail: result.ok ? result.stdout.trim() || null : result.error };
}

export function startAgentAutoUpdate(opts: {
  config: Partial<UserConfig>;
  agents: AgentInfo[];
  log: (message: string) => void;
}) {
  if (!agentAutoUpdateEnabled(opts.config)) return;
  const installedAgents = opts.agents.filter(agent => agent.installed && agent.path);
  if (!installedAgents.length) return;
  const releaseLock = acquireUpdateLock(opts.log);
  if (!releaseLock) return;

  void (async () => {
    try {
      opts.log(`agent auto-update: checking ${installedAgents.length} installed agent${installedAgents.length === 1 ? '' : 's'} in background`);
      const npmPrefix = await getNpmGlobalPrefix();

      for (const agent of installedAgents) {
        const id = String(agent.agent || '').trim();
        const pkg = getAgentPackage(id);
        if (!pkg) continue;

        const label = labelForAgent(id);
        const currentVersion = extractAgentSemver(agent.version);
        const latestVersion = await getLatestPackageVersion(pkg);
        if (!latestVersion) {
          opts.log(`agent auto-update: ${label} latest version lookup failed`);
          continue;
        }
        if (currentVersion === latestVersion) {
          opts.log(`agent auto-update: ${label} is already up to date (${latestVersion})`);
          continue;
        }

        const strategy = resolveAgentUpdateStrategy(agent, npmPrefix);
        if (strategy.kind === 'skip') {
          opts.log(`agent auto-update: ${label} is ${currentVersion || 'unknown'} and latest is ${latestVersion}, but update is skipped (${strategy.reason})`);
          continue;
        }

        opts.log(`agent auto-update: updating ${label} ${currentVersion || 'unknown'} -> ${latestVersion}`);
        const result = await updateViaNpm(strategy.pkg);
        if (result.ok) opts.log(`agent auto-update: ${label} update completed`);
        else opts.log(`agent auto-update: ${label} update failed: ${result.detail || 'unknown error'}`);
      }

      opts.log('agent auto-update: finished');
    } finally {
      releaseLock();
    }
  })();
}
