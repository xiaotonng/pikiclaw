/**
 * bot-telegram.ts - Telegram bot orchestration: commands, callbacks, artifacts, lifecycle.
 *
 * Rendering, workdir browsing, and live preview state live in dedicated helper modules.
 * For a new IM (Lark, WhatsApp, ...), create a parallel bot-lark.ts / bot-whatsapp.ts
 * that extends Bot and composes channel-specific renderer/view helpers.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  Bot, VERSION, type Agent, type SessionRuntime, type StreamResult,
  fmtTokens, fmtUptime, fmtBytes, buildPrompt,
  parseAllowedChatIds, shellSplit,
} from './bot.js';
import {
  type BotArtifact,
  stageSessionFiles,
} from './code-agent.js';
import { shutdownAllDrivers } from './agent-driver.js';
import {
  buildDefaultMenuCommands,
  buildWelcomeIntro,
  SKILL_CMD_PREFIX,
} from './bot-menu.js';
import {
  getStartData,
  getSessionsPageData,
  getAgentsListData,
  getModelsListData,
  getStatusDataAsync,
  getHostDataSync,
  modelMatchesSelection,
  resolveSkillPrompt,
  summarizePromptForStatus,
} from './bot-commands.js';
import { buildSwitchWorkdirView, resolveRegisteredPath } from './bot-telegram-directory.js';
import { LivePreview, type LivePreviewRenderer } from './bot-telegram-live-preview.js';
import {
  buildInitialPreviewHtml,
  buildStreamPreviewHtml,
  buildFinalReplyRender,
  escapeHtml,
  formatMenuLines,
  formatProviderUsageLines,
  renderSessionTurnHtml,
} from './bot-telegram-render.js';
import { TelegramChannel, type TgContext, type TgCallbackContext, type TgMessage } from './channel-telegram.js';
import { splitText, supportsChannelCapability } from './channel-base.js';
import { getActiveUserConfig } from './user-config.js';

export { buildArtifactPrompt, buildArtifactSystemPrompt, collectArtifacts } from './code-agent.js';

/** Telegram HTML renderer for LivePreview. */
const telegramPreviewRenderer: LivePreviewRenderer = {
  renderInitial: buildInitialPreviewHtml,
  renderStream: buildStreamPreviewHtml,
};

function isNpxBinary(bin: string): boolean {
  return path.basename(bin, path.extname(bin)).toLowerCase() === 'npx';
}

function ensureNonInteractiveRestartArgs(bin: string, args: string[]): string[] {
  if (!isNpxBinary(bin)) return args;
  if (args.includes('--yes') || args.includes('-y')) return args;
  return ['--yes', ...args];
}

type ShutdownSignal = 'SIGINT' | 'SIGTERM';
type ProcessSignal = ShutdownSignal | 'SIGUSR2';

const SHUTDOWN_EXIT_CODE: Record<ShutdownSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};
const SHUTDOWN_FORCE_EXIT_MS = 3_000;

// ---------------------------------------------------------------------------
// TelegramBot
// ---------------------------------------------------------------------------

export class TelegramBot extends Bot {
  private token: string;
  private channel!: TelegramChannel;
  private sessionMessages = new Map<number, Map<number, string>>();
  private nextTaskId = 1;
  private shutdownInFlight = false;
  private shutdownExitCode: number | null = null;
  private shutdownForceExitTimer: ReturnType<typeof setTimeout> | null = null;
  private signalHandlers: Partial<Record<ProcessSignal, () => void>> = {};

  constructor() {
    super();
    const config = getActiveUserConfig();
    // merge Telegram-specific allowed IDs into base
    if (config.telegramAllowedChatIds) {
      for (const id of parseAllowedChatIds(config.telegramAllowedChatIds)) this.allowedChatIds.add(id);
    }
    this.token = String(config.telegramBotToken || '').trim();
    if (!this.token) throw new Error('Missing Telegram token. Configure via dashboard or set TELEGRAM_BOT_TOKEN');
  }

  protected override onManagedConfigChange(config: Record<string, any>, opts: { initial?: boolean } = {}) {
    const nextToken = String(config.telegramBotToken || '').trim();
    if (nextToken && nextToken !== this.token) {
      this.token = nextToken;
      if (!opts.initial) this.log('telegram token reloaded from setting.json');
    }

    const mergedAllowed = parseAllowedChatIds(process.env.CODECLAW_ALLOWED_IDS || '');
    for (const id of parseAllowedChatIds(String(config.telegramAllowedChatIds || ''))) mergedAllowed.add(id);
    this.allowedChatIds = mergedAllowed;
  }

  /** Skill command prefix used in Telegram bot commands. */
  private static readonly SKILL_CMD_PREFIX = SKILL_CMD_PREFIX;

  /** Register bot menu commands. Called automatically after connect. */
  async setupMenu() {
    if (!supportsChannelCapability((this as any).channel, 'commandMenu')) return;
    const { commands, skillCount } = this.getCurrentMenuState();
    await this.channel.setMenu(commands);
    this.log(`menu: ${commands.length} commands (${skillCount} skills)`);
  }

