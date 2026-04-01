/**
 * Pure utility functions shared across all layers. No filesystem side effects, no state dependencies.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type ChatId = number | string;

/**
 * If `dir` has a .gitignore, ignore managed `.pikiclaw` state without hiding
 * `.pikiclaw/skills`, which may be committed as project skills.
 */
export function ensureGitignore(dir: string) {
  try {
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) return;
    const managedLines = [
      '.pikiclaw/*',
      '!.pikiclaw/skills/',
      '!.pikiclaw/skills/**',
    ];
    const legacyLines = new Set([
      '.pikiclaw/',
      '.claude/skills/',
      '.agents/skills/',
    ]);
    const rawLines = fs.readFileSync(gi, 'utf8').split(/\r?\n/);
    const normalized = rawLines.filter(line => {
      const trimmed = line.trim();
      return trimmed && !managedLines.includes(trimmed) && !legacyLines.has(trimmed);
    });
    const next = [...normalized, ...managedLines, ''].join('\n');
    const current = fs.readFileSync(gi, 'utf8');
    if (current === next) return;
    fs.writeFileSync(gi, next);
  } catch { /* best-effort */ }
}

export function envBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function envString(name: string, def: string): string {
  const raw = process.env[name];
  if (raw == null) return def;
  const trimmed = raw.trim();
  return trimmed || def;
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

export function extractThinkingTail(text: string, maxLines = 10): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';

  const lines = normalized
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim());
  if (lines.length > maxLines) return lines.slice(-maxLines).join('\n').trim();
  return normalized;
}

export function formatThinkingForDisplay(text: string, maxChars = 1600): string {
  let display = extractThinkingTail(text);
  if (display.length > maxChars) display = '...\n' + display.slice(-maxChars);
  return display;
}

export function buildPrompt(text: string, files: string[]): string {
  if (!files.length) return text;
  return `${text || 'Please analyze this.'}\n\n[Files: ${files.map(f => path.basename(f)).join(', ')}]`;
}

/** Race a promise against a timeout, resolving with `fallback` on timeout or rejection. */
export function withTimeoutFallback<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);

    promise
      .then(result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}
