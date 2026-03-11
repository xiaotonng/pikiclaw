/**
 * bot.ts — shared bot logic: config, state, streaming bridge, helpers, keep-alive.
 *
 * Channel-agnostic. Subclass per IM (see bot-telegram.ts).
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { getActiveUserConfig, onUserConfigChange, resolveUserWorkdir } from './user-config.js';
import {
  doStream, getSessions, getSessionTail, getUsage, listAgents, listModels, listSkills,
  type Agent, type CodexCumulativeUsage, type StreamOpts, type StreamResult, type StreamPreviewMeta, type StreamPreviewPlan, type SessionInfo, type UsageResult,
  type ModelInfo, type ModelListResult, type TailMessage, type SessionTailResult,
  type SkillInfo, type SkillListResult,
} from './code-agent.js';
import { getDriver, hasDriver, allDriverIds } from './agent-driver.js';

export { type Agent, type CodexCumulativeUsage, type StreamResult, type StreamPreviewMeta, type StreamPreviewPlan, type SessionInfo, type UsageResult, type ModelInfo, type ModelListResult, type TailMessage, type SessionTailResult, type SkillInfo, type SkillListResult };
export type ChatId = number | string;
export const VERSION = '0.2.28';
const MACOS_USER_ACTIVITY_PULSE_INTERVAL_MS = 20_000;
const MACOS_USER_ACTIVITY_PULSE_TIMEOUT_S = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If `dir` has a .gitignore, ensure `.codeclaw` is listed so artifacts don't pollute git.
 */
function ensureGitignore(dir: string) {
  try {
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) return;
    const txt = fs.readFileSync(gi, 'utf8');
    if (txt.split('\n').some(l => l.trim() === '.codeclaw' || l.trim() === '.codeclaw/')) return;
    fs.appendFileSync(gi, `${txt.endsWith('\n') ? '' : '\n'}.codeclaw/\n`);
  } catch { /* best-effort */ }
}

export function envBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? def : n;
}

export function shellSplit(str: string): string[] {
  const args: string[] = [];
  let cur = '', inS = false, inD = false;
  for (const ch of str) {
    if (ch === "'" && !inD) { inS = !inS; continue; }
    if (ch === '"' && !inS) { inD = !inD; continue; }
    if (ch === ' ' && !inS && !inD) { if (cur) { args.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) args.push(cur);
  return args;
}

export function whichSync(cmd: string): string | null {
  try { return execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8' }).trim() || null; } catch { return null; }
}

export function fmtTokens(n: number | null): string {
  if (n == null) return '-';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  return `${(bytes / 1024 / 1024 / 1024 / 1024).toFixed(1)}TB`;
}

export function parseAllowedChatIds(raw: string): Set<ChatId> {
  const ids = new Set<ChatId>();
  for (const t of raw.split(',')) {
    const v = t.trim();
    if (!v) continue;
    const n = parseInt(v, 10);
    // If the string is purely numeric, store as number for backward compat (Telegram).
    // Otherwise store as string (Feishu, Discord, etc.).
    if (!Number.isNaN(n) && String(n) === v) ids.add(n);
    else if (v) ids.add(v);
  }
  return ids;
}

export function normalizeAgent(raw: string): Agent {
  const v = raw.trim().toLowerCase();
  if (!hasDriver(v)) throw new Error(`Invalid agent: ${v}. Use: ${allDriverIds().join(', ')}`);
  return v;
}

export function listSubdirs(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath)
      .filter(name => {
        if (name.startsWith('.')) return false;
        try { return fs.statSync(path.join(dirPath, name)).isDirectory(); } catch { return false; }
      })
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch { return []; }
}

export function thinkLabel(agent: Agent): string {
  try { return getDriver(agent).thinkLabel; } catch { return 'Thinking'; }
}

export function extractThinkingTail(text: string, maxLines = 3): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';

  const blocks = normalized
    .split(/\n\s*\n+/)
    .map(block => block.trim())
    .filter(Boolean);
  if (blocks.length > 1) return blocks[blocks.length - 1];

  const lines = normalized
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim());
  if (lines.length > 1) return lines.slice(-Math.min(maxLines, lines.length)).join('\n').trim();
  return normalized;
}

