/**
 * bot.ts — shared bot logic: config, state, streaming bridge, helpers, keep-alive.
 *
 * Channel-agnostic. Subclass per IM (see bot-telegram.ts).
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import {
  doStream, getSessions, getUsage, listAgents,
  type Agent, type StreamOpts, type StreamResult, type SessionInfo, type UsageResult,
} from './code-agent.js';

export { type Agent, type StreamResult, type SessionInfo, type UsageResult };
export const VERSION = '0.2.5';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

export function parseAllowedChatIds(raw: string): Set<number> {
  const ids = new Set<number>();
  for (const t of raw.split(',')) {
    const n = parseInt(t.trim(), 10);
    if (!Number.isNaN(n)) ids.add(n);
  }
  return ids;
}

const VALID_AGENTS = new Set<Agent>(['codex', 'claude']);

export function normalizeAgent(raw: string): Agent {
  const v = raw.trim().toLowerCase();
  if (!VALID_AGENTS.has(v as Agent)) throw new Error(`Invalid agent: ${v}. Use: codex, claude`);
  return v as Agent;
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
  return agent === 'codex' ? 'Reasoning' : 'Thinking';
}

export function buildPrompt(text: string, files: string[]): string {
  if (!files.length) return text;
  return `${text || 'Please analyze this.'}\n\n[Files: ${files.map(f => path.basename(f)).join(', ')}]`;
}

// ---------------------------------------------------------------------------
// ChatState
// ---------------------------------------------------------------------------

export interface ChatState {
  agent: Agent;
  sessionId: string | null;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class Bot {
  workdir: string;
  defaultAgent: Agent;
  runTimeout: number;
  allowedChatIds: Set<number>;

  codexModel: string;
  codexReasoningEffort: string;
  codexFullAccess: boolean;
  codexExtraArgs: string[];

  claudeModel: string;
  claudePermissionMode: string;
  claudeExtraArgs: string[];

  chats = new Map<number, ChatState>();
  activeTasks = new Map<number, { prompt: string; startedAt: number }>();
  startedAt = Date.now();
  stats = { totalTurns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0 };

  private keepAliveProc: ReturnType<typeof spawn> | null = null;

  constructor() {
    this.workdir = path.resolve((process.env.CODECLAW_WORKDIR || process.cwd()).replace(/^~/, process.env.HOME || ''));
    this.defaultAgent = normalizeAgent(process.env.DEFAULT_AGENT || 'claude');
    this.runTimeout = envInt('CODECLAW_TIMEOUT', 300);
    this.allowedChatIds = parseAllowedChatIds(process.env.CODECLAW_ALLOWED_IDS || '');

    this.codexModel = (process.env.CODEX_MODEL || 'gpt-5.4').trim();
    this.codexReasoningEffort = (process.env.CODEX_REASONING_EFFORT || 'xhigh').trim().toLowerCase();
    this.codexFullAccess = envBool('CODEX_FULL_ACCESS', true);
    this.codexExtraArgs = shellSplit(process.env.CODEX_EXTRA_ARGS || '');

    this.claudeModel = (process.env.CLAUDE_MODEL || 'claude-opus-4-6').trim();
    this.claudePermissionMode = (process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions').trim();
    this.claudeExtraArgs = shellSplit(process.env.CLAUDE_EXTRA_ARGS || '');
  }

  log(msg: string) {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`[codeclaw ${ts}] ${msg}\n`);
  }

  chat(chatId: number): ChatState {
    let s = this.chats.get(chatId);
    if (!s) { s = { agent: this.defaultAgent, sessionId: null }; this.chats.set(chatId, s); }
    return s;
  }

  modelForAgent(agent: Agent): string {
    if (agent === 'codex') return this.codexModel;
    return this.claudeModel;
  }

  fetchSessions(agent: Agent) {
    return getSessions({ agent, workdir: this.workdir });
  }

  fetchAgents() {
    return listAgents();
  }

  getStatusData(chatId: number) {
    const cs = this.chat(chatId);
    const mem = process.memoryUsage();
    return {
      version: VERSION, uptime: Date.now() - this.startedAt,
      memRss: mem.rss, memHeap: mem.heapUsed, pid: process.pid,
      workdir: this.workdir, agent: cs.agent, model: this.modelForAgent(cs.agent), sessionId: cs.sessionId,
      running: this.activeTasks.get(chatId) ?? null, stats: this.stats,
      usage: getUsage({ agent: cs.agent, model: this.modelForAgent(cs.agent) }),
    };
  }

  getHostData() {
    const cpus = os.cpus();
    const totalMem = os.totalmem(), freeMem = os.freemem();
    let disk: { used: string; total: string; percent: string } | null = null;
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
      cpuModel: cpus[0]?.model || 'unknown', cpuCount: cpus.length,
      totalMem, freeMem, disk, topProcs,
      selfPid: process.pid, selfRss: mem.rss, selfHeap: mem.heapUsed,
    };
  }

  switchWorkdir(newPath: string) {
    const old = this.workdir;
    this.workdir = newPath;
    for (const [, cs] of this.chats) cs.sessionId = null;
    this.log(`switch workdir: ${old} -> ${newPath}`);
    return old;
  }

  async runStream(
    prompt: string, cs: ChatState, attachments: string[],
    onText: (text: string, thinking: string) => void,
  ): Promise<StreamResult> {
    this.log(`[runStream] agent=${cs.agent} session=${cs.sessionId || '(new)'} workdir=${this.workdir} timeout=${this.runTimeout}s attachments=${attachments.length}`);
    if (cs.agent === 'claude') {
      this.log(`[runStream] claude config: model=${this.claudeModel} permission=${this.claudePermissionMode} extraArgs=[${this.claudeExtraArgs.join(' ')}]`);
    } else if (cs.agent === 'codex') {
      this.log(`[runStream] codex config: model=${this.codexModel} reasoning=${this.codexReasoningEffort} fullAccess=${this.codexFullAccess} extraArgs=[${this.codexExtraArgs.join(' ')}]`);
    }
    const snapshotSessionId = cs.sessionId;
    const opts: StreamOpts = {
      agent: cs.agent, prompt, workdir: this.workdir, timeout: this.runTimeout,
      sessionId: snapshotSessionId, model: null, thinkingEffort: this.codexReasoningEffort, onText,
      attachments: attachments.length ? attachments : undefined,
      codexModel: this.codexModel, codexFullAccess: this.codexFullAccess,
      codexExtraArgs: this.codexExtraArgs.length ? this.codexExtraArgs : undefined,
      claudeModel: this.claudeModel, claudePermissionMode: this.claudePermissionMode,
      claudeExtraArgs: this.claudeExtraArgs.length ? this.claudeExtraArgs : undefined,
    };
    const result = await doStream(opts);
    this.stats.totalTurns++;
    if (result.inputTokens) this.stats.totalInputTokens += result.inputTokens;
    if (result.outputTokens) this.stats.totalOutputTokens += result.outputTokens;
    if (result.cachedInputTokens) this.stats.totalCachedTokens += result.cachedInputTokens;
    // Only update sessionId if it hasn't been changed externally (e.g. user switched session during run)
    if (result.sessionId && cs.sessionId === snapshotSessionId) cs.sessionId = result.sessionId;
    this.log(`[runStream] completed turn=${this.stats.totalTurns} cumulative: in=${fmtTokens(this.stats.totalInputTokens)} out=${fmtTokens(this.stats.totalOutputTokens)} cached=${fmtTokens(this.stats.totalCachedTokens)}`);
    return result;
  }

  startKeepAlive() {
    if (process.platform === 'darwin') {
      const bin = whichSync('caffeinate');
      if (bin) {
        this.keepAliveProc = spawn('caffeinate', ['-dis'], { stdio: 'ignore', detached: true });
        this.keepAliveProc.unref();
        this.log(`keep-alive: caffeinate (PID ${this.keepAliveProc.pid})`);
      }
    } else if (process.platform === 'linux') {
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
    if (this.keepAliveProc) {
      try { this.keepAliveProc.kill('SIGTERM'); } catch {}
      this.keepAliveProc = null;
    }
  }
}
