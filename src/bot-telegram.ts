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
  thinkLabel, parseAllowedChatIds, shellSplit,
} from './bot.js';
import { TelegramChannel, type TgContext, type TgCallbackContext, type TgMessage } from './channel-telegram.js';

// ---------------------------------------------------------------------------
// Telegram HTML formatting
// ---------------------------------------------------------------------------

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function detectQuickReplies(text: string): string[] {
  const last = text.trim().split('\n').slice(-15).join('\n');
  if (/\?\s*$/.test(last) && /(?:should I|do you want|shall I|would you like|proceed|continue\?)/i.test(last))
    return ['Yes', 'No'];
  const numbered = [...last.matchAll(/^\s*(\d+)[.)]\s+(.{3,60})$/gm)];
  if (numbered.length >= 2 && numbered.length <= 6) return numbered.map(m => `${m[1]}. ${m[2].trim().slice(0, 30)}`);
  return [];
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
  private replyCache = new Map<number, { chatId: number; quickReplies: string[] }>();

  constructor() {
    super();
    // merge Telegram-specific allowed IDs into base
    if (process.env.TELEGRAM_ALLOWED_CHAT_IDS) {
      for (const id of parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS)) this.allowedChatIds.add(id);
    }
    this.token = (process.env.TELEGRAM_BOT_TOKEN || process.env.CODECLAW_TOKEN || '').trim();
    if (!this.token) throw new Error('Missing token. Set CODECLAW_TOKEN or TELEGRAM_BOT_TOKEN');
  }

  private static readonly MENU_COMMANDS = [
    { command: 'sessions', description: 'List / switch sessions' },
    { command: 'agents', description: 'List / switch agents' },
    { command: 'status', description: 'Bot status' },
    { command: 'host', description: 'Host machine info' },
    { command: 'switch', description: 'Switch working directory' },
    { command: 'restart', description: 'Restart with latest version' },
  ];

  /** Register bot menu commands. Called automatically after connect. */
  async setupMenu() {
    await this.channel.setMenu(TelegramBot.MENU_COMMANDS);
  }

  // ---- commands -------------------------------------------------------------

  private async cmdStart(ctx: TgContext) {
    const cs = this.chat(ctx.chatId);
    await ctx.reply(
      `<b>codeclaw</b> v${VERSION}\n\n` +
      `/sessions \u2014 List / switch sessions\n` +
      `/agents \u2014 List / switch agents\n` +
      `/status \u2014 Bot status\n` +
      `/host \u2014 Host machine info\n` +
      `/switch \u2014 Switch working directory\n` +
      `/restart \u2014 Restart with latest version\n` +
      `\n<b>Agent:</b> ${escapeHtml(cs.agent)}  <b>Workdir:</b> <code>${escapeHtml(this.workdir)}</code>`,
      { parseMode: 'HTML' },
    );
  }

  private sessionsPageSize = 5;

  private buildSessionsPage(chatId: number, page: number): { text: string; keyboard: { inline_keyboard: { text: string; callback_data: string }[][] } } {
    const cs = this.chat(chatId);
    const res = this.fetchSessions(cs.agent);
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
    const res = this.fetchSessions(cs.agent);
    if (!res.ok) { await ctx.reply(`Error: ${res.error}`); return; }
    if (!res.sessions.length) { await ctx.reply(`No ${cs.agent} sessions found in:\n<code>${escapeHtml(this.workdir)}</code>`, { parseMode: 'HTML' }); return; }

    const { text, keyboard } = this.buildSessionsPage(ctx.chatId, 0);
    await ctx.reply(text, { parseMode: 'HTML', keyboard });
  }

  private async cmdStatus(ctx: TgContext) {
    const d = this.getStatusData(ctx.chatId);
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
      lines.push(`<b>Running:</b> ${fmtUptime(Date.now() - d.running.startedAt)} - ${escapeHtml(d.running.prompt.slice(0, 50))}`);
    }
    lines.push('', '<b>Usage</b>', `  Turns: ${d.stats.totalTurns}`);
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

  private async cmdRestart(ctx: TgContext) {
    const activeTasks = this.activeTasks.size;
    if (activeTasks > 0) {
      await ctx.reply(`⚠ ${activeTasks} task(s) still running. Wait for them to finish or try again.`, { parseMode: 'HTML' });
      return;
    }

    await ctx.reply(
      `<b>Restarting codeclaw...</b>\n\n` +
      `Pulling latest version via <code>npx codeclaw@latest</code>.\n` +
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

    const restartCmd = process.env.CODECLAW_RESTART_CMD || 'npx codeclaw@latest';
    const [bin, ...baseArgs] = shellSplit(restartCmd);
    const allArgs = [...baseArgs, ...process.argv.slice(2)];

    this.log(`restart: spawning \`${bin} ${allArgs.join(' ')}\``);
    const child = spawn(bin, allArgs, {
      stdio: 'inherit',
      detached: true,
      env: process.env,
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
    const prompt = buildPrompt(text, msg.files);
    this.log(`[handleMessage] chat=${ctx.chatId} agent=${cs.agent} session=${cs.sessionId || '(new)'} prompt="${prompt.slice(0, 100)}" files=${msg.files.length}`);

    const phId = await ctx.reply(`<code>${escapeHtml(cs.agent)} | thinking ...</code>`, { parseMode: 'HTML' });
    if (!phId) { this.log(`[handleMessage] placeholder null for chat=${ctx.chatId}`); return; }
    this.log(`[handleMessage] placeholder sent msg_id=${phId}, starting agent stream...`);

    this.activeTasks.set(ctx.chatId, { prompt, startedAt: Date.now() });

    try {
      const start = Date.now();
      let lastEdit = 0, editCount = 0, editPending = false;

      const onText = (text: string, thinking: string) => {
        const now = Date.now();
        if ((now - lastEdit) < 1000 || editPending) return;
        const display = text.trim(), thinkDisplay = thinking.trim();
        if (!display && !thinkDisplay) return;

        const elapsed = ((now - start) / 1000).toFixed(0);
        const maxBody = 3200;
        const parts: string[] = [];
        const tLabel = thinkLabel(cs.agent);

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

        editPending = true;
        this.channel.editMessage(ctx.chatId, phId, parts.join('\n\n'))
          .catch(e => this.log(`stream edit err: ${e}`))
          .finally(() => { editPending = false; });
        lastEdit = now;
        editCount++;
      };

      const result = await this.runStream(prompt, cs, msg.files, onText);

      this.log(
        `[handleMessage] done agent=${cs.agent} ok=${result.ok} session=${result.sessionId || '?'} elapsed=${result.elapsedS.toFixed(1)}s edits=${editCount} ` +
        `tokens=in:${fmtTokens(result.inputTokens)}/cached:${fmtTokens(result.cachedInputTokens)}/out:${fmtTokens(result.outputTokens)}`
      );
      this.log(`[handleMessage] response preview: "${result.message.slice(0, 150)}"`);

      await this.sendFinalReply(ctx, phId, cs.agent, result);
      this.log(`[handleMessage] final reply sent to chat=${ctx.chatId}`);
    } finally {
      this.activeTasks.delete(ctx.chatId);
    }
  }

  private async sendFinalReply(ctx: TgContext, phId: number, agent: Agent, result: StreamResult) {
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
      tokenBlock = `\n<blockquote expandable>${tp.join('  ')}</blockquote>`;
    }

    const quickReplies = result.incomplete ? [] : detectQuickReplies(result.message);
    let keyboard: any = undefined;
    if (quickReplies.length) {
      const rows: { text: string; callback_data: string }[][] = [];
      let row: { text: string; callback_data: string }[] = [];
      for (let i = 0; i < quickReplies.length; i++) {
        let cbData = `qr:${phId}:${i}`;
        if (cbData.length > 64) cbData = cbData.slice(0, 64);
        row.push({ text: quickReplies[i].slice(0, 32), callback_data: cbData });
        if (row.length >= 3) { rows.push(row); row = []; }
      }
      if (row.length) rows.push(row);
      keyboard = { inline_keyboard: rows };
      this.replyCache.set(phId, { chatId: ctx.chatId, quickReplies });
      if (this.replyCache.size > 100) {
        for (const k of [...this.replyCache.keys()].slice(0, this.replyCache.size - 100)) this.replyCache.delete(k);
      }
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

    if (fullHtml.length <= 3900) {
      try {
        await this.channel.editMessage(ctx.chatId, phId, fullHtml, { parseMode: 'HTML', keyboard });
      } catch {
        await this.channel.send(ctx.chatId, fullHtml, { parseMode: 'HTML', replyTo: ctx.messageId, keyboard });
      }
    } else {
      let preview = bodyHtml.slice(0, 3200);
      if (bodyHtml.length > 3200) preview += '\n<i>... (see full response below)</i>';
      const previewHtml = `${statusHtml}${thinkingHtml}${preview}\n\n${meta}${tokenBlock}`;
      try {
        await this.channel.editMessage(ctx.chatId, phId, previewHtml, { parseMode: 'HTML', keyboard });
      } catch {
        await this.channel.send(ctx.chatId, previewHtml, { parseMode: 'HTML', replyTo: ctx.messageId, keyboard });
      }

      const thinkingMd = result.thinking
        ? `> **${thinkLabel(agent)}**\n${result.thinking.split('\n').map(l => `> ${l}`).join('\n')}\n\n---\n\n`
        : '';
      await this.channel.sendDocument(
        ctx.chatId, thinkingMd + result.message,
        `response_${phId}.md`,
        { caption: `Full response (${result.message.length} chars)`, replyTo: phId },
      );
    }
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
      const { text, keyboard } = this.buildSessionsPage(ctx.chatId, page);
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

    if (data.startsWith('qr:')) {
      const parts = data.split(':');
      if (parts.length === 3) {
        const cacheId = parseInt(parts[1], 10);
        const idx = parseInt(parts[2], 10);
        const entry = this.replyCache.get(cacheId);
        const replyText = entry?.quickReplies?.[idx] ?? `Option ${idx + 1}`;
        await ctx.answerCallback(`Sending: ${replyText.slice(0, 40)}`);
        const fakeMsg: TgMessage = { text: replyText, files: [] };
        await this.handleMessage(fakeMsg, ctx);
      }
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
        case 'status':   await this.cmdStatus(ctx); return;
        case 'host':     await this.cmdHost(ctx); return;
        case 'switch':   await this.cmdSwitch(ctx); return;
        case 'restart':  await this.cmdRestart(ctx); return;
        default:
          await this.handleMessage({ text: `/${cmd}${args ? ' ' + args : ''}`, files: [] }, ctx);
      }
    } catch (e: any) {
      this.log(`cmd error: ${e}`);
      await ctx.reply(`Error: ${String(e).slice(0, 200)}`);
    }
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