export function formatThinkingForDisplay(text: string, maxChars = 800): string {
  let display = extractThinkingTail(text);
  if (display.length > maxChars) display = '...\n' + display.slice(-maxChars);
  return display;
}

export function buildPrompt(text: string, files: string[]): string {
  if (!files.length) return text;
  return `${text || 'Please analyze this.'}\n\n[Files: ${files.map(f => path.basename(f)).join(', ')}]`;
}

interface HostBatteryData {
  percent: string;
  state: string;
}

interface HostCpuUsageData {
  userPercent: number;
  sysPercent: number;
  idlePercent: number;
  usedPercent: number;
}

interface HostMemoryUsageData {
  usedBytes: number;
  availableBytes: number;
  percent: number;
  source: 'os' | 'vm_stat';
}

function normalizeBatteryState(raw: string | null | undefined): string {
  const state = (raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!state) return 'unknown';
  if (state === 'finishing charge') return 'charging';
  if (state === 'ac attached') return 'plugged in';
  return state;
}

function getMacBatteryData(): HostBatteryData | null {
  try {
    const output = execSync('pmset -g batt', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (!output || /no batteries/i.test(output)) return null;

    const line = output.split('\n').find(v => /\d+%/.test(v));
    if (!line) return null;

    const percent = line.match(/(\d+)%/)?.[1];
    if (!percent) return null;

    const states = line
      .split(';')
      .slice(1)
      .map(segment => segment.replace(/\bpresent:\s*(true|false)\b/ig, '').trim())
      .filter(Boolean);
    const state = states.find(segment => /(charging|discharging|charged|not charging|finishing charge|full)/i.test(segment))
      ?? states.find(segment => !/remaining/i.test(segment))
      ?? 'unknown';

    return { percent: `${percent}%`, state: normalizeBatteryState(state) };
  } catch {
    return null;
  }
}

function getLinuxBatteryData(): HostBatteryData | null {
  try {
    const powerDir = '/sys/class/power_supply';
    const batteries = fs.readdirSync(powerDir).filter(name => /^BAT/i.test(name));
    for (const battery of batteries) {
      const batteryDir = path.join(powerDir, battery);
      const capacityPath = path.join(batteryDir, 'capacity');
      if (!fs.existsSync(capacityPath)) continue;

      const capacity = fs.readFileSync(capacityPath, 'utf-8').trim();
      if (!capacity) continue;

      const statusPath = path.join(batteryDir, 'status');
      const state = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf-8').trim() : 'unknown';
      return {
        percent: capacity.endsWith('%') ? capacity : `${capacity}%`,
        state: normalizeBatteryState(state),
      };
    }
  } catch {}

  try {
    const output = execSync(
      'upower -e | grep -m1 battery | xargs -I{} upower -i "{}"',
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    if (!output) return null;

    const percent = output.match(/percentage:\s*(\d+%)/i)?.[1];
    if (!percent) return null;
    const state = output.match(/state:\s*([^\n]+)/i)?.[1];
    return { percent, state: normalizeBatteryState(state) };
  } catch {
    return null;
  }
}

function getWindowsBatteryData(): HostBatteryData | null {
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress"',
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    if (!output || output === 'null') return null;

    const parsed = JSON.parse(output);
    const percent = Number(parsed?.EstimatedChargeRemaining);
    if (!Number.isFinite(percent)) return null;

    const status = Number(parsed?.BatteryStatus);
    const state = status === 6 ? 'charging'
      : status === 3 ? 'charged'
      : status === 2 ? 'plugged in'
      : status === 1 ? 'discharging'
      : 'unknown';

    return { percent: `${percent}%`, state };
  } catch {
    return null;
  }
}

function getHostBatteryData(): HostBatteryData | null {
  if (process.platform === 'darwin') return getMacBatteryData();
  if (process.platform === 'linux') return getLinuxBatteryData();
  if (process.platform === 'win32') return getWindowsBatteryData();
  return null;
}

function parsePercent(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value.trim());
  return Number.isFinite(n) ? n : null;
}

