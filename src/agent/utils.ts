/**
 * Pure utility functions shared across the agent layer.
 * No filesystem or session state side effects.
 */

import fs from 'node:fs';
import type {
  StreamPreviewMeta,
  StreamPreviewPlan,
  StreamPreviewPlanStep,
  UsageResult,
  UsageWindowInfo,
  Agent,
} from './types.js';
import { writeScopedLog, type LogLevel } from '../core/logging.js';

export const Q = (a: string) => {
  if (/[^a-zA-Z0-9_./:=@-]/.test(a)) {
    return process.platform === 'win32'
      ? `"${a.replace(/"/g, '""')}"`
      : `'${a.replace(/'/g, "'\\''")}'`;
  }
  return a;
};

export function agentLog(msg: string, level: LogLevel = 'debug') {
  writeScopedLog('agent', msg, { level });
}

export function agentWarn(msg: string) {
  agentLog(msg, 'warn');
}

export function agentError(msg: string) {
  agentLog(msg, 'error');
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

export function numberOrNull(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function normalizeStreamPreviewPlan(value: unknown): StreamPreviewPlan | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const rawSteps = Array.isArray(record.steps)
    ? record.steps
    : Array.isArray(record.plan)
      ? record.plan
      : [];
  const steps = rawSteps
    .map((entry): StreamPreviewPlanStep | null => {
      if (!entry || typeof entry !== 'object') return null;
      const step = typeof (entry as any).step === 'string' ? (entry as any).step.trim() : '';
      if (!step) return null;
      const rawStatus = typeof (entry as any).status === 'string' ? (entry as any).status : 'pending';
      const status = rawStatus === 'completed' || rawStatus === 'inProgress' || rawStatus === 'pending'
        ? rawStatus
        : 'pending';
      return { step, status };
    })
    .filter((entry): entry is StreamPreviewPlanStep => !!entry);
  if (!steps.length) return null;
  return {
    explanation: typeof record.explanation === 'string' && record.explanation.trim() ? record.explanation.trim() : null,
    steps,
  };
}

/** Parse a TodoWrite tool input into a StreamPreviewPlan. */
export function parseTodoWriteAsPlan(input: any): StreamPreviewPlan | null {
  if (!input || typeof input !== 'object') return null;
  const rawTodos = Array.isArray(input.todos) ? input.todos : [];
  if (!rawTodos.length) return null;
  const steps: StreamPreviewPlanStep[] = [];
  for (const todo of rawTodos) {
    if (!todo || typeof todo !== 'object') continue;
    const content = typeof todo.content === 'string' ? todo.content.trim() : '';
    if (!content) continue;
    const rawStatus = typeof todo.status === 'string' ? todo.status : 'pending';
    const status = rawStatus === 'completed' ? 'completed'
      : rawStatus === 'in_progress' ? 'inProgress'
        : 'pending';
    steps.push({ step: content, status });
  }
  if (!steps.length) return null;
  return { explanation: null, steps };
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
    if (idx >= 0) text = text.slice(0, idx).trim();
  }
  // Strip Codex IDE context prefix ("# Context from my IDE setup: ...")
  if (text.startsWith('# Context from')) {
    const tag = '## My request for Codex:\n';
    const idx = text.indexOf(tag);
    if (idx >= 0) return text.slice(idx + tag.length).trim();
    return '';
  }
  return text;
}

export const SESSION_PREVIEW_IGNORED_USER_PATTERNS = [
  /^\[Request interrupted by user(?: for tool use)?\]$/i,
];

export const SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE = /\[Image:[^\]]+\]/gi;
export const SESSION_PREVIEW_FILE_PLACEHOLDER_RE = /\[Attached file:[^\]]+\]/gi;

export function sanitizeSessionUserPreviewText(text: string): string {
  const cleaned = stripInjectedPrompts(text)
    .replace(SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE, ' ')
    .replace(SESSION_PREVIEW_FILE_PLACEHOLDER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (SESSION_PREVIEW_IGNORED_USER_PATTERNS.some(pattern => pattern.test(cleaned))) return '';
  return cleaned;
}

export function isPendingSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith('pending_');
}