  protected override afterSwitchWorkdir(_oldPath: string, _newPath: string) {
    this.sessionMessages.clear();
    if (!(this as any).channel) return;
    void this.setupMenu().catch(err => this.log(`menu refresh failed after workdir switch: ${err}`));
  }

  private clearShutdownForceExitTimer() {
    if (!this.shutdownForceExitTimer) return;
    clearTimeout(this.shutdownForceExitTimer);
    this.shutdownForceExitTimer = null;
  }

  private removeSignalHandlers() {
    for (const sig of Object.keys(this.signalHandlers) as ProcessSignal[]) {
      const handler = this.signalHandlers[sig];
      if (handler) process.off(sig, handler);
    }
    this.signalHandlers = {};
  }

  private installSignalHandlers() {
    this.removeSignalHandlers();

    const onSigint = () => this.beginShutdown('SIGINT');
    const onSigterm = () => this.beginShutdown('SIGTERM');
    const onSigusr2 = () => {
      if (this.shutdownInFlight) return;
      this.log('SIGUSR2 received, restarting...');
      this.performRestart();
    };

    this.signalHandlers = {
      SIGINT: onSigint,
      SIGTERM: onSigterm,
      SIGUSR2: onSigusr2,
    };

    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.on('SIGUSR2', onSigusr2);
  }