function getMacCpuUsageData(): HostCpuUsageData | null {
  try {
    const output = execSync('top -l 1 -n 0 | sed -n \'1,6p\'', { encoding: 'utf-8', timeout: 3000 });
    const line = output.split('\n').find(entry => /^CPU usage:/i.test(entry.trim()));
    if (!line) return null;
    const match = line.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/i);
    if (!match) return null;
    const userPercent = parsePercent(match[1]);
    const sysPercent = parsePercent(match[2]);
    const idlePercent = parsePercent(match[3]);
    if (userPercent == null || sysPercent == null || idlePercent == null) return null;
    return {
      userPercent,
      sysPercent,
      idlePercent,
      usedPercent: Math.max(0, userPercent + sysPercent),
    };
  } catch {
    return null;
  }
}

function getMacMemoryUsageData(totalMem: number): HostMemoryUsageData | null {
  try {
    const output = execSync('vm_stat', { encoding: 'utf-8', timeout: 3000 });
    const pageSize = Number.parseInt(output.match(/page size of (\d+) bytes/i)?.[1] || '', 10);
    if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

    const pages = new Map<string, number>();
    for (const line of output.split('\n')) {
      const match = line.match(/^Pages ([^:]+):\s+(\d+)\./);
      if (!match) continue;
      pages.set(match[1].trim().toLowerCase(), Number.parseInt(match[2], 10));
    }

    const reclaimablePages =
      (pages.get('free') || 0) +
      (pages.get('inactive') || 0) +
      (pages.get('speculative') || 0) +
      (pages.get('purgeable') || 0);
    const availableBytes = Math.max(0, reclaimablePages * pageSize);
    const usedBytes = Math.max(0, Math.min(totalMem, totalMem - availableBytes));
    const percent = totalMem > 0 ? (usedBytes / totalMem) * 100 : 0;
    return { usedBytes, availableBytes, percent, source: 'vm_stat' };
  } catch {
    return null;
  }
}

function getHostCpuUsageData(): HostCpuUsageData | null {
  if (process.platform === 'darwin') return getMacCpuUsageData();
  return null;
}

