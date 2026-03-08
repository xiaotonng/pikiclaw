/**
 * bot-telegram.ts — Telegram-specific bot: formatting, keyboards, callbacks, lifecycle.
 *
 * All Telegram presentation logic lives here. For a new IM (Lark, WhatsApp, ...),
 * create a parallel bot-lark.ts / bot-whatsapp.ts that extends Bot.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  Bot, VERSION, type Agent, type StreamResult,
  fmtTokens, fmtUptime, fmtBytes, whichSync, listSubdirs, buildPrompt,
  thinkLabel, parseAllowedChatIds, shellSplit, type SkillInfo,
} from './bot.js';
import { getCodexUsageLive, shutdownCodexServer } from './code-agent.js';
import { TelegramChannel, type TgContext, type TgCallbackContext, type TgMessage } from './channel-telegram.js';
import { splitText } from './channel-base.js';

// ---------------------------------------------------------------------------
// Context window sizes (max input tokens per model family)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Telegram HTML formatting
// ---------------------------------------------------------------------------

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function claudeModelAlias(modelId: string | null | undefined): string | null {
  const value = String(modelId || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'opus' || value.startsWith('claude-opus-')) return 'opus';
  if (value === 'sonnet' || value.startsWith('claude-sonnet-')) return 'sonnet';
  if (value === 'haiku' || value.startsWith('claude-haiku-')) return 'haiku';
  return null;
}

function modelMatchesSelection(agent: Agent, selection: string, currentModel: string): boolean {
  if (selection === currentModel) return true;
  if (agent !== 'claude') return false;
  const a = claudeModelAlias(selection);
  const b = claudeModelAlias(currentModel);
  return !!a && a === b;
}

function mdToTgHtml(text: string): string {
  const result: string[] = [];
  const lines = text.split('\n');
  let i = 0, inCode = false, codeLang = '', codeLines: string[] = [];

  while (i < lines.length) {
    const line = lines[i], stripped = line.trim();
    if (stripped.startsWith('```')) {
      if (!inCode) { inCode = true; codeLang = stripped.slice(3).trim().split(/\s/)[0] || ''; codeLines = []; }
      else {
        inCode = false;
        const content = escapeHtml(codeLines.join('\n'));
        result.push(codeLang ? `<pre><code class="language-${escapeHtml(codeLang)}">${content}</code></pre>` : `<pre>${content}</pre>`);
      }
      i++; continue;
    }
    if (inCode) { codeLines.push(line); i++; continue; }
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) { result.push(`<b>${mdInline(hm[2])}</b>`); i++; continue; }
    result.push(mdInline(line)); i++;
  }
  if (inCode && codeLines.length) result.push(`<pre>${escapeHtml(codeLines.join('\n'))}</pre>`);
  return result.join('\n');
}

function mdInline(line: string): string {
  const parts: string[] = [];
  let rest = line;
  while (rest.includes('`')) {
    const a = rest.indexOf('`'), b = rest.indexOf('`', a + 1);
    if (b === -1) break;
    parts.push(fmtSeg(rest.slice(0, a)));
    parts.push(`<code>${escapeHtml(rest.slice(a + 1, b))}</code>`);
    rest = rest.slice(b + 1);
  }
  parts.push(fmtSeg(rest));
  return parts.join('');
}

function fmtSeg(t: string): string {
  t = escapeHtml(t);
  t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  t = t.replace(/__(.+?)__/g, '<b>$1</b>');
  t = t.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  t = t.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');
  t = t.replace(/~~(.+?)~~/g, '<s>$1</s>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

function isNpxBinary(bin: string): boolean {
  return path.basename(bin, path.extname(bin)).toLowerCase() === 'npx';
}

function ensureNonInteractiveRestartArgs(bin: string, args: string[]): string[] {
  if (!isNpxBinary(bin)) return args;
  if (args.includes('--yes') || args.includes('-y')) return args;
  return ['--yes', ...args];
}

export type ArtifactKind = 'photo' | 'document';

export interface BotArtifact {
  filePath: string;
  filename: string;
  kind: ArtifactKind;
  caption?: string;
}

const ARTIFACT_MANIFEST = 'manifest.json';
const ARTIFACT_ROOT = path.join(os.tmpdir(), 'codeclaw-artifacts');
const ARTIFACT_MAX_FILES = 8;
const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
const ARTIFACT_PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isPhotoFilename(filename: string): boolean {
  return ARTIFACT_PHOTO_EXTS.has(path.extname(filename).toLowerCase());
}

export function collectArtifacts(dirPath: string, manifestPath: string, log?: (msg: string) => void): BotArtifact[] {
  const _log = log || (() => {});
  if (!fs.existsSync(manifestPath)) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    _log(`artifact manifest parse error: ${e}`);
    return [];
  }

  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.files) ? parsed.files : [];
  if (!entries.length) return [];

  const realDir = fs.realpathSync(dirPath);
  const artifacts: BotArtifact[] = [];

  for (const entry of entries.slice(0, ARTIFACT_MAX_FILES)) {
    const rawPath = typeof entry?.path === 'string' ? entry.path
      : typeof entry?.name === 'string' ? entry.name
      : '';
    const relPath = rawPath.trim();
    if (!relPath || path.isAbsolute(relPath)) {
      _log(`artifact skipped: invalid path "${rawPath}"`);
      continue;
    }

    const resolved = path.resolve(dirPath, relPath);
    const relative = path.relative(dirPath, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      _log(`artifact skipped: outside turn dir "${relPath}"`);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      _log(`artifact skipped: missing file "${relPath}"`);
      continue;
    }

    const realFile = fs.realpathSync(resolved);
    const realRelative = path.relative(realDir, realFile);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      _log(`artifact skipped: symlink outside turn dir "${relPath}"`);
      continue;
    }

    const stat = fs.statSync(realFile);
    if (!stat.isFile()) {
      _log(`artifact skipped: not a file "${relPath}"`);
      continue;
    }
    if (stat.size > ARTIFACT_MAX_BYTES) {
      _log(`artifact skipped: too large "${relPath}" (${stat.size} bytes)`);
      continue;
    }

    const filename = path.basename(realFile);
    const requestedKind = typeof entry?.kind === 'string' ? entry.kind.toLowerCase()
      : typeof entry?.type === 'string' ? entry.type.toLowerCase()
      : '';
    let kind: ArtifactKind = requestedKind === 'document' ? 'document'
      : requestedKind === 'photo' ? 'photo'
      : isPhotoFilename(filename) ? 'photo' : 'document';
    if (kind === 'photo' && !isPhotoFilename(filename)) kind = 'document';

    const caption = typeof entry?.caption === 'string' ? entry.caption.trim().slice(0, 1024) || undefined : undefined;
    artifacts.push({ filePath: realFile, filename, kind, caption });
  }

  return artifacts;
}

/**
 * Build the system-level artifact return instructions (for --append-system-prompt / developerInstructions).
 */