  private beginShutdown(sig: ShutdownSignal) {
    if (this.shutdownInFlight) return;

    this.shutdownInFlight = true;
    this.shutdownExitCode = SHUTDOWN_EXIT_CODE[sig];
    this.log(`${sig}, shutting down...`);

    try { this.channel.disconnect(); } catch {}
    this.stopKeepAlive();
    shutdownAllDrivers();

    this.clearShutdownForceExitTimer();
    this.shutdownForceExitTimer = setTimeout(() => {
      this.log(`shutdown still pending after ${Math.floor(SHUTDOWN_FORCE_EXIT_MS / 1000)}s, forcing exit`);
      process.exit(this.shutdownExitCode ?? 1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    this.shutdownForceExitTimer.unref?.();
  }

  private getCurrentMenuState() {
    const res = this.fetchAgents();
    const installedCount = res.agents.filter(a => a.installed).length;
    const skillRes = this.fetchSkills();
    const commands = buildDefaultMenuCommands(installedCount, skillRes.skills);
    return { commands, skillCount: skillRes.skills.length, skills: skillRes.skills };
  }

  private welcomeIntroLines(): string[] {
    const intro = buildWelcomeIntro(VERSION);
    return [
      `<b>${escapeHtml(intro.title)}</b> v${escapeHtml(intro.version)}`,
      escapeHtml(intro.subtitle),
    ];
  }

  private createTaskId(session: SessionRuntime): string {
    const seq = this.nextTaskId++;
    return `${session.key}:${Date.now().toString(36)}:${seq.toString(36)}`;
  }

  private registerSessionMessage(chatId: number, messageId: number | null | undefined, session: SessionRuntime) {
    if (session.workdir !== this.workdir) return;
    if (typeof messageId !== 'number' || !Number.isFinite(messageId)) return;
    let messages = this.sessionMessages.get(chatId);
    if (!messages) {
      messages = new Map<number, string>();
      this.sessionMessages.set(chatId, messages);
    }
    messages.set(messageId, session.key);
    while (messages.size > 1024) {
      const oldest = messages.keys().next();
      if (oldest.done) break;
      messages.delete(oldest.value);
    }
  }

  private registerSessionMessages(chatId: number, messageIds: Array<number | null | undefined>, session: SessionRuntime) {
    for (const messageId of messageIds) this.registerSessionMessage(chatId, messageId, session);
  }

  private sessionFromMessage(chatId: number, messageId: number | null | undefined): SessionRuntime | null {
    if (typeof messageId !== 'number' || !Number.isFinite(messageId)) return null;
    const sessionKey = this.sessionMessages.get(chatId)?.get(messageId) || null;
    return this.getSessionRuntimeByKey(sessionKey);
  }

  private ensureSession(chatId: number, title: string, files: string[]): SessionRuntime {
    const cs = this.chat(chatId);
    const selected = this.getSelectedSession(cs);
    if (selected) return selected;

    const staged = stageSessionFiles({
      agent: cs.agent,
      workdir: this.workdir,
      files: [],
      localSessionId: null,
      sessionId: null,
      title: title || files[0] || 'New session',
    });
    const runtime = this.upsertSessionRuntime({
      agent: cs.agent,
      localSessionId: staged.localSessionId,
      workspacePath: staged.workspacePath,
      modelId: this.modelForAgent(cs.agent),
    });
    this.applySessionSelection(cs, runtime);
    return runtime;
  }

  private resolveIncomingSession(ctx: TgContext, text: string, files: string[]): SessionRuntime {
    const cs = this.chat(ctx.chatId);
    const replyMessageId = typeof ctx.raw?.reply_to_message?.message_id === 'number'
      ? ctx.raw.reply_to_message.message_id
      : null;
    const repliedSession = this.sessionFromMessage(ctx.chatId, replyMessageId);
    if (repliedSession) {
      this.applySessionSelection(cs, repliedSession);
      return repliedSession;
    }

    const selected = this.getSelectedSession(cs);
    if (selected) return selected;
    return this.ensureSession(ctx.chatId, text, files);
  }

  // ---- commands -------------------------------------------------------------

  private async cmdStart(ctx: TgContext) {
    const d = getStartData(this, ctx.chatId);
    const lines = [
      `<b>${escapeHtml(d.title)}</b> v${escapeHtml(d.version)}`,
      escapeHtml(d.subtitle),
      '',
      `<b>Agent:</b> ${escapeHtml(d.agent)}`,
      `<b>Workdir:</b> <code>${escapeHtml(d.workdir)}</code>`,
      '',
      '<b>Commands</b>',
      ...formatMenuLines(d.commands),
    ];
    await ctx.reply(lines.join('\n'), { parseMode: 'HTML' });
  }

  private sessionsPageSize = 5;

  private async buildSessionsPage(chatId: number, page: number): Promise<{ text: string; keyboard: { inline_keyboard: { text: string; callback_data: string }[][] } }> {
    const d = await getSessionsPageData(this, chatId, page, this.sessionsPageSize);
    const text = `<b>${escapeHtml(d.agent)} sessions</b> (${d.total})  p${d.page + 1}/${d.totalPages}`;
    const rows: { text: string; callback_data: string }[][] = [];

    for (const s of d.sessions) {
      const icon = s.isRunning ? '🟢' : s.isCurrent ? '● ' : '';
      let cbData = `sess:${s.key}`;
      if (cbData.length > 64) cbData = cbData.slice(0, 64);
      rows.push([{ text: `${icon}${s.title}  ${s.time}`, callback_data: cbData }]);
    }

    const navRow: { text: string; callback_data: string }[] = [];
    if (d.page > 0) navRow.push({ text: `◀ ${d.page}/${d.totalPages}`, callback_data: `sp:${d.page - 1}` });
    navRow.push({ text: '+ New', callback_data: 'sess:new' });
    if (d.page < d.totalPages - 1) navRow.push({ text: `${d.page + 2}/${d.totalPages} ▶`, callback_data: `sp:${d.page + 1}` });
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
    const d = await getStatusDataAsync(this, ctx.chatId);
    const lines = [
      `<b>codeclaw</b> v${d.version}\n`,
      `<b>Uptime:</b> ${fmtUptime(d.uptime)}`,
      `<b>Memory:</b> ${(d.memRss / 1024 / 1024).toFixed(0)}MB RSS / ${(d.memHeap / 1024 / 1024).toFixed(0)}MB heap`,
      `<b>PID:</b> ${d.pid}`,
      `<b>Workdir:</b> <code>${escapeHtml(d.workdir)}</code>`,
      '',
      `<b>Agent:</b> ${escapeHtml(d.agent)}`,
      `<b>Model:</b> ${escapeHtml(d.model)}`,
      `<b>Session:</b> ${d.localSessionId ? `<code>${escapeHtml(d.localSessionId)}</code>` : d.sessionId ? `<code>${escapeHtml(d.sessionId.slice(0, 16))}</code>` : '(new)'}`,
      `<b>Active Tasks:</b> ${d.activeTasksCount}`,
    ];
    if (d.running) {
      lines.push(`<b>Running:</b> ${fmtUptime(Date.now() - d.running.startedAt)} - ${escapeHtml(summarizePromptForStatus(d.running.prompt))}`);
    }
    lines.push(...formatProviderUsageLines(d.usage), '', '<b>Bot Usage</b>', `  Turns: ${d.stats.totalTurns}`);
    if (d.stats.totalInputTokens || d.stats.totalOutputTokens) {
      lines.push(`  In: ${fmtTokens(d.stats.totalInputTokens)}  Out: ${fmtTokens(d.stats.totalOutputTokens)}`);
      if (d.stats.totalCachedTokens) lines.push(`  Cached: ${fmtTokens(d.stats.totalCachedTokens)}`);
    }
    await ctx.reply(lines.join('\n'), { parseMode: 'HTML' });
  }

  private async cmdSwitch(ctx: TgContext) {
    const browsePath = path.dirname(this.workdir);
    const view = buildSwitchWorkdirView(this.workdir, browsePath);
    await ctx.reply(
      view.text,
      { parseMode: 'HTML', keyboard: view.keyboard },
    );
  }

  private async cmdHost(ctx: TgContext) {
    const d = getHostDataSync(this);
    const lines = [
      `<b>Host</b>\n`,
      `<b>Name:</b> ${escapeHtml(d.hostName)}`,
      `<b>CPU:</b> ${escapeHtml(d.cpuModel)} x${d.cpuCount}`,
      d.cpuUsage
        ? `<b>CPU Usage:</b> ${d.cpuUsage.usedPercent.toFixed(1)}% (${d.cpuUsage.userPercent.toFixed(1)}% user, ${d.cpuUsage.sysPercent.toFixed(1)}% sys, ${d.cpuUsage.idlePercent.toFixed(1)}% idle)`
        : '<b>CPU Usage:</b> unavailable',
      `<b>Memory:</b> ${fmtBytes(d.memoryUsed)} / ${fmtBytes(d.totalMem)} (${d.memoryPercent.toFixed(0)}%)`,
      `<b>Available:</b> ${fmtBytes(d.memoryAvailable)}`,
      `<b>Battery:</b> ${d.battery ? `${escapeHtml(d.battery.percent)} (${escapeHtml(d.battery.state)})` : 'unavailable'}`,
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
    const d = getAgentsListData(this, ctx.chatId);
    const lines = [`<b>Available Agents</b>\n`];
    const rows: { text: string; callback_data: string }[][] = [];
    for (const a of d.agents) {
      const status = !a.installed ? '\u274C' : a.isCurrent ? '\u25CF' : '\u25CB';
      lines.push(`${status} <b>${escapeHtml(a.agent)}</b>${a.isCurrent ? ' (current)' : ''}`);
      if (a.installed) {
        if (a.version) lines.push(`   Version: <code>${escapeHtml(a.version)}</code>`);
        if (a.path) lines.push(`   Path: <code>${escapeHtml(a.path)}</code>`);
        const label = a.isCurrent ? `\u25CF ${a.agent} (current)` : a.agent;
        rows.push([{ text: label, callback_data: `ag:${a.agent}` }]);
      } else {
        lines.push(`   Not installed`);
      }
    }
    await ctx.reply(lines.join('\n'), { parseMode: 'HTML', keyboard: { inline_keyboard: rows } });
  }

  private async cmdModels(ctx: TgContext) {
    const d = await getModelsListData(this, ctx.chatId);
    const lines = [`<b>Models for ${escapeHtml(d.agent)}</b>`];
    if (d.sources.length) lines.push(`<i>Source: ${escapeHtml(d.sources.join(', '))}</i>`);
    if (d.note) lines.push(`<i>${escapeHtml(d.note)}</i>`);
    lines.push('');
    const rows: { text: string; callback_data: string }[][] = [];
    if (!d.models.length) {
      lines.push('<i>No discoverable models found.</i>');
    }
    for (const m of d.models) {
      const status = m.isCurrent ? '\u25CF' : '\u25CB';
      const display = m.alias ? `${m.alias} (${m.id})` : m.id;
      const currentSuffix = m.isCurrent
        ? (m.id === d.currentModel ? ' \u2190 current' : ` \u2190 current (${escapeHtml(d.currentModel)})`)
        : '';
      lines.push(`${status} <code>${escapeHtml(display)}</code>${currentSuffix}`);
      const label = m.isCurrent ? `\u25CF ${m.alias || m.id}` : (m.alias || m.id);
      rows.push([{ text: label, callback_data: `mod:${m.id}` }]);
    }
    if (d.effort) {
      lines.push('');
      lines.push(`<b>Thinking Effort</b>: <code>${escapeHtml(d.effort.current)}</code>`);
      const effortRow: { text: string; callback_data: string }[] = [];
      for (const l of d.effort.levels) {
        const prefix = l.isCurrent ? '\u25CF ' : '';
        effortRow.push({ text: `${prefix}${l.label}`, callback_data: `eff:${l.id}` });
      }
      rows.push(effortRow);
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

    const session = this.resolveIncomingSession(ctx, text, msg.files);
    const cs = this.chat(ctx.chatId);
    this.applySessionSelection(cs, session);
    const messageThreadId = typeof ctx.raw?.message_thread_id === 'number' ? ctx.raw.message_thread_id : undefined;

    if (!text && msg.files.length) {
      const hadPendingWork = this.sessionHasPendingWork(session);
      const stageTask = this.queueSessionTask(session, async () => {
        try {
          const staged = stageSessionFiles({
            agent: session.agent,
            workdir: this.workdir,
            files: msg.files,
            localSessionId: session.localSessionId,
            sessionId: session.sessionId,
            title: msg.files[0],
          });
          session.workspacePath = staged.workspacePath;
          this.syncSelectedChats(session);
          if (!staged.importedFiles.length) throw new Error('no files persisted');
          this.log(`[handleMessage] staged workspace files chat=${ctx.chatId} local_session=${staged.localSessionId} files=${staged.importedFiles.length}`);
          this.registerSessionMessage(ctx.chatId, ctx.messageId, session);
          await this.safeSetMessageReaction(ctx.chatId, ctx.messageId, ['👌']);
        } catch (e: any) {
          this.log(`[handleMessage] stage files failed: ${e?.message || e}`);
          await this.safeSetMessageReaction(ctx.chatId, ctx.messageId, ['⚠️']);
        }
      });
      if (hadPendingWork) {
        void stageTask.catch(e => this.log(`[handleMessage] stage queue failed: ${e}`));
      } else {
        await stageTask.catch(e => this.log(`[handleMessage] stage queue failed: ${e}`));
      }
      return;
    }

    const files = msg.files;
    const prompt = buildPrompt(text, files);
    const start = Date.now();
    this.log(`[handleMessage] queued chat=${ctx.chatId} agent=${session.agent} session=${session.sessionId || '(new)'} local_session=${session.localSessionId} prompt="${prompt.slice(0, 100)}" files=${files.length}`);
    const placeholderId = await ctx.reply(buildInitialPreviewHtml(session.agent), { parseMode: 'HTML', messageThreadId });
    const phId = typeof placeholderId === 'number' ? placeholderId : null;
    if (phId != null) {
      this.registerSessionMessage(ctx.chatId, phId, session);
      this.log(`[handleMessage] placeholder sent msg_id=${phId}, task queued`);
    } else {
      this.log(`[handleMessage] placeholder unavailable for chat=${ctx.chatId}; continuing without live preview`);
    }

    const taskId = this.createTaskId(session);
    this.beginTask({
      taskId,
      chatId: ctx.chatId,
      agent: session.agent,
      sessionKey: session.key,
      prompt,
      startedAt: start,
      sourceMessageId: ctx.messageId,
    });

    void this.queueSessionTask(session, async () => {
      let livePreview: LivePreview | null = null;
      try {
        if (phId != null) {
          livePreview = new LivePreview({
            agent: session.agent,
            chatId: ctx.chatId,
            placeholderMessageId: phId,
            channel: this.channel,
            renderer: telegramPreviewRenderer,
            streamEditIntervalMs: session.agent === 'codex' ? 400 : 800,
            startTimeMs: start,
            canEditMessages: supportsChannelCapability((this as any).channel, 'editMessages'),
            canSendTyping: supportsChannelCapability((this as any).channel, 'typingIndicators'),
            messageThreadId,
            log: (message: string) => this.log(message),
          });
          livePreview.start();
        }

        const result = await this.runStream(prompt, session, files, (nextText, nextThinking, nextActivity = '', meta, plan) => {
          livePreview?.update(nextText, nextThinking, nextActivity, meta, plan);
        });
        await livePreview?.settle();
        const artifacts = result.artifacts || [];

        this.log(
          `[handleMessage] done agent=${session.agent} ok=${result.ok} session=${result.sessionId || '?'} local_session=${result.localSessionId || '?'} elapsed=${result.elapsedS.toFixed(1)}s edits=${livePreview?.getEditCount() || 0} ` +
          `tokens=in:${fmtTokens(result.inputTokens)}/cached:${fmtTokens(result.cachedInputTokens)}/out:${fmtTokens(result.outputTokens)} artifacts=${artifacts.length}`
        );
        this.log(`[handleMessage] response preview: "${result.message.slice(0, 150)}"`);

        if (artifacts.length && result.incomplete && result.message.trim()) {
          result.incomplete = false;
          this.log(`[handleMessage] suppressed incomplete flag: artifacts present`);
        }

        const finalReply = await this.sendFinalReply(ctx, phId, session.agent, result, { messageThreadId });
        this.registerSessionMessages(ctx.chatId, finalReply.messageIds, session);
        const artifactReplyTo = finalReply.primaryMessageId ?? phId ?? ctx.messageId;
        const artifactResult = await this.sendArtifacts(ctx, artifactReplyTo, artifacts, messageThreadId);
        this.registerSessionMessages(ctx.chatId, artifactResult.messageIds, session);
        this.log(`[handleMessage] final reply sent to chat=${ctx.chatId}`);
      } catch (e: any) {
        const msgText = String(e?.message || e || 'Unknown error');
        this.log(`[handleMessage] task failed chat=${ctx.chatId} local_session=${session.localSessionId} error=${msgText}`);
        const errorHtml = `<b>Error</b>\n\n<code>${escapeHtml(msgText.slice(0, 500))}</code>`;
        if (phId != null) {
          try {
            await this.channel.editMessage(ctx.chatId, phId, errorHtml, { parseMode: 'HTML' });
            this.registerSessionMessage(ctx.chatId, phId, session);
          } catch {
            const sent = await this.channel.send(ctx.chatId, errorHtml, { parseMode: 'HTML', replyTo: ctx.messageId, messageThreadId }).catch(() => null);
            this.registerSessionMessage(ctx.chatId, typeof sent === 'number' ? sent : null, session);
          }
        } else {
          const sent = await this.channel.send(ctx.chatId, errorHtml, { parseMode: 'HTML', replyTo: ctx.messageId, messageThreadId }).catch(() => null);
          this.registerSessionMessage(ctx.chatId, typeof sent === 'number' ? sent : null, session);
        }
        await this.safeSetMessageReaction(ctx.chatId, ctx.messageId, ['⚠️']);
      } finally {
        livePreview?.dispose();
        this.finishTask(taskId);
        this.syncSelectedChats(session);
      }
    }).catch(e => {
      this.log(`[handleMessage] queue execution failed: ${e}`);
      this.finishTask(taskId);
    });
  }

  private async sendArtifacts(ctx: TgContext, replyTo: number, artifacts: BotArtifact[], messageThreadId?: number): Promise<{ failed: BotArtifact[]; messageIds: number[] }> {
    const failed: BotArtifact[] = [];
    const messageIds: number[] = [];
    for (const artifact of artifacts) {
      const caption = artifact.caption;
      try {
        const sent = await this.channel.sendFile(ctx.chatId, artifact.filePath, {
          caption,
          replyTo,
          messageThreadId,
          asPhoto: artifact.kind === 'photo',
        });
        if (typeof sent === 'number') messageIds.push(sent);
      } catch (e) {
        failed.push(artifact);
        this.log(`artifact upload failed for ${artifact.filename}: ${e}`);
        const sent = await this.channel.send(
          ctx.chatId,
          `Artifact upload failed: <code>${escapeHtml(artifact.filename)}</code>`,
          { parseMode: 'HTML', replyTo, messageThreadId },
        ).catch(() => {});
        if (typeof sent === 'number') messageIds.push(sent);
      }
    }
    return { failed, messageIds };
  }

  private async safeSetMessageReaction(chatId: number, messageId: number, reactions: string[]) {
    if (!supportsChannelCapability((this as any).channel, 'messageReactions')) return;
    const setReaction = (this.channel as any)?.setMessageReaction;
    if (typeof setReaction !== 'function') return;
    try {
      await setReaction.call(this.channel, chatId, messageId, reactions);
    } catch {}
  }

  private async sendFinalReply(
    ctx: TgContext,
    phId: number | null,
    agent: Agent,
    result: StreamResult,
    opts: { messageThreadId?: number } = {},
  ): Promise<{ primaryMessageId: number | null; messageIds: number[] }> {
    const rendered = buildFinalReplyRender(agent, result);
    const messageIds: number[] = [];
    const remember = (messageId: number | null) => {
      if (typeof messageId === 'number' && !messageIds.includes(messageId)) messageIds.push(messageId);
      return messageId;
    };
    const sendFinalText = (text: string, replyTo?: number | null) => this.channel.send(ctx.chatId, text, {
      parseMode: 'HTML',
      replyTo: replyTo ?? ctx.messageId,
      messageThreadId: opts.messageThreadId,
    });
    const replacePreview = async (text: string) => {
      if (phId != null) {
        try {
          await this.channel.editMessage(ctx.chatId, phId, text, { parseMode: 'HTML' });
          return remember(phId);
        } catch {}
      }
      return remember(await sendFinalText(text));
    };
    let finalMsgId: number | null = phId;

    if (rendered.fullHtml.length <= 3900) {
      finalMsgId = await replacePreview(rendered.fullHtml);
    } else {
      const maxFirst = 3900 - rendered.headerHtml.length - rendered.footerHtml.length;
      let firstBody: string;
      let remaining: string;
      if (maxFirst > 200) {
        let cut = rendered.bodyHtml.lastIndexOf('\n', maxFirst);
        if (cut < maxFirst * 0.3) cut = maxFirst;
        firstBody = rendered.bodyHtml.slice(0, cut);
        remaining = rendered.bodyHtml.slice(cut);
      } else {
        firstBody = '';
        remaining = rendered.bodyHtml;
      }
      const firstHtml = `${rendered.headerHtml}${firstBody}${rendered.footerHtml}`;
      finalMsgId = await replacePreview(firstHtml);

      if (remaining.trim()) {
        const chunks = splitText(remaining, 3800);
        for (const chunk of chunks) {
          remember(await sendFinalText(chunk, finalMsgId ?? phId ?? ctx.messageId));
        }
      }
    }
    return { primaryMessageId: finalMsgId, messageIds };
  }

  // ---- callbacks ------------------------------------------------------------

  private async handleSwitchNavigateCallback(data: string, ctx: TgCallbackContext): Promise<boolean> {
    if (!data.startsWith('sw:n:')) return false;
    const [pathId, pageRaw] = data.slice(5).split(':');
    const browsePath = resolveRegisteredPath(parseInt(pathId, 10));
    if (!browsePath) {
      await ctx.answerCallback('Expired, use /switch again');
      return true;
    }
    const view = buildSwitchWorkdirView(this.workdir, browsePath, parseInt(pageRaw, 10) || 0);
    await ctx.editReply(ctx.messageId, view.text, { parseMode: 'HTML', keyboard: view.keyboard });
    await ctx.answerCallback();
    return true;
  }

  private async handleSwitchSelectCallback(data: string, ctx: TgCallbackContext): Promise<boolean> {
    if (!data.startsWith('sw:s:')) return false;
    const dirPath = resolveRegisteredPath(parseInt(data.slice(5), 10));
    if (!dirPath) {
      await ctx.answerCallback('Expired, use /switch again');
      return true;
    }
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      await ctx.answerCallback('Not a valid directory');
      return true;
    }

    const oldPath = this.switchWorkdir(dirPath);
    await ctx.answerCallback('Switched!');
    await ctx.editReply(
      ctx.messageId,
      `<b>Workdir switched</b>\n\n<code>${escapeHtml(oldPath)}</code>\n↓\n<code>${escapeHtml(dirPath)}</code>`,
      { parseMode: 'HTML' },
    );
    return true;
  }

  private async handleSessionsPageCallback(data: string, ctx: TgCallbackContext): Promise<boolean> {
    if (!data.startsWith('sp:')) return false;
    const page = parseInt(data.slice(3), 10) || 0;
    const view = await this.buildSessionsPage(ctx.chatId, page);
    await ctx.editReply(ctx.messageId, view.text, { parseMode: 'HTML', keyboard: view.keyboard });
    await ctx.answerCallback('');
    return true;
  }

  private async previewCurrentSessionTurn(chatId: number, agent: Agent, localSessionId: string | null, sessionId: string | null) {
    try {
      const tailId = localSessionId || sessionId;
      const tail = tailId ? await this.fetchSessionTail(agent, tailId, 50) : { ok: true, messages: [], error: null };
      if (!tail.ok || !tail.messages.length) return;

      const messages = tail.messages;
      let lastUserIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          lastUserIndex = i;
          break;
        }
      }

      const lastUserText = lastUserIndex >= 0 ? messages[lastUserIndex].text : '';
      const assistantTexts: string[] = [];
      for (let i = lastUserIndex >= 0 ? lastUserIndex + 1 : 0; i < messages.length; i++) {
        if (messages[i].role === 'assistant' && messages[i].text) assistantTexts.push(messages[i].text);
      }

      const previewHtml = renderSessionTurnHtml(lastUserText, assistantTexts.join('\n\n'));
      if (!previewHtml) return;
      const sent = await this.channel.send(chatId, previewHtml, { parseMode: 'HTML' });
      if (localSessionId) {
        const runtime = this.getSessionRuntimeByKey(this.sessionKey(agent, localSessionId));
        if (runtime && typeof sent === 'number') this.registerSessionMessage(chatId, sent, runtime);
      }
    } catch {
      // non-critical
    }
  }

  private async handleSessionCallback(data: string, ctx: TgCallbackContext): Promise<boolean> {
    if (!data.startsWith('sess:')) return false;

    const requestedSessionId = data.slice(5);
    const cs = this.chat(ctx.chatId);
    if (requestedSessionId === 'new') {
      this.resetChatConversation(cs);
      await ctx.answerCallback('New session');
      await ctx.editReply(ctx.messageId, 'Session reset. Send a message to start.', {});
      return true;
    }

    const res = await this.fetchSessions(cs.agent);
    if (!res.ok) {
      await ctx.answerCallback('Failed to load sessions');
      return true;
    }

    const session = res.sessions.find(entry =>
      entry.localSessionId === requestedSessionId
      || entry.sessionId === requestedSessionId
      || entry.engineSessionId === requestedSessionId,
    );
    if (!session) {
      await ctx.answerCallback('Session not found');
      return true;
    }

    this.adoptSession(cs, session);
    const runtime = session.localSessionId ? this.getSessionRuntimeByKey(this.sessionKey(session.agent, session.localSessionId)) : null;
    const displayId = session.localSessionId || session.sessionId || requestedSessionId;
    await ctx.answerCallback(`Session: ${displayId.slice(0, 12)}`);
    await ctx.editReply(
      ctx.messageId,
      `Switched to session: <code>${escapeHtml(displayId.slice(0, 16))}</code>`,
      { parseMode: 'HTML' },
    );
    if (runtime) this.registerSessionMessage(ctx.chatId, ctx.messageId, runtime);
    await this.previewCurrentSessionTurn(ctx.chatId, session.agent, session.localSessionId, session.sessionId);
    return true;
  }

  private async handleAgentCallback(data: string, ctx: TgCallbackContext): Promise<boolean> {
    if (!data.startsWith('ag:')) return false;

    const agent = data.slice(3) as Agent;
    const cs = this.chat(ctx.chatId);
    if (cs.agent === agent) {
      await ctx.answerCallback(`Already using ${agent}`);
      return true;
    }

    cs.agent = agent;
    this.resetChatConversation(cs);
    this.log(`agent switched to ${agent} chat=${ctx.chatId}`);
    await ctx.answerCallback(`Switched to ${agent}`);
    await ctx.editReply(
      ctx.messageId,
      `<b>Switched to ${escapeHtml(agent)}</b>\n\nSession has been reset. Previous conversation history will not carry over.\nSend a message to start a new conversation.`,
      { parseMode: 'HTML' },
    );
    return true;
  }

  private async handleModelCallback(data: string, ctx: TgCallbackContext): Promise<boolean> {
    if (!data.startsWith('mod:')) return false;

    const modelId = data.slice(4);
    const cs = this.chat(ctx.chatId);
    const currentModel = this.modelForAgent(cs.agent);
    if (modelMatchesSelection(cs.agent, modelId, currentModel)) {
      await ctx.answerCallback(`Already using ${modelId}`);
      return true;
    }

    this.setModelForAgent(cs.agent, modelId);
    this.resetChatConversation(cs);
    this.log(`model switched to ${modelId} for ${cs.agent} chat=${ctx.chatId}`);
    await ctx.answerCallback(`Switched to ${modelId}`);
    await ctx.editReply(
      ctx.messageId,
      `<b>Model switched to <code>${escapeHtml(modelId)}</code></b>\n\nAgent: ${escapeHtml(cs.agent)}\nSession has been reset. Send a message to start a new conversation.`,
      { parseMode: 'HTML' },
    );
    return true;
  }

  private async handleEffortCallback(data: string, ctx: TgCallbackContext): Promise<boolean> {
    if (!data.startsWith('eff:')) return false;

    const effortId = data.slice(4);
    const cs = this.chat(ctx.chatId);
    const currentEffort = this.effortForAgent(cs.agent);
    if (effortId === currentEffort) {
      await ctx.answerCallback(`Already using ${effortId} effort`);
      return true;
    }

    this.setEffortForAgent(cs.agent, effortId);
    this.log(`effort switched to ${effortId} for ${cs.agent} chat=${ctx.chatId}`);
    await ctx.answerCallback(`Effort set to ${effortId}`);
    await ctx.editReply(
      ctx.messageId,
      `<b>Thinking effort set to <code>${escapeHtml(effortId)}</code></b>\n\nAgent: ${escapeHtml(cs.agent)}\nTakes effect on next message.`,
      { parseMode: 'HTML' },
    );
    return true;
  }

  async handleCallback(data: string, ctx: TgCallbackContext) {
    if (await this.handleSwitchNavigateCallback(data, ctx)) return;
    if (await this.handleSwitchSelectCallback(data, ctx)) return;
    if (await this.handleSessionsPageCallback(data, ctx)) return;
    if (await this.handleSessionCallback(data, ctx)) return;
    if (await this.handleAgentCallback(data, ctx)) return;
    if (await this.handleModelCallback(data, ctx)) return;
    if (await this.handleEffortCallback(data, ctx)) return;
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
    const resolved = resolveSkillPrompt(this, ctx.chatId, cmd, args);
    if (!resolved) {
      await ctx.reply(`Skill not found for command /${cmd} in:\n<code>${escapeHtml(this.workdir)}</code>`, { parseMode: 'HTML' });
      return;
    }
    this.log(`skill: ${resolved.skillName} agent=${this.chat(ctx.chatId).agent}${args.trim() ? ` args="${args.trim()}"` : ''}`);
    await this.handleMessage({ text: resolved.prompt, files: [] }, ctx);
  }

  // ---- lifecycle ------------------------------------------------------------

  async run() {
    const tmpDir = path.join(os.tmpdir(), 'codeclaw');
    fs.mkdirSync(tmpDir, { recursive: true });

    this.channel = new TelegramChannel({
      token: this.token,
      workdir: tmpDir,
      allowedChatIds: this.allowedChatIds.size ? this.allowedChatIds as Set<number> : undefined,
    });
    this.installSignalHandlers();

    try {
      const bot = await this.channel.connect();
      this.log(`bot: @${bot.username} (id=${bot.id})`);

      const drained = await this.channel.drain();
      if (drained) this.log(`drained ${drained} pending update(s)`);

      // Seed knownChats so setupMenu applies per-chat commands
      for (const cid of this.allowedChatIds) if (typeof cid === 'number') this.channel.knownChats.add(cid);

      await this.setupMenu();

      for (const ag of this.fetchAgents().agents) {
        this.log(`agent ${ag.agent}: ${ag.path || 'NOT FOUND'}`);
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
    } finally {
      this.stopKeepAlive();
      this.clearShutdownForceExitTimer();
      this.removeSignalHandlers();
      if (this.shutdownInFlight) process.exit(this.shutdownExitCode ?? 1);
    }
  }

  private async sendStartupNotice() {
    const targets = new Set(this.allowedChatIds);
    for (const cid of this.channel.knownChats) targets.add(cid);
    if (!targets.size) {
      this.log('no known chats for startup notice');
      return;
    }

    const text = this.welcomeIntroLines().join('\n');

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
