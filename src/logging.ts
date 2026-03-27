import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogStream = 'stdout' | 'stderr';

interface RetainedLogOptions {
  maxLines?: number;
  maxAgeMs?: number;
  trimEveryWrites?: number;
}

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_LOG_MAX_LINES = 5000;
const DEFAULT_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOG_TRIM_EVERY_WRITES = 200;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveRetention(options: RetainedLogOptions = {}) {
  return {
    maxLines: options.maxLines ?? positiveIntEnv('PIKICLAW_LOG_MAX_LINES', DEFAULT_LOG_MAX_LINES),
    maxAgeMs: options.maxAgeMs ?? positiveIntEnv('PIKICLAW_LOG_MAX_AGE_MS', DEFAULT_LOG_MAX_AGE_MS),
    trimEveryWrites: options.trimEveryWrites ?? positiveIntEnv('PIKICLAW_LOG_TRIM_EVERY_WRITES', DEFAULT_LOG_TRIM_EVERY_WRITES),
  };
}

export function normalizeLogLevel(value: unknown, fallback: LogLevel = DEFAULT_LOG_LEVEL): LogLevel {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }
  return fallback;
}

export function getConfiguredLogLevel(): LogLevel {
  return normalizeLogLevel(process.env.PIKICLAW_LOG_LEVEL, DEFAULT_LOG_LEVEL);
}

export function shouldLog(level: LogLevel, configuredLevel = getConfiguredLogLevel()): boolean {
  return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[configuredLevel];
}

export function formatScopedLogLine(scope: string, message: string, now = new Date()): string {
  const ts = now.toTimeString().slice(0, 8);
  return `[${scope} ${ts}] ${message}\n`;
}

export function writeScopedLog(
  scope: string,
  message: string,
  options: { level?: LogLevel; stream?: LogStream; now?: Date } = {},
): boolean {
  const level = options.level ?? 'info';
  if (!shouldLog(level)) return false;
  const line = formatScopedLogLine(scope, message, options.now);
  if (options.stream === 'stderr') process.stderr.write(line);
  else process.stdout.write(line);
  return true;
}

function trimRetainedLogContent(content: string, maxLines: number): string {
  if (!content) return content;
  const normalized = content.replace(/\r\n/g, '\n');
  const hasTrailingNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (hasTrailingNewline) lines.pop();
  if (lines.length <= maxLines) return content;
  return `${lines.slice(-maxLines).join('\n')}\n`;
}

export function pruneRetainedLogFile(filePath: string, options: RetainedLogOptions = {}): void {
  const { maxLines, maxAgeMs } = resolveRetention(options);
  try {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs > maxAgeMs) {
      fs.writeFileSync(filePath, '');
      return;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const trimmed = trimRetainedLogContent(content, maxLines);
    if (trimmed !== content) fs.writeFileSync(filePath, trimmed);
  } catch {}
}

export function createRetainedLogSink(filePath: string, options: RetainedLogOptions = {}): (chunk: string) => void {
  const { trimEveryWrites } = resolveRetention(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  pruneRetainedLogFile(filePath, options);
  let writes = 0;
  return (chunk: string) => {
    if (!chunk) return;
    try {
      fs.appendFileSync(filePath, chunk);
      writes++;
      if (writes === 1 || writes % trimEveryWrites === 0) pruneRetainedLogFile(filePath, options);
    } catch {}
  };
}
