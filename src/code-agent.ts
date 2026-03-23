/**
 * code-agent.ts — Shared agent layer: types, session management, artifact helpers,
 * CLI spawn framework, and unified entry points that delegate to per-agent drivers.
 *
 * Agent-specific logic lives in driver-claude.ts, driver-codex.ts, driver-gemini.ts.
 */

import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { getDriver, allDrivers, shutdownAllDrivers, hasDriver } from './agent-driver.js';
import { terminateProcessTree } from './process-control.js';
import { AGENT_DETECT_TIMEOUTS, AGENT_STREAM_HARD_KILL_GRACE_MS } from './constants.js';
export { type AgentDriver, registerDriver, getDriver, allDrivers, allDriverIds, hasDriver, shutdownAllDrivers } from './agent-driver.js';

// Load all drivers (side-effect: each calls registerDriver)
import './driver-claude.js';
import './driver-codex.js';
import './driver-gemini.js';

// Re-export driver-specific functions that external code imports directly
export { doClaudeStream } from './driver-claude.js';
export { doCodexStream, buildCodexTurnInput, shutdownCodexServer, getCodexUsageLive } from './driver-codex.js';
export { doGeminiStream } from './driver-gemini.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Agent = string;

export interface AgentDetectOptions {
  includeVersion?: boolean;
  refresh?: boolean;
  versionTimeoutMs?: number;
}

export interface CodexCumulativeUsage {
  input: number;
  output: number;
  cached: number;
}

export interface StreamPreviewMeta {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  contextPercent: number | null;
}

export interface StreamPreviewPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface StreamPreviewPlan {
  explanation: string | null;
  steps: StreamPreviewPlanStep[];
}

export interface CodexInteractionOption {
  label: string;
  description: string;
}

export interface CodexInteractionQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexInteractionOption[] | null;
}

export type CodexInteractionRequest =
  | {
    kind: 'requestUserInput';
    requestId: string;
    threadId: string;
    turnId: string;
    itemId: string;
    questions: CodexInteractionQuestion[];
  };

export interface StreamOpts {
  agent: Agent;
  prompt: string;
  workdir: string;
  timeout: number;
  sessionId: string | null;
  model: string | null;
  thinkingEffort: string;
  onText: (
    text: string,
    thinking: string,
    activity?: string,
    meta?: StreamPreviewMeta,
    plan?: StreamPreviewPlan | null,
  ) => void;
  /** Called when the agent reports the native session/thread ID before completion. */
  onSessionId?: (sessionId: string) => void;
  /** Local file paths to attach (images, documents, etc.) */
  attachments?: string[];
  // codex
  codexModel?: string;
  codexFullAccess?: boolean;
  codexDeveloperInstructions?: string;
  codexExtraArgs?: string[];
  codexPrevCumulative?: CodexCumulativeUsage;
  // claude
  claudeModel?: string;
  claudePermissionMode?: string;
  claudeAppendSystemPrompt?: string;
  claudeExtraArgs?: string[];
  // gemini
  geminiModel?: string;
  geminiApprovalMode?: string;
  geminiSandbox?: boolean;
  geminiSystemInstruction?: string;
  geminiExtraArgs?: string[];
  /** Override stdin payload (used for stream-json multimodal input) */
  _stdinOverride?: string;
  /** MCP bridge: callback when agent requests file send via MCP tool. Enables MCP bridge when provided. */
  mcpSendFile?: import('./mcp-bridge.js').McpSendFileCallback;
  /** Path to MCP config JSON — set by prepareStreamOpts, consumed by drivers. */
  mcpConfigPath?: string;
  /** Extra environment variables for the spawned agent process. */
  extraEnv?: Record<string, string>;
  /** Abort the in-flight stream. */
  abortSignal?: AbortSignal;
  /** Optional callback for Codex human-in-the-loop server requests. */
  onCodexInteractionRequest?: (request: CodexInteractionRequest) => Promise<Record<string, any> | null>;
}

export interface StreamResult {
  ok: boolean;
  message: string;
  thinking: string | null;
  sessionId: string | null;
  workspacePath: string | null;
  model: string | null;
  thinkingEffort: string;
  elapsedS: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  contextWindow: number | null;
  contextUsedTokens: number | null;
  contextPercent: number | null;
  codexCumulative: CodexCumulativeUsage | null;
  error: string | null;
  stopReason: string | null;
  incomplete: boolean;
  activity: string | null;
}

// ---------------------------------------------------------------------------
// Shared utilities (exported for drivers)
// ---------------------------------------------------------------------------

export const Q = (a: string) => /[^a-zA-Z0-9_./:=@-]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;

const AGENT_DETECT_TTL_MS = AGENT_DETECT_TIMEOUTS.detectTtl;
const AGENT_VERSION_TTL_MS = AGENT_DETECT_TIMEOUTS.versionTtl;
const AGENT_VERSION_TIMEOUT_MS = AGENT_DETECT_TIMEOUTS.versionCommand;

interface AgentDetectCacheEntry {
  detectedAt: number;
  versionAt: number;
  info: AgentInfo;
}

const agentDetectCache = new Map<string, AgentDetectCacheEntry>();