export function buildArtifactSystemPrompt(artifactDir: string, manifestPath: string): string {
  return [
    '[Telegram Artifact Return]',
    'If you create screenshots, images, logs, or other files that should be sent back to the Telegram user, write them only inside this directory:',
    artifactDir,
    '',
    `When you want a file returned, also write this JSON manifest: ${manifestPath}`,
    'Format:',
    '{"files":[{"path":"screenshot.png","kind":"photo","caption":"optional caption"}]}',
    'Rules:',
    '- Use relative paths in "path". Never use absolute paths.',
    '- Use "photo" for png/jpg/jpeg/webp images. Use "document" for everything else.',
    '- Omit the manifest entirely if there is nothing to send back.',
  ].join('\n');
}

/**
 * @deprecated Use buildArtifactSystemPrompt() for the system prompt path.
 * Kept for Codex resume (thread-level instructions are only set on thread/start,
 * so resumed threads need the fallback of appending to the user prompt).
 */
export function buildArtifactPrompt(prompt: string, artifactDir: string, manifestPath: string): string {
  const base = prompt.trim() || 'Please help with this request.';
  return base + '\n\n' + buildArtifactSystemPrompt(artifactDir, manifestPath);
}

function stripInjectedPrompts(text: string): string {
  const markers = ['\n[Telegram Artifact Return]', '\n[Artifact Return]'];
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx >= 0) return text.slice(0, idx).trim();
  }
  return text.trim();
}

function summarizePromptForStatus(prompt: string, maxLen = 50): string {
  const clean = stripInjectedPrompts(prompt).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(0, maxLen - 3)).trimEnd() + '...';
}

function trimActivityForPreview(text: string, maxChars = 900): string {
  if (text.length <= maxChars) return text;

  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length <= 1) return text.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...';

  const tailCount = Math.min(2, Math.max(1, lines.length - 1));
  const tail = lines.slice(-tailCount);
  const headCandidates = lines.slice(0, Math.max(0, lines.length - tailCount));
  const reserved = tail.join('\n').length + 5; // "\n...\n"
  const budget = Math.max(0, maxChars - reserved);
  const head: string[] = [];
  let used = 0;

  for (const line of headCandidates) {
    const extra = line.length + (head.length ? 1 : 0);
    if (used + extra > budget) break;
    head.push(line);
    used += extra;
  }

  if (!head.length) return text.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...';
  return [...head, '...', ...tail].join('\n');
}

function summarizeActivityForPreview(activity: string): string {
  const narrative: string[] = [];
  const failures: string[] = [];
  let activeCommands = 0;
  let completedCommands = 0;

  for (const rawLine of activity.split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (line.startsWith('$ ')) {
      activeCommands++;
      continue;
    }
    if (line.startsWith('Ran: ')) {
      completedCommands++;
      continue;
    }
    const executed = line.match(/^Executed (\d+) command(?:s)?\.$/);
    if (executed) {
      completedCommands = Math.max(completedCommands, parseInt(executed[1], 10) || 0);
      continue;
    }
    const running = line.match(/^Running (\d+) command(?:s)?\.\.\.$/);
    if (running) {
      activeCommands = Math.max(activeCommands, parseInt(running[1], 10) || 0);
      continue;
    }
    const failed = line.match(/^Command failed \((\d+)\):/);
    if (failed) {
      failures.push(`Command failed (${failed[1]})`);
      continue;
    }
    if (/^Command failed \(\d+\)$/.test(line)) {
      failures.push(line);
      continue;
    }
    narrative.push(line);
  }

  const lines = [
    ...narrative,
    ...failures,
  ];

  if (completedCommands > 0) {
    lines.push(completedCommands === 1 ? 'Executed 1 command.' : `Executed ${completedCommands} commands.`);
  }
  if (activeCommands > 0) {
    lines.push(activeCommands === 1 ? 'Running 1 command...' : `Running ${activeCommands} commands...`);
  }

  return lines.join('\n');
}

function humanizeUsageStatus(status: string | null | undefined): string {
  return (status || '').replace(/_/g, ' ').trim();
}

function usageRemainingSeconds(
  capturedAt: string | null,
  resetAfterSeconds: number | null,
): number | null {
  if (resetAfterSeconds == null) return null;
  const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
  if (Number.isFinite(capturedAtMs)) {
    return Math.round((capturedAtMs + resetAfterSeconds * 1000 - Date.now()) / 1000);
  }
  return resetAfterSeconds;
}