function getHostDisplayName(): string {
  if (process.platform === 'darwin') {
    try {
      const name = execSync('scutil --get ComputerName', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (name) return name;
    } catch { /* fall through */ }
  }
  return os.hostname();
}

function getHostMemoryUsageData(totalMem: number, freeMem: number): HostMemoryUsageData {
  if (process.platform === 'darwin') {
    const macData = getMacMemoryUsageData(totalMem);
    if (macData) return macData;
  }

  const usedBytes = Math.max(0, totalMem - freeMem);
  const availableBytes = Math.max(0, freeMem);
  const percent = totalMem > 0 ? (usedBytes / totalMem) * 100 : 0;
  return { usedBytes, availableBytes, percent, source: 'os' };
}

// ---------------------------------------------------------------------------
// ChatState
// ---------------------------------------------------------------------------

export interface ChatState {
  agent: Agent;
  sessionId: string | null;
  localSessionId?: string | null;
  workspacePath?: string | null;
  codexCumulative?: CodexCumulativeUsage;
  modelId?: string | null;
  activeSessionKey?: string | null;
}

export interface SessionRuntime {
  key: string;
  workdir: string;
  agent: Agent;
  sessionId: string | null;
  localSessionId: string;
  workspacePath: string | null;
  codexCumulative?: CodexCumulativeUsage;
  modelId?: string | null;
  runningTaskIds: Set<string>;
}

export interface RunningTask {
  taskId: string;
  chatId: ChatId;
  agent: Agent;
  sessionKey: string;
  prompt: string;
  startedAt: number;
  sourceMessageId: number;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class Bot {
  workdir: string;
  defaultAgent: Agent;
  runTimeout: number;
  allowedChatIds: Set<ChatId>;

  // Per-agent config — keyed by agent id
  agentConfigs: Record<string, Record<string, any>> = {};

  // Convenience accessors (backward-compat)
  get codexModel(): string { return this.agentConfigs.codex?.model || ''; }
  set codexModel(v: string) { this.agentConfigs.codex.model = v; }
  get codexReasoningEffort(): string { return this.agentConfigs.codex?.reasoningEffort || 'xhigh'; }
  set codexReasoningEffort(v: string) { this.agentConfigs.codex.reasoningEffort = v; }
  get codexFullAccess(): boolean { return this.agentConfigs.codex?.fullAccess ?? true; }
  get codexExtraArgs(): string[] { return this.agentConfigs.codex?.extraArgs || []; }
  get claudeModel(): string { return this.agentConfigs.claude?.model || ''; }
  set claudeModel(v: string) { this.agentConfigs.claude.model = v; }
  get claudePermissionMode(): string { return this.agentConfigs.claude?.permissionMode || 'bypassPermissions'; }
  get claudeExtraArgs(): string[] { return this.agentConfigs.claude?.extraArgs || []; }

  chats = new Map<ChatId, ChatState>();
  sessionStates = new Map<string, SessionRuntime>();
  activeTasks = new Map<string, RunningTask>();
  startedAt = Date.now();
  stats = { totalTurns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0 };

  private keepAliveProc: ReturnType<typeof spawn> | null = null;
  private keepAlivePulseTimer: ReturnType<typeof setInterval> | null = null;
  private sessionChains = new Map<string, Promise<void>>();
  private userConfigUnsubscribe: (() => void) | null = null;

  constructor() {
    this.workdir = resolveUserWorkdir();

    // Initialize per-agent configs
    this.agentConfigs = {
      codex: {
        model: (process.env.CODEX_MODEL || 'gpt-5.4').trim(),
        reasoningEffort: (process.env.CODEX_REASONING_EFFORT || 'xhigh').trim().toLowerCase(),
        fullAccess: envBool('CODEX_FULL_ACCESS', true),
        extraArgs: shellSplit(process.env.CODEX_EXTRA_ARGS || ''),
      },
      claude: {
        model: (process.env.CLAUDE_MODEL || 'claude-opus-4-6').trim(),
        reasoningEffort: (process.env.CLAUDE_REASONING_EFFORT || 'high').trim().toLowerCase(),
        permissionMode: (process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions').trim(),
        extraArgs: shellSplit(process.env.CLAUDE_EXTRA_ARGS || ''),
      },
      gemini: {
        model: (process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview').trim(),
        extraArgs: shellSplit(process.env.GEMINI_EXTRA_ARGS || ''),
      },
    };

    this.defaultAgent = normalizeAgent('codex');
    this.runTimeout = envInt('CODECLAW_TIMEOUT', 1800);
    this.allowedChatIds = parseAllowedChatIds(process.env.CODECLAW_ALLOWED_IDS || '');
    this.refreshManagedConfig(getActiveUserConfig(), { initial: true });
    this.userConfigUnsubscribe = onUserConfigChange(config => this.refreshManagedConfig(config));
  }

  log(msg: string) {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`[codeclaw ${ts}] ${msg}\n`);
  }

  chat(chatId: ChatId): ChatState {
    let s = this.chats.get(chatId);
    if (!s) { s = { agent: this.defaultAgent, sessionId: null, activeSessionKey: null, modelId: null }; this.chats.set(chatId, s); }
    return s;
  }

  protected sessionKey(agent: Agent, localSessionId: string): string {
    return `${agent}:${localSessionId}`;
  }

  protected getSessionRuntimeByKey(sessionKey: string | null | undefined, opts: { allowAnyWorkdir?: boolean } = {}): SessionRuntime | null {
    if (!sessionKey) return null;
    const runtime = this.sessionStates.get(sessionKey) || null;
    if (!runtime) return null;
    if (!opts.allowAnyWorkdir && runtime.workdir !== this.workdir) return null;
    return runtime;
  }

  protected getSelectedSession(cs: ChatState): SessionRuntime | null {
    return this.getSessionRuntimeByKey(cs.activeSessionKey);
  }

  protected upsertSessionRuntime(session: {
    agent: Agent;
    localSessionId: string;
    sessionId?: string | null;
    workspacePath?: string | null;
    codexCumulative?: CodexCumulativeUsage;
    modelId?: string | null;
    workdir?: string;
  }): SessionRuntime {
    const workdir = path.resolve(session.workdir || this.workdir);
    const key = this.sessionKey(session.agent, session.localSessionId);
    const existing = this.sessionStates.get(key);
    if (existing) {
      existing.workdir = workdir;
      existing.agent = session.agent;
      if (session.sessionId !== undefined) existing.sessionId = session.sessionId ?? null;
      if (session.workspacePath !== undefined) existing.workspacePath = session.workspacePath ?? null;
      if (session.codexCumulative !== undefined) existing.codexCumulative = session.codexCumulative;
      if (session.modelId !== undefined) existing.modelId = session.modelId ?? null;
      return existing;
    }

    const runtime: SessionRuntime = {
      key,
      workdir,
      agent: session.agent,
      sessionId: session.sessionId ?? null,
      localSessionId: session.localSessionId,
      workspacePath: session.workspacePath ?? null,
      codexCumulative: session.codexCumulative,
      modelId: session.modelId ?? null,
      runningTaskIds: new Set<string>(),
    };
    this.sessionStates.set(key, runtime);
    return runtime;
  }

  protected applySessionSelection(cs: ChatState, session: SessionRuntime | null) {
    cs.activeSessionKey = session?.key ?? null;
    if (session) {
      cs.agent = session.agent;
      cs.sessionId = session.sessionId;
      cs.localSessionId = session.localSessionId;
      cs.workspacePath = session.workspacePath;
      cs.codexCumulative = session.codexCumulative;
      cs.modelId = session.modelId ?? null;
      return;
    }
    cs.sessionId = null;
    cs.localSessionId = null;
    cs.workspacePath = null;
    cs.codexCumulative = undefined;
    cs.modelId = null;
  }

  protected resetChatConversation(cs: ChatState) {
    this.applySessionSelection(cs, null);
  }

  protected adoptSession(cs: ChatState, session: Pick<SessionInfo, 'agent' | 'engineSessionId' | 'localSessionId' | 'workspacePath' | 'model'>) {
    if (!session.localSessionId) {
      this.applySessionSelection(cs, null);
      return;
    }
    const runtime = this.upsertSessionRuntime({
      agent: session.agent,
      localSessionId: session.localSessionId,
      sessionId: session.engineSessionId ?? null,
      workspacePath: session.workspacePath ?? null,
      modelId: session.model ?? null,
    });
    this.applySessionSelection(cs, runtime);
  }

  protected syncSelectedChats(session: SessionRuntime) {
    for (const [, cs] of this.chats) {
      if (cs.activeSessionKey !== session.key) continue;
      this.applySessionSelection(cs, session);
    }
  }

  protected beginTask(task: RunningTask) {
    this.activeTasks.set(task.taskId, task);
    const session = this.getSessionRuntimeByKey(task.sessionKey, { allowAnyWorkdir: true });
    session?.runningTaskIds.add(task.taskId);
  }

  protected finishTask(taskId: string) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    this.activeTasks.delete(taskId);
    const session = this.getSessionRuntimeByKey(task.sessionKey, { allowAnyWorkdir: true });
    if (!session) return;
    session.runningTaskIds.delete(taskId);
    if (!session.runningTaskIds.size && session.workdir !== this.workdir) {
      this.sessionStates.delete(session.key);
    }
  }

  protected runningTaskForSession(sessionKey: string | null | undefined): RunningTask | null {
    const session = this.getSessionRuntimeByKey(sessionKey, { allowAnyWorkdir: true });
    if (!session || !session.runningTaskIds.size) return null;
    let running: RunningTask | null = null;
    for (const taskId of session.runningTaskIds) {
      const task = this.activeTasks.get(taskId);
      if (!task) continue;
      if (!running || task.startedAt < running.startedAt) running = task;
    }
    return running;
  }

  protected queueSessionTask<T>(session: SessionRuntime, task: () => Promise<T>): Promise<T> {
    const prev = this.sessionChains.get(session.key) || Promise.resolve();
    const current = prev.catch(() => {}).then(task);
    const settled = current.then(() => {}, () => {});
    const chained = settled.finally(() => {
      if (this.sessionChains.get(session.key) === chained) this.sessionChains.delete(session.key);
    });
    this.sessionChains.set(session.key, chained);
    return current;
  }

  protected sessionHasPendingWork(session: SessionRuntime): boolean {
    return this.sessionChains.has(session.key);
  }

  modelForAgent(agent: Agent): string {
    return this.agentConfigs[agent]?.model || '';
  }

  fetchSessions(agent: Agent) {
    return getSessions({ agent, workdir: this.workdir });
  }

  fetchSessionTail(agent: Agent, sessionId: string, limit?: number) {
    return getSessionTail({ agent, sessionId, workdir: this.workdir, limit });
  }

  fetchAgents() {
    return listAgents();
  }

  fetchSkills() {
    return listSkills(this.workdir);
  }

  fetchModels(agent: Agent) {
    return listModels(agent, { workdir: this.workdir, currentModel: this.modelForAgent(agent) });
  }

  setDefaultAgent(agent: Agent) {
    const next = normalizeAgent(agent);
    const prev = this.defaultAgent;
    this.defaultAgent = next;
    for (const [, cs] of this.chats) {
      if (cs.activeSessionKey || cs.localSessionId || cs.sessionId) continue;
      if (cs.agent === prev) cs.agent = next;
    }
    this.log(`default agent changed to ${next}`);
  }

  setModelForAgent(agent: Agent, modelId: string) {
    const config = this.agentConfigs[agent];
    if (config) config.model = modelId;
    this.log(`model for ${agent} changed to ${modelId}`);
  }

  effortForAgent(agent: Agent): string | null {
    if (agent === 'gemini') return null;
    return this.agentConfigs[agent]?.reasoningEffort || 'high';
  }

  setEffortForAgent(agent: Agent, effort: string) {
    const config = this.agentConfigs[agent];
    if (config) config.reasoningEffort = effort;
    this.log(`effort for ${agent} changed to ${effort}`);
  }

  getStatusData(chatId: ChatId) {
    const cs = this.chat(chatId);
    const selectedSession = this.getSelectedSession(cs);
    const selectedTask = this.runningTaskForSession(selectedSession?.key ?? null);
    const fallbackTask = selectedTask || [...this.activeTasks.values()]
      .sort((a, b) => a.startedAt - b.startedAt)[0] || null;
    const model = selectedSession?.modelId || this.modelForAgent(cs.agent);
    const mem = process.memoryUsage();
    return {
      version: VERSION, uptime: Date.now() - this.startedAt,
      memRss: mem.rss, memHeap: mem.heapUsed, pid: process.pid,
      workdir: this.workdir, agent: cs.agent, model, sessionId: cs.sessionId,
      localSessionId: cs.localSessionId ?? null, workspacePath: cs.workspacePath ?? null,
      running: fallbackTask, activeTasksCount: this.activeTasks.size, stats: this.stats,
      usage: getUsage({ agent: cs.agent, model }),
    };
  }

  getHostData() {
    const cpus = os.cpus();
    const totalMem = os.totalmem(), freeMem = os.freemem();
    const memory = getHostMemoryUsageData(totalMem, freeMem);
    const cpuUsage = getHostCpuUsageData();
    let disk: { used: string; total: string; percent: string } | null = null;
    const battery = getHostBatteryData();
    try {
      const df = execSync(`df -h "${this.workdir}" | tail -1`, { encoding: 'utf-8', timeout: 3000 }).trim().split(/\s+/);
      if (df.length >= 5) disk = { used: df[2], total: df[1], percent: df[4] };
    } catch {}
    let topProcs: string[] = [];
    try {
      topProcs = execSync(`ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -6 || ps -eo pid,%cpu,%mem,comm -r 2>/dev/null | head -6`, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n');
    } catch {}
    const mem = process.memoryUsage();
    return {
      hostName: getHostDisplayName(),
      cpuModel: cpus[0]?.model || 'unknown', cpuCount: cpus.length,
      cpuUsage,
      totalMem, freeMem, memoryUsed: memory.usedBytes, memoryAvailable: memory.availableBytes, memoryPercent: memory.percent, memorySource: memory.source,
      disk, battery, topProcs,
      selfPid: process.pid, selfRss: mem.rss, selfHeap: mem.heapUsed,
    };
  }

  switchWorkdir(newPath: string) {
    const old = this.workdir;
    const resolvedPath = path.resolve(newPath.replace(/^~/, process.env.HOME || ''));
    this.workdir = resolvedPath;
    process.env.CODECLAW_WORKDIR = resolvedPath;
    for (const [, cs] of this.chats) {
      this.resetChatConversation(cs);
    }
    for (const [key, session] of this.sessionStates) {
      if (session.workdir === old && !session.runningTaskIds.size) this.sessionStates.delete(key);
    }
    ensureGitignore(resolvedPath);
    this.log(`switch workdir: ${old} -> ${resolvedPath}`);
    this.afterSwitchWorkdir(old, resolvedPath);
    return old;
  }

  protected afterSwitchWorkdir(_oldPath: string, _newPath: string) {}

  protected onManagedConfigChange(_config: Record<string, any>, _opts: { initial?: boolean } = {}) {}

  private refreshManagedConfig(config: Record<string, any>, opts: { initial?: boolean } = {}) {
    const nextWorkdir = resolveUserWorkdir({ config });
    if (opts.initial) {
      this.workdir = nextWorkdir;
      ensureGitignore(this.workdir);
    } else if (nextWorkdir !== this.workdir) {
      this.switchWorkdir(nextWorkdir);
    }

    const nextDefaultAgent = normalizeAgent(String(config.defaultAgent || 'codex').trim().toLowerCase() || 'codex');
    if (opts.initial) this.defaultAgent = nextDefaultAgent;
    else if (nextDefaultAgent !== this.defaultAgent) this.setDefaultAgent(nextDefaultAgent);

    if (!opts.initial) this.onManagedConfigChange(config, opts);
  }

  async runStream(
    prompt: string, cs: Pick<SessionRuntime, 'key' | 'agent' | 'sessionId' | 'localSessionId' | 'workspacePath' | 'codexCumulative' | 'modelId'> | ChatState, attachments: string[],
    onText: (text: string, thinking: string, activity?: string, meta?: StreamPreviewMeta, plan?: StreamPreviewPlan | null) => void,
    systemPrompt?: string,
  ): Promise<StreamResult> {
    const resolvedModel = cs.modelId || this.modelForAgent(cs.agent);
    const agentConfig = this.agentConfigs[cs.agent] || {};
    const extraArgs: string[] = agentConfig.extraArgs || [];
    this.log(`[runStream] agent=${cs.agent} session=${cs.sessionId || '(new)'} local_session=${cs.localSessionId || '(new)'} workdir=${this.workdir} timeout=${this.runTimeout}s attachments=${attachments.length}`);
    this.log(`[runStream] ${cs.agent} config: model=${resolvedModel} extraArgs=[${extraArgs.join(' ')}]`);
    const opts: StreamOpts = {
      agent: cs.agent, prompt, workdir: this.workdir, timeout: this.runTimeout,
      sessionId: cs.sessionId, localSessionId: cs.localSessionId ?? null, model: null,
      thinkingEffort: agentConfig.reasoningEffort || 'high', onText,
      attachments: attachments.length ? attachments : undefined,
      // codex-specific
      codexModel: cs.agent === 'codex' ? resolvedModel : this.codexModel,
      codexFullAccess: this.codexFullAccess,
      codexDeveloperInstructions: systemPrompt || undefined,
      codexExtraArgs: this.codexExtraArgs.length ? this.codexExtraArgs : undefined,
      codexPrevCumulative: cs.codexCumulative,
      // claude-specific
      claudeModel: cs.agent === 'claude' ? resolvedModel : this.claudeModel,
      claudePermissionMode: this.claudePermissionMode,
      claudeAppendSystemPrompt: systemPrompt || undefined,
      claudeExtraArgs: this.claudeExtraArgs.length ? this.claudeExtraArgs : undefined,
      // gemini-specific
      geminiModel: cs.agent === 'gemini' ? resolvedModel : (this.agentConfigs.gemini?.model || ''),
      geminiExtraArgs: this.agentConfigs.gemini?.extraArgs?.length ? this.agentConfigs.gemini.extraArgs : undefined,
    };
    const result = await doStream(opts);
    this.stats.totalTurns++;
    if (result.inputTokens) this.stats.totalInputTokens += result.inputTokens;
    if (result.outputTokens) this.stats.totalOutputTokens += result.outputTokens;
    if (result.cachedInputTokens) this.stats.totalCachedTokens += result.cachedInputTokens;
    if (result.codexCumulative) cs.codexCumulative = result.codexCumulative;
    if (result.sessionId) cs.sessionId = result.sessionId;
    if (result.localSessionId) cs.localSessionId = result.localSessionId;
    if (result.workspacePath) cs.workspacePath = result.workspacePath;
    if (result.model) cs.modelId = result.model;
    if ('key' in cs && typeof cs.key === 'string') {
      const runtime = this.getSessionRuntimeByKey(cs.key, { allowAnyWorkdir: true });
      if (runtime) this.syncSelectedChats(runtime);
    }
    this.log(`[runStream] completed turn=${this.stats.totalTurns} cumulative: in=${fmtTokens(this.stats.totalInputTokens)} out=${fmtTokens(this.stats.totalOutputTokens)} cached=${fmtTokens(this.stats.totalCachedTokens)}`);
    return result;
  }

  startKeepAlive() {
    if (process.platform === 'darwin') {
      if (this.keepAliveProc || this.keepAlivePulseTimer) return;
      const bin = whichSync('caffeinate');
      if (bin) {
        this.keepAliveProc = spawn('caffeinate', ['-dis'], { stdio: 'ignore', detached: true });
        this.keepAliveProc.unref();
        this.log(`keep-alive: caffeinate (PID ${this.keepAliveProc.pid})`);
        const pulseUserActivity = () => {
          const pulse = spawn('caffeinate', ['-u', '-t', String(MACOS_USER_ACTIVITY_PULSE_TIMEOUT_S)], {
            stdio: 'ignore',
            detached: true,
          });
          pulse.unref();
        };
        pulseUserActivity();
        this.keepAlivePulseTimer = setInterval(pulseUserActivity, MACOS_USER_ACTIVITY_PULSE_INTERVAL_MS);
        this.keepAlivePulseTimer.unref?.();
        this.log(`keep-alive: macOS user activity pulse every ${MACOS_USER_ACTIVITY_PULSE_INTERVAL_MS / 1000}s`);
      }
    } else if (process.platform === 'linux') {
      if (this.keepAliveProc) return;
      const bin = whichSync('systemd-inhibit');
      if (bin) {
        this.keepAliveProc = spawn('systemd-inhibit', [
          '--what=idle', '--who=codeclaw', '--why=AI coding agent running', 'sleep', 'infinity',
        ], { stdio: 'ignore', detached: true });
        this.keepAliveProc.unref();
        this.log(`keep-alive: systemd-inhibit (PID ${this.keepAliveProc.pid})`);
      }
    }
  }

  stopKeepAlive() {
    if (this.keepAlivePulseTimer) {
      clearInterval(this.keepAlivePulseTimer);
      this.keepAlivePulseTimer = null;
    }
    if (this.keepAliveProc) {
      try { this.keepAliveProc.kill('SIGTERM'); } catch {}
      this.keepAliveProc = null;
    }
  }
}