export function agentLog(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[agent ${ts}] ${msg}\n`);
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const item = String(value || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    deduped.push(item);
  }
  return deduped;
}

function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }

function readJsonFile<T>(filePath: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T; } catch { return fallback; }
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function removeFileIfExists(filePath: string) { try { fs.rmSync(filePath, { force: true }); } catch {} }

export function numberOrNull(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function normalizeActivityLine(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

export function pushRecentActivity(lines: string[], line: string, maxLines = 50) {
  const cleaned = normalizeActivityLine(line);
  if (!cleaned) return;
  if (lines[lines.length - 1] === cleaned) return;
  lines.push(cleaned);
  if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
}

export function firstNonEmptyLine(text: string): string {
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function shortValue(value: unknown, max = 90): string {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function normalizeErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value instanceof Error) return value.message.trim();
  if (Array.isArray(value)) {
    return value.map(item => normalizeErrorMessage(item)).filter(Boolean).join('; ').trim();
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const preferred = normalizeErrorMessage(record.message)
      || normalizeErrorMessage(record.error)
      || normalizeErrorMessage(record.detail)
      || normalizeErrorMessage(record.type)
      || normalizeErrorMessage(record.code)
      || normalizeErrorMessage(record.status);
    if (preferred) return preferred;
    try { return JSON.stringify(value).trim(); } catch {}
  }
  return value == null ? '' : String(value).trim();
}

export function joinErrorMessages(errors: unknown[] | null | undefined): string {
  if (!errors?.length) return '';
  return errors.map(error => normalizeErrorMessage(error)).filter(Boolean).join('; ').trim();
}

export function appendSystemPrompt(base: string | undefined, extra: string): string {
  const lhs = String(base || '').trim();
  const rhs = String(extra || '').trim();
  if (!lhs) return rhs;
  if (!rhs) return lhs;
  return `${lhs}\n\n${rhs}`;
}

export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

export function mimeForExt(ext: string): string {
  switch (ext) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

export function computeContext(s: {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  contextWindow: number | null;
  contextUsedTokens?: number | null;
}) {
  const fallbackTotal = (s.inputTokens ?? 0) + (s.cachedInputTokens ?? 0) + (s.cacheCreationInputTokens ?? 0);
  const used = s.contextUsedTokens ?? (fallbackTotal > 0 ? fallbackTotal : null);
  const pct = used != null && s.contextWindow
    ? Math.min(99.9, Math.round(used / s.contextWindow * 1000) / 10)
    : null;
  return { contextUsedTokens: used, contextPercent: pct };
}

export function buildStreamPreviewMeta(s: {
  inputTokens: number | null; outputTokens: number | null;
  cachedInputTokens: number | null; cacheCreationInputTokens: number | null;
  contextWindow: number | null; contextUsedTokens?: number | null;
}): StreamPreviewMeta {
  return {
    inputTokens: s.inputTokens, outputTokens: s.outputTokens,
    cachedInputTokens: s.cachedInputTokens, contextPercent: computeContext(s).contextPercent,
  };
}

// Claude tool use helpers (used by driver-claude.ts)
export function summarizeClaudeToolUse(name: string, input: any): string {
  const tool = String(name || '').trim() || 'Tool';
  const description = shortValue(input?.description, 120);
  switch (tool) {
    case 'Read': { const t = shortValue(input?.file_path || input?.path, 140); return t ? `Read ${t}` : 'Read file'; }
    case 'Edit': { const t = shortValue(input?.file_path || input?.path, 140); return t ? `Edit ${t}` : 'Edit file'; }
    case 'Write': { const t = shortValue(input?.file_path || input?.path, 140); return t ? `Write ${t}` : 'Write file'; }
    case 'Glob': { const p = shortValue(input?.pattern || input?.glob, 120); return p ? `List files: ${p}` : 'List files'; }
    case 'Grep': { const p = shortValue(input?.pattern || input?.query, 120); return p ? `Search text: ${p}` : 'Search text'; }
    case 'WebFetch': { const u = shortValue(input?.url, 120); return u ? `Fetch ${u}` : 'Fetch web page'; }
    case 'WebSearch': { const q = shortValue(input?.query, 120); return q ? `Search web: ${q}` : 'Search web'; }
    case 'TodoWrite': return 'Update plan';
    case 'Task': { const p = shortValue(input?.description || input?.prompt, 120); return p ? `Run task: ${p}` : 'Run task'; }
    case 'Bash': {
      if (description) return `Run shell: ${description}`;
      const c = shortValue(input?.command, 120);
      return c ? `Run shell: ${c}` : 'Run shell command';
    }
    default: {
      if (description) return `${tool}: ${description}`;
      const d = shortValue(input?.file_path || input?.path || input?.command || input?.query || input?.pattern || input?.url, 120);
      return d ? `${tool}: ${d}` : tool;
    }
  }
}

export function summarizeClaudeToolResult(
  tool: { name: string; summary: string } | undefined,
  block: any, toolUseResult: any,
): string {
  const summary = tool?.summary || shortValue(tool?.name || 'Tool', 120) || 'Tool';
  const isError = !!block?.is_error;
  if (isError) {
    const detail = firstNonEmptyLine(toolUseResult?.stderr || toolUseResult?.stdout || block?.content || '');
    return detail ? `${summary} failed: ${shortValue(detail, 120)}` : `${summary} failed`;
  }
  const toolName = tool?.name || '';
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'TodoWrite') return `${summary} done`;
  const detail = firstNonEmptyLine(toolUseResult?.stdout || block?.content || toolUseResult?.stderr || '');
  if (!detail) return `${summary} done`;
  return `${summary} -> ${shortValue(detail, 120)}`;
}

// Usage helpers (used by drivers)
export function roundPercent(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

export function toIsoFromEpochSeconds(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

export function normalizeUsageStatus(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/g, '_');
  if (normalized === 'limit_reached' || normalized === 'warning' || normalized === 'allowed') return normalized;
  if (normalized.includes('limit') || normalized.includes('exceeded') || normalized.includes('denied')) return 'limit_reached';
  if (normalized.includes('warning') || normalized.includes('warn')) return 'warning';
  if (normalized.includes('allowed') || normalized === 'ok' || normalized === 'healthy' || normalized === 'ready') return 'allowed';
  return normalized;
}

export function labelFromWindowMinutes(value: unknown, fallback: string): string {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  const roundedMinutes = Math.round(minutes);
  if (Math.abs(roundedMinutes - 300) <= 2) return '5h';
  if (Math.abs(roundedMinutes - 10080) <= 5) return '7d';

  const roundedDays = Math.round(roundedMinutes / 1440);
  if (roundedDays >= 1 && Math.abs(roundedMinutes - roundedDays * 1440) <= 5) return `${roundedDays}d`;

  const roundedHours = Math.round(roundedMinutes / 60);
  if (roundedHours >= 1 && Math.abs(roundedMinutes - roundedHours * 60) <= 2) return `${roundedHours}h`;

  return `${roundedMinutes}m`;
}

export function usageWindowFromRateLimit(fallback: string, limit: any): UsageWindowInfo | null {
  if (!limit || typeof limit !== 'object') return null;
  const usedPercent = roundPercent(limit.used_percent);
  const remainingPercent = usedPercent == null ? null : Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
  const resetAt = toIsoFromEpochSeconds(limit.reset_at ?? limit.resets_at);
  let resetAfterSeconds: number | null = null;
  const directResetAfter = Number(limit.reset_after_seconds);
  if (Number.isFinite(directResetAfter) && directResetAfter >= 0) resetAfterSeconds = Math.round(directResetAfter);
  else if (resetAt) {
    const resetAtMs = Date.parse(resetAt);
    if (Number.isFinite(resetAtMs)) resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
  }
  return {
    label: labelFromWindowMinutes(limit.window_minutes, fallback),
    usedPercent, remainingPercent, resetAt, resetAfterSeconds,
    status: normalizeUsageStatus(limit.status),
  };
}

export function parseJsonTail(raw: string): any | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(raw.slice(start)); } catch { return null; }
}

export function modelFamily(model: string | null | undefined): string | null {
  const lower = model?.toLowerCase() || '';
  if (!lower) return null;
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return null;
}

export function normalizeClaudeModelId(model: unknown): string {
  return typeof model === 'string' ? model.trim() : '';
}

export function emptyUsage(agent: Agent, error: string): UsageResult {
  return { ok: false, agent, source: null, capturedAt: null, status: null, windows: [], error };
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableCandidates(cmd: string): string[] {
  if (process.platform !== 'win32') return [cmd];
  const ext = path.extname(cmd).toLowerCase();
  if (ext) return [cmd];
  const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(value => value.trim())
    .filter(Boolean);
  return [cmd, ...pathExt.map(value => `${cmd}${value.toLowerCase()}`)];
}

function resolveAgentBinPath(cmd: string): string | null {
  const raw = String(cmd || '').trim();
  if (!raw) return null;

  const hasPathSeparator = raw.includes('/') || raw.includes('\\');
  if (hasPathSeparator) {
    const absolutePath = path.resolve(raw);
    for (const candidate of executableCandidates(absolutePath)) {
      if (isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  const searchPaths = String(process.env.PATH || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);

  for (const dir of searchPaths) {
    for (const candidate of executableCandidates(path.join(dir, raw))) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function readAgentVersion(binPath: string, timeoutMs: number): string | null {
  try {
    return execSync(`${Q(binPath)} --version 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: Math.max(250, timeoutMs),
    }).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