function formatProviderUsageLines(usage: {
  ok: boolean;
  capturedAt: string | null;
  status: string | null;
  windows: Array<{
    label: string;
    usedPercent: number | null;
    remainingPercent: number | null;
    resetAfterSeconds: number | null;
    status: string | null;
  }>;
  error: string | null;
}): string[] {
  const lines = ['', '<b>Provider Usage</b>'];

  if (!usage.ok) {
    lines.push(`  Unavailable: ${escapeHtml(usage.error || 'No recent usage data found.')}`);
    return lines;
  }

  if (usage.capturedAt) {
    const capturedAtMs = Date.parse(usage.capturedAt);
    if (Number.isFinite(capturedAtMs)) {
      lines.push(`  Updated: ${fmtUptime(Math.max(0, Date.now() - capturedAtMs))} ago`);
    }
  }

  if (!usage.windows.length) {
    const status = humanizeUsageStatus(usage.status);
    lines.push(`  ${escapeHtml(status || 'No window data')}`);
    return lines;
  }

  for (const window of usage.windows) {
    const parts: string[] = [];
    if (window.usedPercent != null && window.remainingPercent != null) {
      parts.push(`${window.usedPercent}% used / ${window.remainingPercent}% left`);
    } else if (window.usedPercent != null) {
      parts.push(`${window.usedPercent}% used`);
    }

    const status = humanizeUsageStatus(window.status);
    if (status) parts.push(status);

    const remainingSeconds = usageRemainingSeconds(usage.capturedAt, window.resetAfterSeconds);
    if (remainingSeconds != null) {
      parts.push(remainingSeconds > 0 ? `resets in ${fmtUptime(remainingSeconds * 1000)}` : 'reset passed');
    }

    lines.push(`  ${escapeHtml(window.label)}: ${escapeHtml(parts.join(' | ') || 'No details')}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Directory browser (Telegram callback_data 64-byte limit)
// ---------------------------------------------------------------------------

class PathRegistry {
  private pathToId = new Map<string, number>();
  private idToPath = new Map<number, string>();
  private nextId = 1;

  register(p: string): number {
    let id = this.pathToId.get(p);
    if (id != null) return id;
    id = this.nextId++;
    this.pathToId.set(p, id);
    this.idToPath.set(id, p);
    if (this.pathToId.size > 500) {
      const oldest = [...this.pathToId.entries()].slice(0, 200);
      for (const [k, v] of oldest) { this.pathToId.delete(k); this.idToPath.delete(v); }
    }
    return id;
  }

  resolve(id: number): string | undefined {
    return this.idToPath.get(id);
  }
}

const pathReg = new PathRegistry();
const DIR_PAGE_SIZE = 8;

function buildDirKeyboard(browsePath: string, page: number) {
  const dirs = listSubdirs(browsePath);
  const totalPages = Math.max(1, Math.ceil(dirs.length / DIR_PAGE_SIZE));
  const pg = Math.min(Math.max(0, page), totalPages - 1);
  const slice = dirs.slice(pg * DIR_PAGE_SIZE, (pg + 1) * DIR_PAGE_SIZE);

  const rows: { text: string; callback_data: string }[][] = [];

  for (let i = 0; i < slice.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];
    for (let j = i; j < Math.min(i + 2, slice.length); j++) {
      const full = path.join(browsePath, slice[j]);
      const id = pathReg.register(full);
      row.push({ text: slice[j], callback_data: `sw:n:${id}:0` });
    }
    rows.push(row);
  }

  const navRow: { text: string; callback_data: string }[] = [];
  const parent = path.dirname(browsePath);
  if (parent !== browsePath) {
    const pid = pathReg.register(parent);
    navRow.push({ text: '\u2B06 ..', callback_data: `sw:n:${pid}:0` });
  }
  if (totalPages > 1) {
    const bid = pathReg.register(browsePath);
    if (pg > 0) navRow.push({ text: `\u25C0 ${pg}/${totalPages}`, callback_data: `sw:n:${bid}:${pg - 1}` });
    if (pg < totalPages - 1) navRow.push({ text: `${pg + 2}/${totalPages} \u25B6`, callback_data: `sw:n:${bid}:${pg + 1}` });
  }
  if (navRow.length) rows.push(navRow);

  const selId = pathReg.register(browsePath);
  rows.push([{ text: '\u2705 Select this directory', callback_data: `sw:s:${selId}` }]);

  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// TelegramBot
// ---------------------------------------------------------------------------

export class TelegramBot extends Bot {
  private token: string;
  private channel!: TelegramChannel;

  constructor() {
    super();
    // merge Telegram-specific allowed IDs into base
    if (process.env.TELEGRAM_ALLOWED_CHAT_IDS) {
      for (const id of parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS)) this.allowedChatIds.add(id);
    }
    this.token = (process.env.TELEGRAM_BOT_TOKEN || process.env.CODECLAW_TOKEN || '').trim();
    if (!this.token) throw new Error('Missing token. Set CODECLAW_TOKEN or TELEGRAM_BOT_TOKEN');
  }

  /** Skill command prefix used in Telegram bot commands. */
  private static readonly SKILL_CMD_PREFIX = 'sk_';

  private static buildMenuCommands(agentCount: number, skills: SkillInfo[] = []) {
    const commands = [
      { command: 'sessions', description: 'List / switch sessions' },
    ];

    // Only show agents in normal position if there are multiple agents
    if (agentCount > 1) {
      commands.push({ command: 'agents', description: 'List / switch agents' });
    }

    commands.push(
      { command: 'switch', description: 'Switch working directory' },
      { command: 'models', description: 'List / switch models' },
      { command: 'status', description: 'Bot status' },
      { command: 'host', description: 'Host machine info' },
    );

    // If only one agent, put agents at the bottom
    if (agentCount === 1) {
      commands.push({ command: 'agents', description: 'List / switch agents' });
    }

    // Inject project-defined skills as sk_<name> commands
    for (const sk of skills) {
      // Telegram commands: 1-32 chars, lowercase letters/digits/underscore only
      const cmdName = `${TelegramBot.SKILL_CMD_PREFIX}${sk.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
      if (cmdName.length > 32) continue; // skip if too long for Telegram
      // Use short human-facing label; fall back to capitalized skill name
      const displayName = sk.label || sk.name.charAt(0).toUpperCase() + sk.name.slice(1);
      commands.push({ command: cmdName, description: `⚡ ${displayName}` });
    }

    commands.push({ command: 'restart', description: 'Restart with latest version' });

    return commands;
  }

  /** Register bot menu commands. Called automatically after connect. */
  async setupMenu() {
    const res = this.fetchAgents();
    const installedCount = res.agents.filter(a => a.installed).length;
    const skillRes = this.fetchSkills();
    const commands = TelegramBot.buildMenuCommands(installedCount, skillRes.skills);
    await this.channel.setMenu(commands);
    this.log(`menu: ${commands.length} commands (${skillRes.skills.length} skills)`);
  }

  // ---- commands -------------------------------------------------------------

  private async cmdStart(ctx: TgContext) {
    const cs = this.chat(ctx.chatId);
    const res = this.fetchAgents();
    const installedCount = res.agents.filter(a => a.installed).length;
    const skillRes = this.fetchSkills();
    const commands = TelegramBot.buildMenuCommands(installedCount, skillRes.skills);

    const lines = [`<b>codeclaw</b> v${VERSION}\n`];
    for (const cmd of commands) {
      lines.push(`/${cmd.command} \u2014 ${escapeHtml(cmd.description)}`);
    }
    lines.push(`\n<b>Agent:</b> ${escapeHtml(cs.agent)}  <b>Workdir:</b> <code>${escapeHtml(this.workdir)}</code>`);

    await ctx.reply(lines.join('\n'), { parseMode: 'HTML' });
  }

  private sessionsPageSize = 5;

  private async buildSessionsPage(chatId: number, page: number): Promise<{ text: string; keyboard: { inline_keyboard: { text: string; callback_data: string }[][] } }> {
    const cs = this.chat(chatId);
    const res = await this.fetchSessions(cs.agent);
    const sessions = res.ok ? res.sessions : [];
    const total = sessions.length;
    const totalPages = Math.max(1, Math.ceil(total / this.sessionsPageSize));
    const pg = Math.max(0, Math.min(page, totalPages - 1));
    const slice = sessions.slice(pg * this.sessionsPageSize, (pg + 1) * this.sessionsPageSize);

    const text = `<b>${escapeHtml(cs.agent)} sessions</b> (${total})  p${pg + 1}/${totalPages}`;
    const rows: { text: string; callback_data: string }[][] = [];

    for (const s of slice) {
      const isCurrent = s.sessionId === cs.sessionId;
      const icon = s.running ? '🟢' : isCurrent ? '● ' : '';
      const prefix = s.title ? s.title.replace(/\n/g, ' ').slice(0, 10) : s.sessionId.slice(0, 10);
      const time = s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?';

      let cbData = `sess:${s.sessionId}`;
      if (cbData.length > 64) cbData = cbData.slice(0, 64);
      rows.push([{ text: `${icon}${prefix}  ${time}`, callback_data: cbData }]);
    }

    const navRow: { text: string; callback_data: string }[] = [];
    if (pg > 0) navRow.push({ text: `◀ ${pg}/${totalPages}`, callback_data: `sp:${pg - 1}` });
    navRow.push({ text: '+ New', callback_data: 'sess:new' });
    if (pg < totalPages - 1) navRow.push({ text: `${pg + 2}/${totalPages} ▶`, callback_data: `sp:${pg + 1}` });
    rows.push(navRow);

    return { text, keyboard: { inline_keyboard: rows } };
  }

  private async cmdSessions(ctx: TgContext) {
    const cs = this.chat(ctx.chatId);
    const res = await this.fetchSessions(cs.agent);
    if (!res.ok) { await ctx.reply(`Error: ${res.error}`); return; }
    if (!res.sessions.length) { await ctx.reply(`No ${cs.agent} sessions found in:\n<code>${escapeHtml(this.workdir)}</code>`, { parseMode: 'HTML' }); return; }

    const { text, keyboard } = await this.buildSessionsPage(ctx.chatId, 0);
    await ctx.reply(text, { parseMode: 'HTML', keyboard });
  }

  private async cmdStatus(ctx: TgContext) {
    const d = this.getStatusData(ctx.chatId);

    // For codex, fetch real-time usage via WebSocket instead of stale DB data.
    const usage = d.agent === 'codex'
      ? await getCodexUsageLive().catch(() => d.usage)
      : d.usage;

    const lines = [
      `<b>codeclaw</b> v${d.version}\n`,
      `<b>Uptime:</b> ${fmtUptime(d.uptime)}`,
      `<b>Memory:</b> ${(d.memRss / 1024 / 1024).toFixed(0)}MB RSS / ${(d.memHeap / 1024 / 1024).toFixed(0)}MB heap`,
      `<b>PID:</b> ${d.pid}`,
      `<b>Workdir:</b> <code>${escapeHtml(d.workdir)}</code>`,
      '',
      `<b>Agent:</b> ${escapeHtml(d.agent)}`,
      `<b>Model:</b> ${escapeHtml(d.model)}`,
      `<b>Session:</b> ${d.sessionId ? `<code>${d.sessionId.slice(0, 16)}</code>` : '(new)'}`,
    ];
    if (d.running) {
      lines.push(`<b>Running:</b> ${fmtUptime(Date.now() - d.running.startedAt)} - ${escapeHtml(summarizePromptForStatus(d.running.prompt))}`);
    }
    lines.push(...formatProviderUsageLines(usage), '', '<b>Bot Usage</b>', `  Turns: ${d.stats.totalTurns}`);
    if (d.stats.totalInputTokens || d.stats.totalOutputTokens) {
      lines.push(`  In: ${fmtTokens(d.stats.totalInputTokens)}  Out: ${fmtTokens(d.stats.totalOutputTokens)}`);
      if (d.stats.totalCachedTokens) lines.push(`  Cached: ${fmtTokens(d.stats.totalCachedTokens)}`);
    }
    await ctx.reply(lines.join('\n'), { parseMode: 'HTML' });
  }

  private async cmdSwitch(ctx: TgContext) {
    const browsePath = path.dirname(this.workdir);
    const kb = buildDirKeyboard(browsePath, 0);
    await ctx.reply(
      `<b>Switch workdir</b>\nCurrent: <code>${escapeHtml(this.workdir)}</code>\n\nBrowsing: <code>${escapeHtml(browsePath)}</code>`,
      { parseMode: 'HTML', keyboard: kb },
    );
  }

  private async cmdHost(ctx: TgContext) {
    const d = this.getHostData();
    const lines = [
      `<b>Host</b>\n`,
      `<b>CPU:</b> ${escapeHtml(d.cpuModel)} x${d.cpuCount}`,
      `<b>Memory:</b> ${fmtBytes(d.totalMem - d.freeMem)} / ${fmtBytes(d.totalMem)} (${((1 - d.freeMem / d.totalMem) * 100).toFixed(0)}%)`,
    ];
    if (d.disk) lines.push(`<b>Disk:</b> ${escapeHtml(d.disk.used)} used / ${escapeHtml(d.disk.total)} total (${escapeHtml(d.disk.percent)})`);
    lines.push(`\n<b>Process:</b> PID ${d.selfPid} | RSS ${fmtBytes(d.selfRss)} | Heap ${fmtBytes(d.selfHeap)}`);
    if (d.topProcs.length > 1) {
      lines.push(`\n<b>Top Processes:</b>`);
      lines.push(`<pre>${d.topProcs.map(l => escapeHtml(l)).join('\n')}</pre>`);
    }
    await ctx.reply(lines.join('\n'), { parseMode: 'HTML' });
  }

  private async cmdAgents(ctx: TgContext) {
    const cs = this.chat(ctx.chatId);
    const res = this.fetchAgents();
    const lines = [`<b>Available Agents</b>\n`];
    const rows: { text: string; callback_data: string }[][] = [];
    for (const a of res.agents) {
      const isCurrent = a.agent === cs.agent;
      const status = !a.installed ? '\u274C' : isCurrent ? '\u25CF' : '\u25CB';
      lines.push(`${status} <b>${escapeHtml(a.agent)}</b>${isCurrent ? ' (current)' : ''}`);
      if (a.installed) {
        if (a.version) lines.push(`   Version: <code>${escapeHtml(a.version)}</code>`);
        if (a.path) lines.push(`   Path: <code>${escapeHtml(a.path)}</code>`);
        const label = isCurrent ? `\u25CF ${a.agent} (current)` : a.agent;
        rows.push([{ text: label, callback_data: `ag:${a.agent}` }]);
      } else {
        lines.push(`   Not installed`);
      }
    }
    await ctx.reply(lines.join('\n'), { parseMode: 'HTML', keyboard: { inline_keyboard: rows } });
  }

  private async cmdModels(ctx: TgContext) {
    const cs = this.chat(ctx.chatId);
    const res = await this.fetchModels(cs.agent);
    const currentModel = this.modelForAgent(cs.agent);
    const lines = [`<b>Models for ${escapeHtml(cs.agent)}</b>`];
    if (res.sources.length) lines.push(`<i>Source: ${escapeHtml(res.sources.join(', '))}</i>`);
    if (res.note) lines.push(`<i>${escapeHtml(res.note)}</i>`);
    lines.push('');
    const rows: { text: string; callback_data: string }[][] = [];
    if (!res.models.length) {
      lines.push('<i>No discoverable models found.</i>');
    }
    for (const m of res.models) {
      const isCurrent = modelMatchesSelection(cs.agent, m.id, currentModel);
      const status = isCurrent ? '\u25CF' : '\u25CB';
      const display = m.alias ? `${m.alias} (${m.id})` : m.id;
      const currentSuffix = isCurrent
        ? (m.id === currentModel ? ' \u2190 current' : ` \u2190 current (${escapeHtml(currentModel)})`)
        : '';
      lines.push(`${status} <code>${escapeHtml(display)}</code>${currentSuffix}`);
      const label = isCurrent ? `\u25CF ${m.alias || m.id}` : (m.alias || m.id);
      rows.push([{ text: label, callback_data: `mod:${m.id}` }]);
    }
    await ctx.reply(lines.join('\n'), { parseMode: 'HTML', keyboard: { inline_keyboard: rows } });
  }

  private async cmdRestart(ctx: TgContext) {
    const activeTasks = this.activeTasks.size;
    if (activeTasks > 0) {
      await ctx.reply(`⚠ ${activeTasks} task(s) still running. Wait for them to finish or try again.`, { parseMode: 'HTML' });
      return;
    }

    await ctx.reply(
      `<b>Restarting codeclaw...</b>\n\n` +
      `Pulling latest version via <code>npx --yes codeclaw@latest</code>.\n` +
      `The bot will be back shortly.`,
      { parseMode: 'HTML' },
    );

    this.performRestart();
  }

  /** Disconnect, spawn a new process, and exit. */
  private performRestart() {
    this.log('restart: disconnecting...');
    this.channel.disconnect();
    this.stopKeepAlive();

    const restartCmd = process.env.CODECLAW_RESTART_CMD || 'npx --yes codeclaw@latest';
    const [bin, ...rawArgs] = shellSplit(restartCmd);
    const baseArgs = ensureNonInteractiveRestartArgs(bin, rawArgs);
    const allArgs = [...baseArgs, ...process.argv.slice(2)];

    this.log(`restart: spawning \`${bin} ${allArgs.join(' ')}\``);
    // Collect all known chat IDs so the new process can send startup notices
    const knownIds = new Set(this.allowedChatIds);
    const knownChats = this.channel.knownChats instanceof Set ? this.channel.knownChats : new Set<number>();
    for (const cid of knownChats) knownIds.add(cid);

    const child = spawn(bin, allArgs, {
      stdio: 'inherit',
      detached: true,
      env: {
        ...process.env,
        npm_config_yes: process.env.npm_config_yes || 'true',
        ...(knownIds.size ? { TELEGRAM_ALLOWED_CHAT_IDS: [...knownIds].join(',') } : {}),
      },
    });
    child.unref();
    this.log(`restart: new process spawned (PID ${child.pid}), exiting...`);
    process.exit(0);
  }

  // ---- streaming bridge -----------------------------------------------------

  private async handleMessage(msg: TgMessage, ctx: TgContext) {
    const text = msg.text.trim();
    if (!text && !msg.files.length) return;

    const cs = this.chat(ctx.chatId);
    const artifactTurn = this.createArtifactTurn(ctx.chatId);
    const artifactSystemPrompt = buildArtifactSystemPrompt(artifactTurn.dir, artifactTurn.manifestPath);
    const basePrompt = buildPrompt(text, msg.files);
    // Codex: developerInstructions only takes effect on thread/start (new session).
    // For resumed Codex sessions, fall back to appending artifact instructions to the user prompt.
    const needsPromptFallback = cs.agent === 'codex' && !!cs.sessionId;
    const prompt = needsPromptFallback
      ? basePrompt + '\n\n' + artifactSystemPrompt
      : basePrompt;
    this.log(`[handleMessage] chat=${ctx.chatId} agent=${cs.agent} session=${cs.sessionId || '(new)'} prompt="${prompt.slice(0, 100)}" files=${msg.files.length}`);

    const phId = await ctx.reply(`<code>${escapeHtml(cs.agent)} | thinking ...</code>`, { parseMode: 'HTML' });
    if (!phId) { this.log(`[handleMessage] placeholder null for chat=${ctx.chatId}`); return; }
    this.log(`[handleMessage] placeholder sent msg_id=${phId}, starting agent stream...`);

    this.activeTasks.set(ctx.chatId, { prompt: basePrompt, startedAt: Date.now() });

    try {
      const start = Date.now();
      const streamEditIntervalMs = cs.agent === 'codex' ? 400 : 800;
      let lastEdit = 0, editCount = 0;
      let latestText = '', latestThinking = '', latestActivity = '';
      let lastPreview = '';
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let previewVersion = 0;
      let editChain: Promise<void> = Promise.resolve();

      const renderPreview = (text: string, thinking: string, activity: string) => {
        const display = text.trim();
        const thinkDisplay = thinking.trim();
        const activityDisplay = summarizeActivityForPreview(activity);
        if (!display && !thinkDisplay && !activityDisplay) return '';

        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        const maxBody = 2400;
        const maxActivity = 900;
        const parts: string[] = [];
        const tLabel = thinkLabel(cs.agent);

        if (activityDisplay) {
          const preview = trimActivityForPreview(activityDisplay, maxActivity);
          parts.push(`Activity\n${preview}`);
        }

        if (thinkDisplay && !display) {
          const preview = thinkDisplay.length > maxBody ? '...\n' + thinkDisplay.slice(-maxBody) : thinkDisplay;
          parts.push(`${tLabel}\n${preview}`);
        } else if (display) {
          if (thinkDisplay) parts.push(`${tLabel} (${thinkDisplay.length} chars)`);
          const preview = display.length > maxBody ? '(...truncated)\n' + display.slice(-maxBody) : display;
          parts.push(preview);
        }

        const dots = '\u00b7'.repeat((editCount % 3) + 1);
        parts.push(`${cs.agent} | ${elapsed}s ${dots}`);
        return parts.join('\n\n');
      };

      const queuePreviewEdit = (force = false) => {
        const preview = renderPreview(latestText, latestThinking, latestActivity);
        if (!preview) return;
        if (!force && preview === lastPreview) return;
        lastPreview = preview;
        const version = ++previewVersion;
        editCount++;
        lastEdit = Date.now();
        editChain = editChain
          .catch(() => {})
          .then(async () => {
            if (version !== previewVersion) return;
            try {
              await this.channel.editMessage(ctx.chatId, phId, preview);
            } catch (e: any) {
              this.log(`stream edit err: ${e?.message || e}`);
            }
          });
      };

      const schedulePreviewEdit = () => {
        const wait = streamEditIntervalMs - (Date.now() - lastEdit);
        if (wait <= 0) {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          queuePreviewEdit();
          return;
        }
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          queuePreviewEdit();
        }, wait);
      };

      const flushPreviewEdits = async () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        queuePreviewEdit(true);
        await editChain.catch(() => {});
      };

      const onText = (text: string, thinking: string, activity = '') => {
        latestText = text;
        latestThinking = thinking;
        latestActivity = activity;
        if (!text.trim() && !thinking.trim() && !activity.trim()) return;
        schedulePreviewEdit();
      };

      const result = await this.runStream(prompt, cs, msg.files, onText, needsPromptFallback ? undefined : artifactSystemPrompt);
      await flushPreviewEdits();
      const artifacts = this.collectArtifacts(artifactTurn.dir, artifactTurn.manifestPath);

      this.log(
        `[handleMessage] done agent=${cs.agent} ok=${result.ok} session=${result.sessionId || '?'} elapsed=${result.elapsedS.toFixed(1)}s edits=${editCount} ` +
        `tokens=in:${fmtTokens(result.inputTokens)}/cached:${fmtTokens(result.cachedInputTokens)}/out:${fmtTokens(result.outputTokens)} artifacts=${artifacts.length}`
      );
      this.log(`[handleMessage] response preview: "${result.message.slice(0, 150)}"`);

      // If artifacts were collected successfully, suppress the "incomplete" warning
      if (artifacts.length && result.incomplete && result.message.trim()) {
        result.incomplete = false;
        this.log(`[handleMessage] suppressed incomplete flag: artifacts present`);
      }

      // Combine photo + text into one message when text is short enough for caption
      const hasPhoto = artifacts.some(a => a.kind === 'photo');
      const msgText = result.message.trim();
      const canCombine = hasPhoto && msgText.length > 0 && msgText.length <= 1024;

      if (canCombine) {
        await this.channel.deleteMessage(ctx.chatId, phId);
        await this.sendArtifacts(ctx, ctx.messageId, artifacts, msgText);
      } else {
        const finalMsgId = await this.sendFinalReply(ctx, phId, cs.agent, result);
        await this.sendArtifacts(ctx, finalMsgId ?? phId, artifacts);
      }
      this.log(`[handleMessage] final reply sent to chat=${ctx.chatId} combined=${canCombine}`);
    } finally {
      this.activeTasks.delete(ctx.chatId);
      this.cleanupArtifactTurn(artifactTurn.dir);
    }
  }

  private createArtifactTurn(chatId: number) {
    const turnId = `${chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(ARTIFACT_ROOT, String(chatId), turnId);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, manifestPath: path.join(dir, ARTIFACT_MANIFEST) };
  }

  private cleanupArtifactTurn(dirPath: string) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }

  private collectArtifacts(dirPath: string, manifestPath: string): BotArtifact[] {
    return collectArtifacts(dirPath, manifestPath, msg => this.log(msg));
  }

  private async sendArtifacts(ctx: TgContext, replyTo: number, artifacts: BotArtifact[], textCaption?: string) {
    for (let i = 0; i < artifacts.length; i++) {
      const artifact = artifacts[i];
      // For the first photo artifact, use the text response as caption when provided
      const caption = (i === 0 && textCaption && artifact.kind === 'photo') ? textCaption : artifact.caption;
      try {
        await this.channel.sendFile(ctx.chatId, artifact.filePath, {
          caption,
          replyTo,
          asPhoto: artifact.kind === 'photo',
        });
      } catch (e) {
        this.log(`artifact upload failed for ${artifact.filename}: ${e}`);
        await this.channel.send(
          ctx.chatId,
          `Artifact upload failed: <code>${escapeHtml(artifact.filename)}</code>`,
          { parseMode: 'HTML', replyTo },
        ).catch(() => {});
      }
    }
  }

  private async sendFinalReply(ctx: TgContext, phId: number, agent: Agent, result: StreamResult): Promise<number | null> {
    const metaParts: string[] = [agent];
    if (result.model) metaParts.push(result.model);
    if (result.elapsedS != null) metaParts.push(`${result.elapsedS.toFixed(1)}s`);
    const meta = `<code>${metaParts.join(' \u00b7 ')}</code>`;

    let tokenBlock = '';
    if (result.inputTokens != null || result.outputTokens != null) {
      const tp: string[] = [];
      if (result.inputTokens != null) tp.push(`in: ${fmtTokens(result.inputTokens)}`);
      if (result.cachedInputTokens) tp.push(`cached: ${fmtTokens(result.cachedInputTokens)}`);
      if (result.outputTokens != null) tp.push(`out: ${fmtTokens(result.outputTokens)}`);
      // Context window usage percentage (input + cached + cacheCreation + output)
      if (result.contextPercent != null) {
        tp.push(`ctx: ${result.contextPercent}%`);
      }
      tokenBlock = `\n<blockquote expandable>${tp.join('  ')}</blockquote>`;
    }

    let thinkingHtml = '';
    if (result.thinking) {
      const label = thinkLabel(agent);
      let display = result.thinking;
      if (display.length > 800) display = '...\n' + display.slice(-800);
      thinkingHtml = `<blockquote><b>${label}</b>\n${escapeHtml(display)}</blockquote>\n\n`;
    }

    let statusHtml = '';
    if (result.incomplete) {
      const statusLines: string[] = [];
      if (result.stopReason === 'max_tokens') statusLines.push('Output limit reached. Response may be truncated.');
      if (!result.ok) {
        const detail = result.error?.trim();
        if (detail && detail !== result.message.trim()) statusLines.push(detail);
        else statusLines.push('Agent exited before reporting completion.');
      }
      statusHtml = `<blockquote expandable><b>Incomplete Response</b>\n${statusLines.map(escapeHtml).join('\n')}</blockquote>\n\n`;
    }

    const bodyHtml = mdToTgHtml(result.message);
    const fullHtml = `${statusHtml}${thinkingHtml}${bodyHtml}\n\n${meta}${tokenBlock}`;
    let finalMsgId: number | null = phId;

    if (fullHtml.length <= 3900) {
      try {
        await this.channel.editMessage(ctx.chatId, phId, fullHtml, { parseMode: 'HTML' });
      } catch {
        finalMsgId = await this.channel.send(ctx.chatId, fullHtml, { parseMode: 'HTML', replyTo: ctx.messageId });
      }
    } else {
      // Send full content as split plain-text messages instead of a file.
      // First message: edit placeholder with meta + thinking + beginning of body.
      const headerHtml = `${statusHtml}${thinkingHtml}`;
      const footerHtml = `\n\n${meta}${tokenBlock}`;
      const maxFirst = 3900 - headerHtml.length - footerHtml.length;
      let firstBody: string;
      let remaining: string;
      if (maxFirst > 200) {
        // find a newline-friendly cut in the HTML body
        let cut = bodyHtml.lastIndexOf('\n', maxFirst);
        if (cut < maxFirst * 0.3) cut = maxFirst;
        firstBody = bodyHtml.slice(0, cut);
        remaining = bodyHtml.slice(cut);
      } else {
        firstBody = '';
        remaining = bodyHtml;
      }
      const firstHtml = `${headerHtml}${firstBody}${footerHtml}`;
      try {
        await this.channel.editMessage(ctx.chatId, phId, firstHtml, { parseMode: 'HTML' });
      } catch {
        finalMsgId = await this.channel.send(ctx.chatId, firstHtml, { parseMode: 'HTML', replyTo: ctx.messageId });
      }

      // Send remaining body as continuation messages (split at ~3800 chars)
      if (remaining.trim()) {
        const chunks = splitText(remaining, 3800);
        for (const chunk of chunks) {
          await this.channel.send(ctx.chatId, chunk, { parseMode: 'HTML', replyTo: finalMsgId ?? phId });
        }
      }
    }
    return finalMsgId;
  }

  // ---- callbacks ------------------------------------------------------------

  async handleCallback(data: string, ctx: TgCallbackContext) {
    if (data.startsWith('sw:n:')) {
      const parts = data.slice(5).split(':');
      const browsePath = pathReg.resolve(parseInt(parts[0], 10));
      if (!browsePath) { await ctx.answerCallback('Expired, use /switch again'); return; }
      const page = parseInt(parts[1], 10) || 0;
      const kb = buildDirKeyboard(browsePath, page);
      await ctx.editReply(ctx.messageId,
        `<b>Switch workdir</b>\nCurrent: <code>${escapeHtml(this.workdir)}</code>\n\nBrowsing: <code>${escapeHtml(browsePath)}</code>`,
        { parseMode: 'HTML', keyboard: kb },
      );
      await ctx.answerCallback();
      return;
    }

    if (data.startsWith('sw:s:')) {
      const dirPath = pathReg.resolve(parseInt(data.slice(5), 10));
      if (!dirPath) { await ctx.answerCallback('Expired, use /switch again'); return; }
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        await ctx.answerCallback('Not a valid directory');
        return;
      }
      const oldPath = this.switchWorkdir(dirPath);
      await ctx.answerCallback(`Switched!`);
      await ctx.editReply(ctx.messageId,
        `<b>Workdir switched</b>\n\n<code>${escapeHtml(oldPath)}</code>\n\u2193\n<code>${escapeHtml(dirPath)}</code>`,
        { parseMode: 'HTML' },
      );
      return;
    }

    if (data.startsWith('sp:')) {
      const page = parseInt(data.slice(3), 10) || 0;
      const { text, keyboard } = await this.buildSessionsPage(ctx.chatId, page);
      await ctx.editReply(ctx.messageId, text, { parseMode: 'HTML', keyboard });
      await ctx.answerCallback('');
      return;
    }

    if (data.startsWith('sess:')) {
      const sessionId = data.slice(5);
      const cs = this.chat(ctx.chatId);
      if (sessionId === 'new') {
        cs.sessionId = null;
        await ctx.answerCallback('New session');
        await ctx.editReply(ctx.messageId, 'Session reset. Send a message to start.', {});
      } else {
        cs.sessionId = sessionId;
        await ctx.answerCallback(`Session: ${sessionId.slice(0, 12)}`);

        await ctx.editReply(ctx.messageId,
          `Switched to session: <code>${escapeHtml(sessionId.slice(0, 16))}</code>`,
          { parseMode: 'HTML' },
        );

        // Send the last full turn as a separate message (auto-splits if too long)
        try {
          const tail = await this.fetchSessionTail(cs.agent, sessionId, 50);
          if (tail.ok && tail.messages.length) {
            // Find the last user message index, then collect ALL assistant messages after it
            const msgs = tail.messages;
            let lastUserIdx = -1;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'user') { lastUserIdx = i; break; }
            }
            const parts: string[] = [];
            if (lastUserIdx >= 0) {
              parts.push(`<b>You:</b>\n${escapeHtml(msgs[lastUserIdx].text)}`);
            }
            // Gather all assistant messages after the last user message
            const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
            const assistantTexts: string[] = [];
            for (let i = startIdx; i < msgs.length; i++) {
              if (msgs[i].role === 'assistant' && msgs[i].text) {
                assistantTexts.push(msgs[i].text);
              }
            }
            if (assistantTexts.length) {
              parts.push(`<b>${escapeHtml(cs.agent)}:</b>\n${escapeHtml(assistantTexts.join('\n\n'))}`);
            }
            if (parts.length) {
              await ctx.reply(parts.join('\n\n'), { parseMode: 'HTML' });
            }
          }
        } catch { /* non-critical */ }
      }
      return;
    }

    if (data.startsWith('ag:')) {
      const agent = data.slice(3) as Agent;
      const cs = this.chat(ctx.chatId);
      if (cs.agent === agent) {
        await ctx.answerCallback(`Already using ${agent}`);
        return;
      }
      cs.agent = agent;
      cs.sessionId = null;
      this.log(`agent switched to ${agent} chat=${ctx.chatId}`);
      await ctx.answerCallback(`Switched to ${agent}`);
      await ctx.editReply(ctx.messageId,
        `<b>Switched to ${escapeHtml(agent)}</b>\n\nSession has been reset. Previous conversation history will not carry over.\nSend a message to start a new conversation.`,
        { parseMode: 'HTML' },
      );
      return;
    }

    if (data.startsWith('mod:')) {
      const modelId = data.slice(4);
      const cs = this.chat(ctx.chatId);
      const currentModel = this.modelForAgent(cs.agent);
      if (currentModel === modelId) {
        await ctx.answerCallback(`Already using ${modelId}`);
        return;
      }
      this.setModelForAgent(cs.agent, modelId);
      cs.sessionId = null;
      this.log(`model switched to ${modelId} for ${cs.agent} chat=${ctx.chatId}`);
      await ctx.answerCallback(`Switched to ${modelId}`);
      await ctx.editReply(ctx.messageId,
        `<b>Model switched to <code>${escapeHtml(modelId)}</code></b>\n\nAgent: ${escapeHtml(cs.agent)}\nSession has been reset. Send a message to start a new conversation.`,
        { parseMode: 'HTML' },
      );
      return;
    }

    await ctx.answerCallback();
  }

  // ---- command router -------------------------------------------------------

  async handleCommand(cmd: string, args: string, ctx: TgContext) {
    try {
      switch (cmd) {
        case 'start':    await this.cmdStart(ctx); return;
        case 'sessions': await this.cmdSessions(ctx); return;
        case 'agents':   await this.cmdAgents(ctx); return;
        case 'models':   await this.cmdModels(ctx); return;
        case 'status':   await this.cmdStatus(ctx); return;
        case 'host':     await this.cmdHost(ctx); return;
        case 'switch':   await this.cmdSwitch(ctx); return;
        case 'restart':  await this.cmdRestart(ctx); return;
        default:
          // Intercept skill commands (sk_<name>) and route to agent
          if (cmd.startsWith(TelegramBot.SKILL_CMD_PREFIX)) {
            await this.cmdSkill(cmd, args, ctx);
            return;
          }
          await this.handleMessage({ text: `/${cmd}${args ? ' ' + args : ''}`, files: [] }, ctx);
      }
    } catch (e: any) {
      this.log(`cmd error: ${e}`);
      await ctx.reply(`Error: ${String(e).slice(0, 200)}`);
    }
  }

  /** Execute a project-defined skill by routing it to the current agent. */
  private async cmdSkill(cmd: string, args: string, ctx: TgContext) {
    const skillName = cmd.slice(TelegramBot.SKILL_CMD_PREFIX.length);
    const cs = this.chat(ctx.chatId);
    const extra = args.trim() ? ` ${args.trim()}` : '';

    this.log(`skill: ${skillName} agent=${cs.agent}${extra ? ` args="${extra.trim()}"` : ''}`);

    let prompt: string;
    if (cs.agent === 'claude') {
      prompt = `Please execute the /${skillName} skill defined in this project.${extra ? ` Additional context: ${extra.trim()}` : ''}`;
    } else {
      // codex — no native skill system, describe semantically
      prompt = `In this project's .claude/skills/${skillName}/ directory (or .claude/commands/${skillName}.md), there is a custom skill definition. Please read and execute the instructions defined in that skill file.${extra ? ` Additional context: ${extra.trim()}` : ''}`;
    }

    await this.handleMessage({ text: prompt, files: [] }, ctx);
  }

  // ---- lifecycle ------------------------------------------------------------

  async run() {
    const tmpDir = path.join(os.tmpdir(), 'codeclaw');
    fs.mkdirSync(tmpDir, { recursive: true });

    this.channel = new TelegramChannel({
      token: this.token,
      workdir: tmpDir,
      allowedChatIds: this.allowedChatIds.size ? this.allowedChatIds : undefined,
    });

    const shutdown = (sig: string) => {
      this.log(`${sig}, shutting down...`);
      this.channel.disconnect();
      this.stopKeepAlive();
      shutdownCodexServer();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGUSR2', () => { this.log('SIGUSR2 received, restarting...'); this.performRestart(); });

    const bot = await this.channel.connect();
    this.log(`bot: @${bot.username} (id=${bot.id})`);

    const drained = await this.channel.drain();
    if (drained) this.log(`drained ${drained} pending update(s)`);

    // Seed knownChats so setupMenu applies per-chat commands
    for (const cid of this.allowedChatIds) this.channel.knownChats.add(cid);

    await this.setupMenu();

    for (const ag of ['claude', 'codex'] as const) {
      this.log(`agent ${ag}: ${whichSync(ag) || 'NOT FOUND'}`);
    }
    this.log(`config: agent=${this.defaultAgent} workdir=${this.workdir} timeout=${this.runTimeout}s`);

    this.channel.onCommand((cmd, args, ctx) => this.handleCommand(cmd, args, ctx));
    this.channel.onMessage((msg, ctx) => this.handleMessage(msg, ctx));
    this.channel.onCallback((data, ctx) => this.handleCallback(data, ctx));
    this.channel.onError(err => this.log(`error: ${err}`));

    await this.sendStartupNotice();

    this.startKeepAlive();
    this.log('polling started');
    await this.channel.listen();
    this.stopKeepAlive();
    this.log('stopped');
  }

  private async sendStartupNotice() {
    const targets = new Set(this.allowedChatIds);
    for (const cid of this.channel.knownChats) targets.add(cid);
    if (!targets.size) {
      this.log('no known chats for startup notice');
      return;
    }

    const agents = ['claude', 'codex'].filter(e => whichSync(e));
    const text =
      `<b>codeclaw</b> v${VERSION} online\n\n` +
      `<b>Agent:</b> ${escapeHtml(this.defaultAgent)}\n` +
      `<b>Available:</b> ${escapeHtml(agents.join(', ') || 'none')}\n` +
      `<b>Workdir:</b> <code>${escapeHtml(this.workdir)}</code>\n\n` +
      `<i>/help for commands</i>`;

    for (const cid of targets) {
      try {
        await this.channel.send(cid, text, { parseMode: 'HTML' });
        this.log(`startup notice sent to chat=${cid}`);
      } catch (e) {
        this.log(`startup notice failed for chat=${cid}: ${e}`);
      }
    }
  }
}