// Agent detection (used by all drivers)
export function detectAgentBin(cmd: string, agent: string, options: AgentDetectOptions = {}): AgentInfo {
  const cacheKey = `${agent}:${cmd}`;
  const now = Date.now();
  const includeVersion = !!options.includeVersion;
  const refresh = !!options.refresh;
  const versionTimeoutMs = options.versionTimeoutMs ?? AGENT_VERSION_TIMEOUT_MS;
  let entry = agentDetectCache.get(cacheKey) || null;

  const shouldRefreshBase = refresh || !entry || now - entry.detectedAt > AGENT_DETECT_TTL_MS;
  if (shouldRefreshBase) {
    const binPath = resolveAgentBinPath(cmd);
    const previousVersion = entry?.info.path === binPath ? entry.info.version ?? null : null;
    const previousVersionAt = entry?.info.path === binPath ? entry.versionAt : 0;
    entry = {
      detectedAt: now,
      versionAt: previousVersionAt,
      info: {
        agent,
        installed: !!binPath,
        path: binPath,
        version: previousVersion,
      },
    };
    agentDetectCache.set(cacheKey, entry);
  }

  if (!entry) {
    return { agent, installed: false, path: null, version: null };
  }

  if (
    includeVersion
    && entry.info.installed
    && entry.info.path
    && (refresh || !entry.versionAt || now - entry.versionAt > AGENT_VERSION_TTL_MS)
  ) {
    entry.info.version = readAgentVersion(entry.info.path, versionTimeoutMs);
    entry.versionAt = now;
    agentDetectCache.set(cacheKey, entry);
  }

  return { ...entry.info };
}

// Session tail helpers (used by drivers)
export function readTailLines(filePath: string, maxBytes = 256 * 1024): string[] {
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(maxBytes, stat.size);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    return buf.toString('utf-8').split('\n').filter(l => l.trim());
  } catch { return []; }
}

export function stripInjectedPrompts(text: string): string {
  const markers = ['\n[Session Workspace]'];
  for (const m of markers) {
    const idx = text.indexOf(m);
    if (idx >= 0) return text.slice(0, idx).trim();
  }
  return text;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface LocalSessionRecord {
  sessionId: string;
  agent: Agent;
  workdir: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  model: string | null;
  stagedFiles: string[];
  runState: SessionRunState;
  runDetail: string | null;
  runUpdatedAt: string | null;
}

interface SessionIndexData {
  version: number;
  sessions: LocalSessionRecord[];
}

interface EnsureSessionWorkspaceOpts {
  agent: Agent;
  workdir: string;
  sessionId?: string | null;
  title?: string | null;
}

interface SessionWorkspaceInfo {
  sessionId: string;
  workspacePath: string;
  record: LocalSessionRecord;
}

export type SessionRunState = 'running' | 'completed' | 'incomplete';

const PIKICLAW_DIR = '.pikiclaw';
const PIKICLAW_SESSIONS_DIR = path.join(PIKICLAW_DIR, 'sessions');
const PIKICLAW_SESSION_INDEX = path.join(PIKICLAW_SESSIONS_DIR, 'index.json');
const PIKICLAW_LEGACY_WORKSPACES_DIR = path.join(PIKICLAW_DIR, 'workspaces');
const SESSION_WORKSPACE_DIR = 'workspace';
const SESSION_META_FILE = 'session.json';
// return.json and artifact constants removed — file return is now handled by MCP bridge

function sessionIndexPath(workdir: string): string { return path.join(workdir, PIKICLAW_SESSION_INDEX); }
function sessionDirPath(workdir: string, agent: Agent, sessionId: string): string { return path.join(workdir, PIKICLAW_SESSIONS_DIR, agent, sessionId); }
function legacySessionWorkspacePath(workdir: string, agent: Agent, sessionId: string): string { return path.join(workdir, PIKICLAW_LEGACY_WORKSPACES_DIR, agent, sessionId); }
function sessionWorkspacePath(workdir: string, agent: Agent, sessionId: string): string { return path.join(sessionDirPath(workdir, agent, sessionId), SESSION_WORKSPACE_DIR); }
function sessionRootFromWorkspacePath(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  return path.basename(resolved) === SESSION_WORKSPACE_DIR ? path.dirname(resolved) : resolved;
}
function sessionMetaPath(workspacePath: string): string { return path.join(sessionRootFromWorkspacePath(workspacePath), SESSION_META_FILE); }
function legacySessionMetaPath(workspacePath: string): string { return path.join(workspacePath, PIKICLAW_DIR, SESSION_META_FILE); }

/** Generate a temporary session ID for new sessions before the agent assigns one. */
function nextPendingSessionId(): string { return `pending_${crypto.randomBytes(6).toString('hex')}`; }

export function isPendingSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith('pending_');
}

function normalizeSessionRunState(rawState: unknown): SessionRunState {
  const state = typeof rawState === 'string' ? rawState.trim().toLowerCase() : '';
  if (state === 'completed' || state === 'incomplete') return state;
  if (state === 'running') return 'incomplete';
  return 'completed';
}

function normalizeSessionRunDetail(rawState: unknown, rawDetail: unknown): string | null {
  const detail = typeof rawDetail === 'string' ? rawDetail.trim() : '';
  if (detail) return shortValue(detail, 180);
  const state = typeof rawState === 'string' ? rawState.trim().toLowerCase() : '';
  if (state === 'running') return 'Last run stopped before completion.';
  return null;
}

function normalizeSessionRunUpdatedAt(rawUpdatedAt: unknown, fallback: string): string {
  return typeof rawUpdatedAt === 'string' && rawUpdatedAt.trim() ? rawUpdatedAt : fallback;
}

function setSessionRunState(record: LocalSessionRecord, runState: SessionRunState, runDetail: string | null, runUpdatedAt?: string) {
  record.runState = runState;
  record.runDetail = runDetail ? shortValue(runDetail, 180) : null;
  record.runUpdatedAt = runUpdatedAt || new Date().toISOString();
}

function incompleteRunDetail(result: Pick<StreamResult, 'error' | 'stopReason' | 'message'>): string | null {
  if (result.stopReason === 'interrupted') return 'Interrupted by user.';
  if (result.stopReason === 'timeout') return 'Timed out before completion.';
  if (result.stopReason === 'max_tokens') return 'Stopped before completion: max tokens reached.';
  const error = normalizeErrorMessage(result.error);
  if (error) return shortValue(error, 180);
  const stopReason = normalizeErrorMessage(result.stopReason);
  if (stopReason) return `Stopped before completion: ${shortValue(stopReason, 120)}`;
  const message = firstNonEmptyLine(result.message || '');
  return message ? shortValue(message, 180) : 'Last run did not complete.';
}

function applySessionRunResult(record: LocalSessionRecord, result: Pick<StreamResult, 'ok' | 'incomplete' | 'error' | 'stopReason' | 'message'>) {
  if (result.ok && !result.incomplete) {
    setSessionRunState(record, 'completed', null);
    return;
  }
  setSessionRunState(record, 'incomplete', incompleteRunDetail(result));
}

function normalizeSessionRecord(raw: any, workdir: string): LocalSessionRecord | null {
  // Support both new format (sessionId) and legacy format (localSessionId + engineSessionId)
  const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId.trim()
    : typeof raw?.engineSessionId === 'string' && raw.engineSessionId.trim() ? raw.engineSessionId.trim()
    : typeof raw?.localSessionId === 'string' ? raw.localSessionId.trim()
    : '';
  const agent = typeof raw?.agent === 'string' ? raw.agent.trim() : null;
  if (!sessionId || !agent) return null;
  const workspacePath = typeof raw?.workspacePath === 'string' && raw.workspacePath.trim()
    ? path.resolve(raw.workspacePath)
    : sessionWorkspacePath(workdir, agent, sessionId);
  return {
    sessionId, agent, workdir,
    workspacePath,
    createdAt: typeof raw?.createdAt === 'string' && raw.createdAt.trim() ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw?.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : new Date().toISOString(),
    title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
    model: typeof raw?.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
    stagedFiles: Array.isArray(raw?.stagedFiles) ? dedupeStrings(raw.stagedFiles.filter((v: unknown) => typeof v === 'string')) : [],
    runState: normalizeSessionRunState(raw?.runState),
    runDetail: normalizeSessionRunDetail(raw?.runState, raw?.runDetail),
    runUpdatedAt: normalizeSessionRunUpdatedAt(raw?.runUpdatedAt, typeof raw?.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : new Date().toISOString()),
  };
}

function loadSessionIndex(workdir: string): SessionIndexData {
  const parsed = readJsonFile<any>(sessionIndexPath(workdir), { version: 1, sessions: [] });
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  return {
    version: 1,
    sessions: sessions
      .map((entry: any) => normalizeSessionRecord(entry, workdir))
      .filter((entry: LocalSessionRecord | null): entry is LocalSessionRecord => !!entry)
      .filter((entry: LocalSessionRecord) => !isPendingSessionId(entry.sessionId) || fs.existsSync(sessionRootFromWorkspacePath(entry.workspacePath))),
  };
}

function writeSessionIndex(workdir: string, sessions: LocalSessionRecord[]) {
  writeJsonFile(sessionIndexPath(workdir), { version: 1, sessions });
}

function writeSessionMeta(record: LocalSessionRecord) {
  writeJsonFile(sessionMetaPath(record.workspacePath), {
    sessionId: record.sessionId, agent: record.agent, workdir: record.workdir,
    workspacePath: record.workspacePath,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    title: record.title, model: record.model, stagedFiles: record.stagedFiles,
    runState: record.runState, runDetail: record.runDetail, runUpdatedAt: record.runUpdatedAt,
  });
}

function copyPath(sourcePath: string, targetPath: string) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) { fs.cpSync(sourcePath, targetPath, { recursive: true, force: true }); return; }
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function createSessionDirAlias(aliasPath: string, targetPath: string) {
  if (fs.existsSync(aliasPath) || !fs.existsSync(targetPath)) return;
  try {
    ensureDir(path.dirname(aliasPath));
    const relativeTarget = path.relative(path.dirname(aliasPath), targetPath) || '.';
    fs.symlinkSync(relativeTarget, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {}
}

function migrateSessionLayout(workdir: string, record: LocalSessionRecord): LocalSessionRecord {
  const targetSessionDir = sessionDirPath(workdir, record.agent, record.sessionId);
  const targetWorkspacePath = sessionWorkspacePath(workdir, record.agent, record.sessionId);
  const currentWorkspacePath = path.resolve(record.workspacePath || targetWorkspacePath);
  const legacyWp = path.resolve(legacySessionWorkspacePath(workdir, record.agent, record.sessionId));

  ensureDir(targetSessionDir);
  ensureDir(targetWorkspacePath);

  for (const sourceWorkspacePath of dedupeStrings([currentWorkspacePath, legacyWp])) {
    if (sourceWorkspacePath === targetWorkspacePath || !fs.existsSync(sourceWorkspacePath)) continue;
    if (!fs.statSync(sourceWorkspacePath).isDirectory()) continue;
    for (const entry of fs.readdirSync(sourceWorkspacePath)) {
      if (entry === PIKICLAW_DIR) continue;
      copyPath(path.join(sourceWorkspacePath, entry), path.join(targetWorkspacePath, entry));
    }
    if (sourceWorkspacePath === legacyWp) fs.rmSync(sourceWorkspacePath, { recursive: true, force: true });
  }
  record.workspacePath = path.resolve(targetWorkspacePath);
  return record;
}

function saveSessionRecord(workdir: string, record: LocalSessionRecord): LocalSessionRecord {
  record = migrateSessionLayout(workdir, record);
  ensureDir(sessionDirPath(workdir, record.agent, record.sessionId));
  ensureDir(record.workspacePath);
  const index = loadSessionIndex(workdir);
  record.updatedAt = new Date().toISOString();
  const pos = index.sessions.findIndex(entry => entry.sessionId === record.sessionId);
  if (pos >= 0) index.sessions[pos] = record;
  else index.sessions.unshift(record);
  index.sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  writeSessionIndex(workdir, index.sessions);
  writeSessionMeta(record);
  return record;
}

/**
 * Promote a pending session to a real session ID. Renames the workspace directory
 * and updates the index. Called after the first stream returns the agent's native ID.
 */
export function promoteSessionId(workdir: string, agent: Agent, pendingId: string, nativeId: string): void {
  if (!isPendingSessionId(pendingId) || !nativeId.trim()) return;
  const resolvedWorkdir = path.resolve(workdir);
  const index = loadSessionIndex(resolvedWorkdir);
  const record = index.sessions.find(entry => entry.sessionId === pendingId && entry.agent === agent);
  if (!record) return;

  const oldDir = sessionDirPath(resolvedWorkdir, agent, pendingId);
  const newDir = sessionDirPath(resolvedWorkdir, agent, nativeId);

  // Move workspace directory if it exists
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    try { fs.renameSync(oldDir, newDir); } catch { /* cross-device: copy+delete */ try { fs.cpSync(oldDir, newDir, { recursive: true }); fs.rmSync(oldDir, { recursive: true, force: true }); } catch {} }
    createSessionDirAlias(oldDir, newDir);
  }

  writeSessionIndex(
    resolvedWorkdir,
    index.sessions.filter(entry => entry.agent !== agent || (entry.sessionId !== pendingId && entry.sessionId !== nativeId)),
  );
  record.sessionId = nativeId;
  record.workspacePath = sessionWorkspacePath(resolvedWorkdir, agent, nativeId);
  saveSessionRecord(resolvedWorkdir, record);
}

function syncManagedSessionIdentity(session: SessionWorkspaceInfo, workdir: string, nativeId: string): boolean {
  const resolvedId = nativeId.trim();
  if (!resolvedId || session.sessionId === resolvedId) return false;

  const resolvedWorkdir = path.resolve(workdir);
  const previousId = session.sessionId;
  if (isPendingSessionId(previousId)) {
    promoteSessionId(resolvedWorkdir, session.record.agent, previousId, resolvedId);
  }

  session.sessionId = resolvedId;
  session.workspacePath = sessionWorkspacePath(resolvedWorkdir, session.record.agent, resolvedId);
  session.record.sessionId = resolvedId;
  session.record.workspacePath = session.workspacePath;
  return true;
}

function summarizePromptTitle(prompt: string | null | undefined): string | null {
  const raw = String(prompt || '').replace(/\r\n?/g, '\n');
  const text = firstNonEmptyLine(raw).replace(/\s+/g, ' ').trim()
    || raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}...`;
}

function safeWorkspaceFilename(filename: string): string {
  const base = path.basename(filename || 'file');
  const sanitized = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim();
  return sanitized || `file-${Date.now()}`;
}

function uniqueWorkspaceFilename(workspacePath: string, desiredName: string): string {
  const ext = path.extname(desiredName);
  const stem = ext ? desiredName.slice(0, -ext.length) : desiredName;
  let candidate = desiredName;
  let index = 2;
  while (fs.existsSync(path.join(workspacePath, candidate))) { candidate = `${stem}-${index}${ext}`; index++; }
  return candidate;
}

function importFilesIntoWorkspace(workspacePath: string, files: string[]): string[] {
  const imported: string[] = [];
  const realWorkspace = fs.realpathSync(workspacePath);
  for (const filePath of files) {
    const sourcePath = path.resolve(filePath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
    let relPath = path.relative(realWorkspace, sourcePath);
    if (relPath && !relPath.startsWith('..') && !path.isAbsolute(relPath)) {
      imported.push(relPath.split(path.sep).join(path.posix.sep));
      continue;
    }
    const targetName = uniqueWorkspaceFilename(workspacePath, safeWorkspaceFilename(path.basename(sourcePath)));
    fs.copyFileSync(sourcePath, path.join(workspacePath, targetName));
    imported.push(targetName);
  }
  return dedupeStrings(imported);
}

function ensureSessionWorkspace(opts: EnsureSessionWorkspaceOpts): SessionWorkspaceInfo {
  const workdir = path.resolve(opts.workdir);
  const index = loadSessionIndex(workdir);
  let record = index.sessions.find(entry => entry.agent === opts.agent && opts.sessionId && entry.sessionId === opts.sessionId)
    || null;
  if (!record) {
    const sessionId = opts.sessionId?.trim() || nextPendingSessionId();
    record = {
      sessionId, agent: opts.agent, workdir,
      workspacePath: sessionWorkspacePath(workdir, opts.agent, sessionId),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      title: summarizePromptTitle(opts.title) || null, model: null, stagedFiles: [],
      runState: 'completed', runDetail: null, runUpdatedAt: new Date().toISOString(),
    };
  }
  if (!record.title && opts.title) record.title = summarizePromptTitle(opts.title);
  record.workspacePath = path.resolve(record.workspacePath);
  saveSessionRecord(workdir, record);
  return { sessionId: record.sessionId, workspacePath: record.workspacePath, record };
}

// Exported for drivers
export function listPikiclawSessions(workdir: string, agent: Agent, limit?: number): LocalSessionRecord[] {
  const records = loadSessionIndex(path.resolve(workdir)).sessions
    .filter(entry => entry.agent === agent)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return typeof limit === 'number' ? records.slice(0, limit) : records;
}

export function findPikiclawSession(workdir: string, agent: Agent, sessionId: string): LocalSessionRecord | null {
  return listPikiclawSessions(workdir, agent).find(entry => entry.sessionId === sessionId) || null;
}

export function stageSessionFiles(opts: StageSessionFilesOpts): StageSessionFilesResult {
  const session = ensureSessionWorkspace({ agent: opts.agent, workdir: opts.workdir, sessionId: opts.sessionId, title: opts.title });
  const importedFiles = importFilesIntoWorkspace(session.workspacePath, opts.files);
  if (importedFiles.length) {
    session.record.stagedFiles = dedupeStrings([...session.record.stagedFiles, ...importedFiles]);
    if (!session.record.title) session.record.title = importedFiles[0];
    saveSessionRecord(opts.workdir, session.record);
  }
  return { sessionId: session.sessionId, workspacePath: session.workspacePath, importedFiles };
}

export interface StageSessionFilesOpts {
  agent: Agent;
  workdir: string;
  files: string[];
  sessionId?: string | null;
  title?: string | null;
}

export interface StageSessionFilesResult {
  sessionId: string;
  workspacePath: string;
  importedFiles: string[];
}

// ---------------------------------------------------------------------------
// Shared CLI spawn framework (used by driver-claude.ts, driver-gemini.ts)
// ---------------------------------------------------------------------------

export async function run(cmd: string[], opts: StreamOpts, parseLine: (ev: any, s: any) => void): Promise<StreamResult> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;
  let stderr = '';
  let lineCount = 0;
  let timedOut = false;
  let interrupted = false;
  const s = {
    sessionId: opts.sessionId, text: '', thinking: '', msgs: [] as string[], thinkParts: [] as string[],
    model: opts.model, thinkingEffort: opts.thinkingEffort, errors: null as unknown[] | null,
    inputTokens: null as number | null, outputTokens: null as number | null, cachedInputTokens: null as number | null,
    cacheCreationInputTokens: null as number | null, contextWindow: null as number | null,
    contextUsedTokens: null as number | null,
    codexCumulative: null as CodexCumulativeUsage | null,
    stopReason: null as string | null, activity: '',
    recentActivity: [] as string[],
    claudeToolsById: new Map<string, { name: string; summary: string }>(),
    seenClaudeToolIds: new Set<string>(),
    geminiToolsById: new Map<string, { name: string; summary: string }>(),
  };

  const shellCmd = cmd.map(Q).join(' ');
  agentLog(`[spawn] full command: cd ${Q(opts.workdir)} && ${shellCmd}`);
  agentLog(`[spawn] timeout: ${opts.timeout}s session: ${opts.sessionId || '(new)'}`);
  agentLog(`[spawn] prompt (stdin): "${opts.prompt.slice(0, 300)}${opts.prompt.length > 300 ? '…' : ''}"`);

  const spawnEnv = { ...process.env, ...(opts.extraEnv || {}) };
  delete spawnEnv.CLAUDECODE;
  const proc = spawn(shellCmd, {
    cwd: opts.workdir,
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
  });
  agentLog(`[spawn] pid=${proc.pid}`);
  const abortStream = () => {
    if (interrupted || proc.killed) return;
    interrupted = true;
    s.stopReason = 'interrupted';
    agentLog(`[abort] user interrupt, killing process tree pid=${proc.pid}`);
    terminateProcessTree(proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 5000 });
  };
  if (opts.abortSignal?.aborted) abortStream();
  opts.abortSignal?.addEventListener('abort', abortStream, { once: true });
  try { proc.stdin!.write(opts._stdinOverride ?? opts.prompt); proc.stdin!.end(); } catch {}
  proc.stderr?.on('data', (c: Buffer) => { const chunk = c.toString(); stderr += chunk; agentLog(`[stderr] ${chunk.trim().slice(0, 200)}`); });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on('line', raw => {
    if (Date.now() > deadline) {
      timedOut = true;
      s.stopReason = 'timeout';
      agentLog(`[timeout] deadline exceeded, killing process tree`);
      terminateProcessTree(proc, { signal: 'SIGKILL' });
      return;
    }
    const line = raw.trim();
    if (!line || line[0] !== '{') return;
    lineCount++;
    try {
      const ev = JSON.parse(line);
      const evType = ev.type || '?';
      if (evType === 'system' || evType === 'result' || evType === 'assistant' || evType === 'thread.started' || evType === 'turn.completed' || evType === 'item.completed') {
        agentLog(`[event] type=${evType} session=${ev.session_id || s.sessionId || '?'} model=${ev.model || s.model || '?'}`);
      }
      if (evType === 'stream_event') {
        const inner = ev.event || {};
        if (inner.type === 'message_start' || inner.type === 'message_delta') agentLog(`[event] stream_event/${inner.type} session=${ev.session_id || '?'}`);
      }
      parseLine(ev, s);
      opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), null);
    } catch {}
  });

  const hardTimer = setTimeout(() => {
    timedOut = true; s.stopReason = 'timeout';
    agentLog(`[timeout] hard deadline reached (${opts.timeout}s), killing process tree pid=${proc.pid}`);
    terminateProcessTree(proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 5000 });
  }, opts.timeout * 1000 + AGENT_STREAM_HARD_KILL_GRACE_MS);

  const [procOk, code] = await new Promise<[boolean, number | null]>(resolve => {
    proc.on('close', code => { clearTimeout(hardTimer); agentLog(`[exit] code=${code} lines_parsed=${lineCount}`); resolve([code === 0, code]); });
    proc.on('error', e => { clearTimeout(hardTimer); agentLog(`[error] ${e.message}`); stderr += e.message; resolve([false, -1]); });
  });
  opts.abortSignal?.removeEventListener('abort', abortStream);

  if (!s.text.trim() && s.msgs.length) s.text = s.msgs.join('\n\n');
  if (!s.thinking.trim() && s.thinkParts.length) s.thinking = s.thinkParts.join('\n\n');

  const errorText = joinErrorMessages(s.errors);
  const ok = procOk && !s.errors && !timedOut && !interrupted;
  const error = errorText
    || (interrupted ? 'Interrupted by user.' : null)
    || (timedOut ? `Timed out after ${opts.timeout}s before the agent reported completion.` : null)
    || (!procOk ? (stderr.trim() || `Failed (exit=${code}).`) : null);
  const incomplete = !ok || s.stopReason === 'max_tokens' || s.stopReason === 'timeout';
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  agentLog(`[result] ok=${ok && !s.errors} elapsed=${elapsed}s text=${s.text.length}chars thinking=${s.thinking.length}chars session=${s.sessionId || '?'}`);
  if (errorText) agentLog(`[result] errors: ${errorText}`);
  if (s.stopReason) agentLog(`[result] stop_reason=${s.stopReason}`);
  if (stderr.trim() && !procOk) agentLog(`[result] stderr: ${stderr.trim().slice(0, 300)}`);

  return {
    ok, sessionId: s.sessionId, workspacePath: null,
    model: s.model, thinkingEffort: s.thinkingEffort,
    message: s.text.trim() || errorText || (procOk ? '(no textual response)' : `Failed (exit=${code}).\n\n${stderr.trim() || '(no output)'}`),
    thinking: s.thinking.trim() || null,
    elapsedS: (Date.now() - start) / 1000,
    inputTokens: s.inputTokens, outputTokens: s.outputTokens, cachedInputTokens: s.cachedInputTokens,
    cacheCreationInputTokens: s.cacheCreationInputTokens, contextWindow: s.contextWindow,
    ...computeContext(s), codexCumulative: s.codexCumulative, error, stopReason: s.stopReason,
    incomplete, activity: s.activity.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Unified entry points (delegate to drivers via registry)
// ---------------------------------------------------------------------------

function prepareStreamOpts(opts: StreamOpts): { prepared: StreamOpts; session: SessionWorkspaceInfo; attachments: string[]; stagedFiles: string[] } {
  const session = ensureSessionWorkspace({ agent: opts.agent, workdir: opts.workdir, sessionId: opts.sessionId, title: opts.prompt });
  const importedFiles = importFilesIntoWorkspace(session.workspacePath, opts.attachments || []);
  const attachmentRelPaths = dedupeStrings([...session.record.stagedFiles, ...importedFiles]);
  // Capture staged files for MCP bridge before clearing
  const stagedFiles = [...session.record.stagedFiles];
  session.record.stagedFiles = [];
  if (!session.record.title) session.record.title = summarizePromptTitle(opts.prompt) || importedFiles[0] || null;
  setSessionRunState(session.record, 'running', null);
  saveSessionRecord(opts.workdir, session.record);

  const attachmentPaths = attachmentRelPaths.map(relPath => path.join(session.workspacePath, relPath));

  // For pending sessions, pass null sessionId to the CLI so it creates a new session
  const effectiveSessionId = isPendingSessionId(session.sessionId) ? null : session.sessionId;

  return {
    session,
    attachments: attachmentPaths,
    stagedFiles,
    prepared: {
      ...opts,
      sessionId: effectiveSessionId,
      attachments: attachmentPaths.length ? attachmentPaths : undefined,
      onSessionId: (nativeSessionId: string) => {
        if (!syncManagedSessionIdentity(session, opts.workdir, nativeSessionId)) return;
        saveSessionRecord(opts.workdir, session.record);
      },
    },
  };
}

function finalizeStreamResult(result: StreamResult, workdir: string, prompt: string, session: SessionWorkspaceInfo): StreamResult {
  if (result.sessionId) syncManagedSessionIdentity(session, workdir, result.sessionId);
  session.record.model = result.model || session.record.model;
  if (!session.record.title) session.record.title = summarizePromptTitle(prompt);
  applySessionRunResult(session.record, result);
  saveSessionRecord(workdir, session.record);
  return { ...result, sessionId: session.sessionId, workspacePath: session.workspacePath };
}

export async function doStream(opts: StreamOpts): Promise<StreamResult> {
  let session: SessionWorkspaceInfo;
  let prepared: StreamOpts;
  let stagedFiles: string[];
  try {
    const prep = prepareStreamOpts(opts);
    session = prep.session;
    prepared = prep.prepared;
    stagedFiles = prep.stagedFiles;
  } catch (e: any) {
    const message = e?.message || String(e);
    return {
      ok: false, message, thinking: null,
      sessionId: opts.sessionId, workspacePath: null, model: opts.model, thinkingEffort: opts.thinkingEffort,
      elapsedS: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null,
      cacheCreationInputTokens: null, contextWindow: null, contextUsedTokens: null, contextPercent: null,
      codexCumulative: null, error: message, stopReason: null, incomplete: true, activity: null,
    };
  }

  // Start MCP bridge if sendFile callback is provided
  let bridge: import('./mcp-bridge.js').McpBridgeHandle | null = null;
  if (opts.mcpSendFile) {
    try {
      const { startMcpBridge } = await import('./mcp-bridge.js');
      const sessionDir = path.dirname(session.workspacePath);
      bridge = await startMcpBridge({
        sessionDir,
        workspacePath: session.workspacePath,
        workdir: opts.workdir,
        stagedFiles,
        sendFile: opts.mcpSendFile,
        agent: opts.agent,
        onLog: (message: string) => agentLog(`[mcp] ${message}`),
      });
      prepared.mcpConfigPath = bridge.configPath;
      if (bridge.extraEnv) prepared.extraEnv = { ...(prepared.extraEnv || {}), ...bridge.extraEnv };
      if (bridge.configPath) agentLog(`[mcp] bridge started on ${bridge.configPath}`);
      else agentLog('[mcp] bridge registered with codex');
      try { agentLog(`[mcp] config content:\n${fs.readFileSync(bridge.configPath, 'utf-8')}`); } catch {};
    } catch (e: any) {
      agentLog(`[mcp] bridge start failed: ${e.message} — proceeding without MCP`);
    }
  }

  try {
    const driver = getDriver(prepared.agent);
    const result = await driver.doStream(prepared);
    return finalizeStreamResult(result, opts.workdir, opts.prompt, session);
  } catch (error: any) {
    const failedResult: StreamResult = {
      ok: false,
      message: normalizeErrorMessage(error) || 'Agent stream failed.',
      thinking: null,
      sessionId: session.sessionId,
      workspacePath: session.workspacePath,
      model: session.record.model,
      thinkingEffort: prepared.thinkingEffort,
      elapsedS: 0,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      contextWindow: null,
      contextUsedTokens: null,
      contextPercent: null,
      codexCumulative: null,
      error: normalizeErrorMessage(error) || 'Agent stream failed.',
      stopReason: null,
      incomplete: true,
      activity: null,
    };
    applySessionRunResult(session.record, failedResult);
    saveSessionRecord(opts.workdir, session.record);
    throw error;
  } finally {
    if (bridge) {
      await bridge.stop().catch(() => {});
      if (bridge.hadActivity()) agentLog('[mcp] bridge stopped');
    }
  }
}

// ---------------------------------------------------------------------------
// Session listing
// ---------------------------------------------------------------------------

export interface SessionInfo {
  sessionId: string | null;
  agent: Agent;
  workdir: string | null;
  workspacePath: string | null;
  model: string | null;
  createdAt: string | null;
  title: string | null;
  running: boolean;
  runState: SessionRunState;
  runDetail: string | null;
  runUpdatedAt: string | null;
}

export interface SessionListResult {
  ok: boolean;
  sessions: SessionInfo[];
  error: string | null;
}

export interface SessionListOpts {
  agent: Agent;
  workdir: string;
  limit?: number;
}

export function mergeManagedAndNativeSessions(managedSessions: SessionInfo[], nativeSessions: SessionInfo[]): SessionInfo[] {
  const managedById = new Map<string, SessionInfo>();
  const merged: SessionInfo[] = [];
  const seen = new Set<string>();

  for (const session of managedSessions) {
    if (!session.sessionId || isPendingSessionId(session.sessionId)) continue;
    managedById.set(session.sessionId, session);
  }

  for (const native of nativeSessions) {
    const sessionId = native.sessionId;
    if (sessionId) seen.add(sessionId);
    const managed = sessionId ? managedById.get(sessionId) : null;
    if (!managed) {
      merged.push(native);
      continue;
    }
    merged.push({
      ...managed,
      ...native,
      workdir: native.workdir || managed.workdir,
      workspacePath: managed.workspacePath || native.workspacePath,
      running: managed.running || native.running,
      runState: managed.runState,
      runDetail: managed.runDetail ?? native.runDetail,
      runUpdatedAt: managed.runUpdatedAt ?? native.runUpdatedAt,
      title: native.title || managed.title,
      model: native.model || managed.model,
      createdAt: native.createdAt || managed.createdAt,
    });
  }

  for (const managed of managedSessions) {
    if (!managed.sessionId || isPendingSessionId(managed.sessionId) || seen.has(managed.sessionId)) continue;
    merged.push(managed);
  }

  merged.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
  return merged;
}

export function getSessions(opts: SessionListOpts): Promise<SessionListResult> {
  const workdir = path.resolve(opts.workdir);
  agentLog(`[sessions] request agent=${opts.agent} workdir=${workdir} limit=${opts.limit ?? 'all'}`);
  return getDriver(opts.agent).getSessions(workdir, opts.limit).then(result => {
    agentLog(`[sessions] result agent=${opts.agent} ok=${result.ok} count=${result.sessions.length} error=${result.error || '(none)'}`);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Session tail
// ---------------------------------------------------------------------------

export interface TailMessage { role: 'user' | 'assistant'; text: string; }

export interface SessionTailResult {
  ok: boolean;
  messages: TailMessage[];
  error: string | null;
}

export interface SessionTailOpts {
  agent: Agent;
  sessionId: string;
  workdir: string;
  limit?: number;
}

export function getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
  return getDriver(opts.agent).getSessionTail(opts);
}

// ---------------------------------------------------------------------------
// Agent listing
// ---------------------------------------------------------------------------

export interface AgentInfo {
  agent: string;
  installed: boolean;
  path: string | null;
  version: string | null;
}

export interface AgentListResult { agents: AgentInfo[]; }

export function listAgents(options: AgentDetectOptions = {}): AgentListResult {
  return { agents: allDrivers().map(d => detectAgentBin(d.cmd, d.id, options)) };
}

// ---------------------------------------------------------------------------
// Skill listing
// ---------------------------------------------------------------------------

export interface SkillInfo {
  name: string;
  label: string | null;
  description: string | null;
  source: 'skills';
}

export interface SkillListResult { skills: SkillInfo[]; workdir: string; }

export interface ProjectSkillPaths {
  sharedSkillFile: string | null;
  claudeSkillFile: string | null;
  agentsSkillFile: string | null;
}

function parseSkillMeta(content: string): { label: string | null; description: string | null } {
  let label: string | null = null;
  let description: string | null = null;
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fm) {
    const lm = fm[1].match(/^label:\s*(.+)/m);
    if (lm) label = lm[1].trim();
    const dm = fm[1].match(/^description:\s*(.+)/m);
    if (dm) description = dm[1].trim();
  }
  if (!label) { const hm = content.match(/^#\s+(.+)$/m); if (hm) label = hm[1].trim(); }
  return { label, description };
}

function hasFile(filePath: string): boolean {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function hasDir(dirPath: string): boolean {
  try { return fs.statSync(dirPath).isDirectory(); } catch { return false; }
}

function readSortedDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  } catch {
    return [];
  }
}

function listRelativeFiles(dirPath: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readSortedDir(dirPath)) {
    const abs = path.join(dirPath, entry);
    const rel = prefix ? path.join(prefix, entry) : entry;
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) files.push(...listRelativeFiles(abs, rel));
    else if (stat.isFile()) files.push(rel);
  }
  return files;
}

function realPathOrNull(filePath: string): string | null {
  try { return fs.realpathSync(filePath); } catch { return null; }
}

function ensureDirSymlink(linkPath: string, targetDir: string) {
  const desiredTarget = path.relative(path.dirname(linkPath), targetDir) || '.';
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(linkPath);
      const currentReal = realPathOrNull(path.resolve(path.dirname(linkPath), currentTarget));
      const desiredReal = realPathOrNull(targetDir);
      if (currentTarget === desiredTarget || (currentReal && desiredReal && currentReal === desiredReal)) return;
    }
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(desiredTarget, linkPath, 'dir');
}

function resetDir(dirPath: string) {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyMergedTree(
  sourceRoot: string,
  targetRoot: string,
  opts: { log?: (message: string) => void } = {},
) {
  for (const relPath of listRelativeFiles(sourceRoot)) {
    const sourcePath = path.join(sourceRoot, relPath);
    const targetPath = path.join(targetRoot, relPath);
    if (hasFile(targetPath)) {
      opts.log?.(`skills merge skipped existing file: ${relPath}`);
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

export function initializeProjectSkills(workdir: string, opts: { log?: (message: string) => void } = {}): void {
  const canonicalRoot = path.join(workdir, '.pikiclaw', 'skills');
  const claudeRoot = path.join(workdir, '.claude', 'skills');
  const agentsRoot = path.join(workdir, '.agents', 'skills');
  const mergeRoot = path.join(workdir, '.pikiclaw', '.skills-merge-tmp');
  const sourceRoots = [canonicalRoot, claudeRoot, agentsRoot];
  const seenSourceReals = new Set<string>();

  resetDir(mergeRoot);

  // Merge order defines precedence: existing canonical content wins first,
  // then legacy Claude skills, then legacy agents skills.
  for (const sourceRoot of sourceRoots) {
    if (!hasDir(sourceRoot)) continue;
    const realSource = realPathOrNull(sourceRoot);
    if (realSource && seenSourceReals.has(realSource)) continue;
    if (realSource) seenSourceReals.add(realSource);
    copyMergedTree(sourceRoot, mergeRoot, opts);
  }

  resetDir(canonicalRoot);
  copyMergedTree(mergeRoot, canonicalRoot, opts);
  try { fs.rmSync(mergeRoot, { recursive: true, force: true }); } catch {}

  for (const linkRoot of [claudeRoot, agentsRoot]) {
    ensureDirSymlink(linkRoot, canonicalRoot);
  }
  opts.log?.(`skills merged into .pikiclaw/skills and linked to .claude/.agents workdir=${workdir}`);
}

export function getProjectSkillPaths(workdir: string, skillName: string): ProjectSkillPaths {
  const sharedSkillFile = path.join(workdir, '.pikiclaw', 'skills', skillName, 'SKILL.md');
  const agentsSkillFile = path.join(workdir, '.agents', 'skills', skillName, 'SKILL.md');
  const claudeSkillFile = path.join(workdir, '.claude', 'skills', skillName, 'SKILL.md');
  return {
    sharedSkillFile: hasFile(sharedSkillFile) ? sharedSkillFile : null,
    agentsSkillFile: hasFile(agentsSkillFile) ? agentsSkillFile : null,
    claudeSkillFile: hasFile(claudeSkillFile) ? claudeSkillFile : null,
  };
}

export function listSkills(workdir: string): SkillListResult {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  const skillRoots = [
    path.join(workdir, '.pikiclaw', 'skills'),
  ];
  for (const skillsDir of skillRoots) {
    for (const entry of readSortedDir(skillsDir)) {
      if (!entry || seen.has(entry)) continue;
      const skillDir = path.join(skillsDir, entry);
      const skillFile = path.join(skillDir, 'SKILL.md');
      try { if (!fs.statSync(skillDir).isDirectory()) continue; } catch { continue; }
      if (!hasFile(skillFile)) continue;
      let meta = { label: null as string | null, description: null as string | null };
      try { meta = parseSkillMeta(fs.readFileSync(skillFile, 'utf-8')); } catch {}
      skills.push({ name: entry, label: meta.label, description: meta.description, source: 'skills' });
      seen.add(entry);
    }
  }
  return { skills, workdir };
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

export interface ModelInfo { id: string; alias: string | null; }

export interface ModelListResult {
  agent: Agent;
  models: ModelInfo[];
  sources: string[];
  note: string | null;
}

export interface ModelListOpts {
  workdir?: string;
  currentModel?: string | null;
}

export function listModels(agent: Agent, opts: ModelListOpts = {}): Promise<ModelListResult> {
  return getDriver(agent).listModels(opts);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface UsageWindowInfo {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  resetAfterSeconds: number | null;
  status: string | null;
}

export interface UsageResult {
  ok: boolean;
  agent: Agent;
  source: string | null;
  capturedAt: string | null;
  status: string | null;
  windows: UsageWindowInfo[];
  error: string | null;
}

export interface UsageOpts {
  agent: Agent;
  model?: string | null;
}

export function getUsage(opts: UsageOpts): UsageResult {
  return getDriver(opts.agent).getUsage(opts);
}
