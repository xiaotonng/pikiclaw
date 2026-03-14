/**
 * bot-feishu.ts — Feishu bot orchestration: commands, streaming, artifacts, lifecycle.
 *
 * Follows the same pattern as bot-telegram.ts:
 *   - Commands use shared data layer (bot-commands.ts) + Feishu renderer
 *   - Messages flow through the streaming pipeline
 *   - LivePreview provides real-time streaming updates via card edits
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  Bot, normalizeAgent, type Agent, type SessionRuntime, type StreamResult,
  fmtTokens, buildPrompt,
  parseAllowedChatIds,
} from './bot.js';
import {
  stageSessionFiles,
} from './code-agent.js';
import type { McpSendFileCallback } from './mcp-bridge.js';
import { shutdownAllDrivers } from './agent-driver.js';
import {
  buildDefaultMenuCommands,
  SKILL_CMD_PREFIX,
} from './bot-menu.js';
import {
  getStartData,
  getSessionsPageData,
  getModelsListData,
  getSessionTurnPreviewData,
  getStatusDataAsync,
  getHostDataSync,
  resolveSkillPrompt,
} from './bot-commands.js';
import {
  buildAgentsCommandView,
  buildModelsCommandView,
  buildSessionsCommandView,
  buildSkillsCommandView,
  decodeCommandAction,
  executeCommandAction,
  type CommandActionResult,
  type CommandSelectionView,
} from './bot-command-ui.js';
import { LivePreview } from './bot-telegram-live-preview.js';
import {
  formatActiveTaskRestartError,
  getActiveTaskCount,
  registerProcessRuntime,
  requestProcessRestart,
} from './process-control.js';
import {
  feishuPreviewRenderer,
  feishuStreamingPreviewRenderer,
  buildInitialPreviewMarkdown,
  buildFinalReplyRender,
  renderCommandNotice,
  renderCommandSelectionCard,
  renderSessionTurnMarkdown,
  renderStart,
  renderStatus,
  renderHost,
  buildSwitchWorkdirCard,
  resolveFeishuRegisteredPath,
} from './bot-feishu-render.js';
import { FeishuChannel, type FeishuContext, type FeishuCallbackContext, type FeishuMessage } from './channel-feishu.js';
import { splitText, supportsChannelCapability } from './channel-base.js';
import { getActiveUserConfig } from './user-config.js';
import { VERSION } from './version.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

const SHUTDOWN_EXIT_CODE: Record<ShutdownSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};
const SHUTDOWN_FORCE_EXIT_MS = 3_000;

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err ?? 'unknown error');

  const parts = [`${err.name}: ${err.message}`];
  for (const key of ['code', 'errno', 'syscall', 'address', 'port', 'host', 'hostname', 'path']) {
    const value = (err as any)?.[key];
    if (value != null && value !== '') parts.push(`${key}=${value}`);
  }

  const cause = (err as any)?.cause;
  if (cause && cause !== err) parts.push(`cause=${describeError(cause)}`);
  return parts.join(' | ');
}

function formatToolLog(activity: string | null | undefined): string {
  const lines = String(activity || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => (
      /^Read\b/.test(line)
      || /^Edit\b/.test(line)
      || /^Write\b/.test(line)
      || /^List files\b/.test(line)
      || /^Search text\b/.test(line)
      || /^Fetch\b/.test(line)
      || /^Search web\b/.test(line)
      || /^Update plan\b/.test(line)
      || /^Run task\b/.test(line)
      || /^Run shell\b/.test(line)
      || /^Use\b/.test(line)
      || /^Using\b/.test(line)
      || /^Updated\b/.test(line)
      || /^Inspect image\b/.test(line)
      || /^Request user input\b/.test(line)
      || /^Run multiple tools\b/.test(line)
      || /\bdone\b/.test(line)
      || /\bfailed\b/.test(line)
    ));

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    deduped.push(line);
  }

  if (!deduped.length) return '-';

  const summary = deduped.slice(0, 6).join(' | ');
  return summary.length <= 240 ? summary : `${summary.slice(0, 237).trimEnd()}...`;
}

// ---------------------------------------------------------------------------
// FeishuBot
// ---------------------------------------------------------------------------

export class FeishuBot extends Bot {
  private appId: string;
  private appSecret: string;
  private domain: string;
  private channel!: FeishuChannel;

  /** Maps chatId → (messageId → sessionKey) for reply-chain session tracking. */
  private sessionMessages = new Map<string, Map<string, string>>();
  private nextTaskId = 1;
  private shutdownInFlight = false;
  private shutdownExitCode: number | null = null;
  private shutdownForceExitTimer: ReturnType<typeof setTimeout> | null = null;
  private signalHandlers: Partial<Record<string, () => void>> = {};
  private processRuntimeCleanup: (() => void) | null = null;

  constructor() {
    super();
    const config = getActiveUserConfig();
    // Merge Feishu-specific allowed IDs into base
    if (process.env.FEISHU_ALLOWED_CHAT_IDS) {
      for (const id of parseAllowedChatIds(process.env.FEISHU_ALLOWED_CHAT_IDS)) this.allowedChatIds.add(id);
    }

    this.appId = String(config.feishuAppId || process.env.FEISHU_APP_ID || '').trim();
    this.appSecret = String(config.feishuAppSecret || process.env.FEISHU_APP_SECRET || '').trim();
    this.domain = (process.env.FEISHU_DOMAIN || 'https://open.feishu.cn').trim();

    if (!this.appId || !this.appSecret) {
      throw new Error('Missing Feishu credentials. Set FEISHU_APP_ID and FEISHU_APP_SECRET');
    }
  }

  protected override onManagedConfigChange(config: Record<string, any>, opts: { initial?: boolean } = {}) {
    const nextAppId = String(config.feishuAppId || process.env.FEISHU_APP_ID || '').trim();
    const nextAppSecret = String(config.feishuAppSecret || process.env.FEISHU_APP_SECRET || '').trim();
    if (nextAppId && nextAppId !== this.appId) {
      this.appId = nextAppId;
      if (!opts.initial) this.log('feishu appId reloaded from setting.json');
    }
    if (nextAppSecret && nextAppSecret !== this.appSecret) {
      this.appSecret = nextAppSecret;
      if (!opts.initial) this.log('feishu appSecret reloaded from setting.json');
    }
  }

  private static readonly SKILL_CMD_PREFIX = SKILL_CMD_PREFIX;

  async setupMenu() {
    if (!supportsChannelCapability(this.channel, 'commandMenu')) return;
    const res = this.fetchAgents();
    const installedCount = res.agents.filter(a => a.installed).length;
    const skillRes = this.fetchSkills();
    const commands = buildDefaultMenuCommands(installedCount, skillRes.skills);
    await this.channel.setMenu(commands);
    this.log(`menu: ${commands.length} commands (${skillRes.skills.length} skills)`);
  }

  protected override afterSwitchWorkdir(_oldPath: string, _newPath: string) {
    this.sessionMessages.clear();
    if (!this.channel) return;
    void this.setupMenu().catch(err => this.log(`menu refresh failed: ${err}`));
  }

  // ---- signal handling ------------------------------------------------------

  private installSignalHandlers() {
    this.removeSignalHandlers();
    const onSigint = () => this.beginShutdown('SIGINT');
    const onSigterm = () => this.beginShutdown('SIGTERM');
    this.signalHandlers = { SIGINT: onSigint, SIGTERM: onSigterm };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }

  private removeSignalHandlers() {
    for (const sig of Object.keys(this.signalHandlers)) {
      const handler = this.signalHandlers[sig];
      if (handler) process.off(sig, handler);
    }
    this.signalHandlers = {};
  }

  private beginShutdown(sig: ShutdownSignal) {
    if (this.shutdownInFlight) return;
    this.shutdownInFlight = true;
    this.shutdownExitCode = SHUTDOWN_EXIT_CODE[sig];
    this.log(`${sig}, shutting down...`);

    this.cleanupRuntimeForExit();

    if (this.shutdownForceExitTimer) clearTimeout(this.shutdownForceExitTimer);
    this.shutdownForceExitTimer = setTimeout(() => {
      this.log(`shutdown still pending after ${Math.floor(SHUTDOWN_FORCE_EXIT_MS / 1000)}s, forcing exit`);
      process.exit(this.shutdownExitCode ?? 1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    this.shutdownForceExitTimer.unref?.();
  }

  private cleanupRuntimeForExit() {
    try { this.channel.disconnect(); } catch {}
    this.stopKeepAlive();
    shutdownAllDrivers();
  }

  private buildRestartEnv(): Record<string, string> {
    const knownIds = new Set(this.allowedChatIds);
    for (const cid of this.channel.knownChats) knownIds.add(cid);
    return knownIds.size ? { FEISHU_ALLOWED_CHAT_IDS: [...knownIds].join(',') } : {};
  }

  // ---- session tracking -----------------------------------------------------

  private createTaskId(session: SessionRuntime): string {
    const seq = this.nextTaskId++;
    return `${session.key}:${Date.now().toString(36)}:${seq.toString(36)}`;
  }

  private registerSessionMessage(chatId: string, messageId: string | null | undefined, session: SessionRuntime) {
    if (session.workdir !== this.workdir) return;
    if (!messageId) return;
    let messages = this.sessionMessages.get(chatId);
    if (!messages) {
      messages = new Map<string, string>();
      this.sessionMessages.set(chatId, messages);
    }
    messages.set(messageId, session.key);
    // Cap size
    while (messages.size > 1024) {
      const oldest = messages.keys().next();
      if (oldest.done) break;
      messages.delete(oldest.value);
    }
  }

  private registerSessionMessages(chatId: string, messageIds: Array<string | null | undefined>, session: SessionRuntime) {
    for (const messageId of messageIds) this.registerSessionMessage(chatId, messageId, session);
  }

  private sessionFromMessage(chatId: string, messageId: string | null | undefined): SessionRuntime | null {
    if (!messageId) return null;
    const sessionKey = this.sessionMessages.get(chatId)?.get(messageId) || null;
    return this.getSessionRuntimeByKey(sessionKey);
  }

  private ensureSession(chatId: string, title: string, files: string[]): SessionRuntime {
    const cs = this.chat(chatId);
    const selected = this.getSelectedSession(cs);
    if (selected) return selected;

    const staged = stageSessionFiles({
      agent: cs.agent,
      workdir: this.workdir,
      files: [],
      sessionId: null,
      title: title || files[0] || 'New session',
    });
    const runtime = this.upsertSessionRuntime({
      agent: cs.agent,
      sessionId: staged.sessionId,
      workspacePath: staged.workspacePath,
      modelId: this.modelForAgent(cs.agent),
    });
    this.applySessionSelection(cs, runtime);
    return runtime;
  }

  private resolveIncomingSession(ctx: FeishuContext, text: string, files: string[]): SessionRuntime {
    const cs = this.chat(ctx.chatId);
    // TODO: Feishu doesn't expose reply_to in the event easily; for now use active session
    const selected = this.getSelectedSession(cs);
    if (selected) return selected;
    return this.ensureSession(ctx.chatId, text, files);
  }

  // ---- commands -------------------------------------------------------------

  private async cmdStart(ctx: FeishuContext) {
    const d = getStartData(this, ctx.chatId);
    await ctx.reply(renderStart(d));
  }

  private async cmdSkills(ctx: FeishuContext) {
    await this.sendCommandView(ctx, buildSkillsCommandView(this, ctx.chatId));
  }

  private async sendCommandView(ctx: FeishuContext, view: CommandSelectionView) {
    await ctx.channel.sendCard(ctx.chatId, renderCommandSelectionCard(view));
  }

  private async replyCommandResult(ctx: FeishuContext, result: CommandActionResult) {
    if (result.kind === 'view') {
      await this.sendCommandView(ctx, result.view);
      return;
    }
    if (result.kind === 'skill') {
      await this.handleMessage({ text: result.prompt, files: [] }, ctx);
      return;
    }
    if (result.kind === 'notice') {
      const sent = await ctx.reply(renderCommandNotice(result.notice));
      if (result.session && sent) this.registerSessionMessage(ctx.chatId, sent, result.session);
      if (result.previewSession) {
        await this.previewCurrentSessionTurn(ctx.chatId, result.previewSession.agent, result.previewSession.sessionId);
      }
      return;
    }
    await ctx.reply(result.message);
  }

  private async applyCommandCallbackResult(ctx: FeishuCallbackContext, result: CommandActionResult) {
    if (result.kind === 'noop') return;
    if (result.kind === 'view') {
      await ctx.channel.editCard(ctx.chatId, ctx.messageId, renderCommandSelectionCard(result.view));
      return;
    }
    if (result.kind === 'skill') {
      await this.handleMessage({ text: result.prompt, files: [] }, this.callbackToMessageContext(ctx));
      return;
    }
    await ctx.editReply(ctx.messageId, renderCommandNotice(result.notice));
    if (result.session) this.registerSessionMessage(ctx.chatId, ctx.messageId, result.session);
    if (result.previewSession) {
      await this.previewCurrentSessionTurn(ctx.chatId, result.previewSession.agent, result.previewSession.sessionId);
    }
  }

  private sessionsPageSize = 5;

  private async cmdSessions(ctx: FeishuContext, args: string) {
    const arg = args.trim().toLowerCase();
    if (arg === 'new') {
      await this.replyCommandResult(
        ctx,
        await executeCommandAction(this, ctx.chatId, { kind: 'session.new' }, { sessionsPageSize: this.sessionsPageSize }),
      );
      return;
    }

    const pageMatch = arg.match(/^p(\d+)$/);
    if (pageMatch) {
      await this.replyCommandResult(
        ctx,
        await executeCommandAction(
          this,
          ctx.chatId,
          { kind: 'sessions.page', page: parseInt(pageMatch[1], 10) - 1 },
          { sessionsPageSize: this.sessionsPageSize },
        ),
      );
      return;
    }

    const idx = parseInt(arg, 10);
    if (!isNaN(idx) && idx >= 1) {
      const d = await getSessionsPageData(this, ctx.chatId, 0, 100);
      const target = d.sessions[idx - 1];
      if (target) {
        await this.replyCommandResult(
          ctx,
          await executeCommandAction(this, ctx.chatId, { kind: 'session.switch', sessionId: target.key }),
        );
        return;
      }
      await ctx.reply(`Session #${idx} not found.`);
      return;
    }

    await this.sendCommandView(ctx, await buildSessionsCommandView(this, ctx.chatId, 0, this.sessionsPageSize));
  }

  private async cmdStatus(ctx: FeishuContext) {
    const d = await getStatusDataAsync(this, ctx.chatId);
    await ctx.reply(renderStatus(d));
  }

  private async cmdHost(ctx: FeishuContext) {
    const d = getHostDataSync(this);
    await ctx.reply(renderHost(d));
  }

  private async cmdAgents(ctx: FeishuContext, args: string) {
    const arg = args.trim().toLowerCase();

    if (arg) {
      try {
        const agent = normalizeAgent(arg);
        await this.replyCommandResult(
          ctx,
          await executeCommandAction(this, ctx.chatId, { kind: 'agent.switch', agent }),
        );
        return;
      } catch {
        // Not a valid agent name — show list
      }
    }

    await this.sendCommandView(ctx, buildAgentsCommandView(this, ctx.chatId));
  }

  private async cmdModels(ctx: FeishuContext, args: string) {
    const arg = args.trim();

    if (arg) {
      const d = await getModelsListData(this, ctx.chatId);
      const idx = parseInt(arg, 10);
      let modelId: string | null = null;
      if (!isNaN(idx) && idx >= 1 && idx <= d.models.length) {
        modelId = d.models[idx - 1].id;
      } else {
        const match = d.models.find(m => m.id === arg || m.alias === arg);
        if (match) modelId = match.id;
      }

      if (modelId) {
        await this.replyCommandResult(
          ctx,
          await executeCommandAction(this, ctx.chatId, { kind: 'model.switch', modelId }),
        );
        return;
      }
    }

    await this.sendCommandView(ctx, await buildModelsCommandView(this, ctx.chatId));
  }

  private async cmdSwitch(ctx: FeishuContext, args: string) {
    const arg = args.trim();
    if (arg) {
      const resolvedPath = path.resolve(arg.replace(/^~/, process.env.HOME || ''));
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
        await ctx.reply(`Not a valid directory: \`${resolvedPath}\``);
        return;
      }
      const oldPath = this.switchWorkdir(resolvedPath);
      await ctx.reply(`**Workdir switched**\n\n\`${oldPath}\`\n↓\n\`${resolvedPath}\``);
      return;
    }

    const browsePath = path.dirname(this.workdir);
    const view = buildSwitchWorkdirCard(this.workdir, browsePath);
    await ctx.channel.sendCard(ctx.chatId, view);
  }

  private async cmdRestart(ctx: FeishuContext) {
    const activeTasks = getActiveTaskCount();
    if (activeTasks > 0) {
      await ctx.reply(`⚠ ${formatActiveTaskRestartError(activeTasks)}`);
      return;
    }
    await ctx.reply('**Restarting pikiclaw...**\n\nPulling latest version. The bot will be back shortly.');
    void requestProcessRestart({ log: msg => this.log(msg) });
  }

  // ---- streaming bridge -----------------------------------------------------

  private async handleMessage(msg: FeishuMessage, ctx: FeishuContext) {
    const text = msg.text.trim();
    if (!text && !msg.files.length) return;

    const session = this.resolveIncomingSession(ctx, text, msg.files);
    const cs = this.chat(ctx.chatId);
    this.applySessionSelection(cs, session);

    // File-only message: stage files
    if (!text && msg.files.length) {
      const hadPendingWork = this.sessionHasPendingWork(session);
      const stageTask = this.queueSessionTask(session, async () => {
        try {
          const staged = stageSessionFiles({
            agent: session.agent,
            workdir: this.workdir,
            files: msg.files,
            sessionId: session.sessionId,
            title: msg.files[0],
          });
          session.workspacePath = staged.workspacePath;
          this.syncSelectedChats(session);
          if (!staged.importedFiles.length) throw new Error('no files persisted');
          this.log(`[handleMessage] staged files chat=${ctx.chatId} session=${staged.sessionId} files=${staged.importedFiles.length}`);
          this.registerSessionMessage(ctx.chatId, ctx.messageId, session);
        } catch (e: any) {
          this.log(`[handleMessage] stage files failed: ${e?.message || e}`);
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
    this.log(
      `[handleMessage] start chat=${ctx.chatId} agent=${session.agent} session=${session.sessionId || '(new)'} ` +
      `files=${files.length} prompt="${prompt.slice(0, 100)}"`,
    );

    const model = session.modelId || this.modelForAgent(session.agent);
    const effort = this.effortForAgent(session.agent);
    const placeholderId = await this.channel.sendStreamingCard(ctx.chatId, buildInitialPreviewMarkdown(session.agent, model, effort), { replyTo: ctx.messageId || undefined });
    if (placeholderId) {
      this.registerSessionMessage(ctx.chatId, placeholderId, session);
    }

    const taskId = this.createTaskId(session);
    this.beginTask({
      taskId,
      chatId: ctx.chatId,
      agent: session.agent,
      sessionKey: session.key,
      prompt,
      startedAt: start,
      sourceMessageId: ctx.messageId as any,
    });

    void this.queueSessionTask(session, async () => {
      let livePreview: LivePreview | null = null;
      try {
        if (placeholderId) {
          const renderer = this.channel.isStreamingCard(placeholderId)
            ? feishuStreamingPreviewRenderer
            : feishuPreviewRenderer;
          livePreview = new LivePreview({
            agent: session.agent,
            chatId: ctx.chatId,
            placeholderMessageId: placeholderId,
            channel: this.channel,
            renderer,
            streamEditIntervalMs: 700,
            startTimeMs: start,
            canEditMessages: supportsChannelCapability(this.channel, 'editMessages'),
            canSendTyping: false,
            parseMode: 'Markdown',
            log: (message: string) => this.log(message),
          });
          livePreview.start();
        }

        // MCP sendFile callback: sends files to IM in real-time during the stream
        const mcpSendFile = this.createMcpSendFileCallback(ctx);

        const result = await this.runStream(prompt, session, files, (nextText, nextThinking, nextActivity = '', meta, plan) => {
          livePreview?.update(nextText, nextThinking, nextActivity, meta, plan);
        }, undefined, mcpSendFile);
        await livePreview?.settle();

        const finalReplyIds = await this.sendFinalReply(ctx, placeholderId, session.agent, result);
        this.registerSessionMessages(ctx.chatId, finalReplyIds, session);
        this.log(
          `[handleMessage] end chat=${ctx.chatId} agent=${session.agent} ok=${result.ok} session=${result.sessionId || session.sessionId || '(new)'} ` +
          `elapsed=${result.elapsedS.toFixed(1)}s tokens=in:${fmtTokens(result.inputTokens)}/out:${fmtTokens(result.outputTokens)} ` +
          `tools=${formatToolLog(result.activity)}`,
        );
      } catch (e: any) {
        const msgText = String(e?.message || e || 'Unknown error');
        this.log(
          `[handleMessage] end chat=${ctx.chatId} agent=${session.agent} ok=false session=${session.sessionId || '(new)'} ` +
          `elapsed=${((Date.now() - start) / 1000).toFixed(1)}s error="${msgText.slice(0, 240)}" tools=-`,
        );
        const errorText = `**Error**\n\n\`${msgText.slice(0, 500)}\``;
        if (placeholderId) {
          try {
            await this.channel.editMessage(ctx.chatId, placeholderId, errorText);
          } catch {
            await this.channel.send(ctx.chatId, errorText).catch(() => null);
          }
        } else {
          await this.channel.send(ctx.chatId, errorText).catch(() => null);
        }
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

  private async sendFinalReply(
    ctx: FeishuContext,
    placeholderId: string | null,
    agent: Agent,
    result: StreamResult,
  ): Promise<string[]> {
    const rendered = buildFinalReplyRender(agent, result);
    const messageIds: string[] = [];

    const MAX_CARD = 25_000;
    if (rendered.fullText.length <= MAX_CARD) {
      // Fits in one card — edit the placeholder
      if (placeholderId) {
        try {
          await this.channel.editMessage(ctx.chatId, placeholderId, rendered.fullText);
          messageIds.push(placeholderId);
          return messageIds;
        } catch {}
      }
      const sent = await this.channel.send(ctx.chatId, rendered.fullText);
      if (sent) messageIds.push(sent);
    } else {
      // Split: first card has header + truncated body + footer, continuation as separate cards
      const maxFirst = MAX_CARD - rendered.headerText.length - rendered.footerText.length;
      let firstBody: string;
      let remaining: string;
      if (maxFirst > 200) {
        let cut = rendered.bodyText.lastIndexOf('\n', maxFirst);
        if (cut < maxFirst * 0.3) cut = maxFirst;
        firstBody = rendered.bodyText.slice(0, cut);
        remaining = rendered.bodyText.slice(cut);
      } else {
        firstBody = '';
        remaining = rendered.bodyText;
      }

      const firstText = `${rendered.headerText}${firstBody}${rendered.footerText}`;
      if (placeholderId) {
        try {
          await this.channel.editMessage(ctx.chatId, placeholderId, firstText);
          messageIds.push(placeholderId);
        } catch {
          const sent = await this.channel.send(ctx.chatId, firstText);
          if (sent) messageIds.push(sent);
        }
      } else {
        const sent = await this.channel.send(ctx.chatId, firstText);
        if (sent) messageIds.push(sent);
      }

      if (remaining.trim()) {
        const chunks = splitText(remaining, MAX_CARD);
        for (const chunk of chunks) {
          const sent = await this.channel.send(ctx.chatId, chunk);
          if (sent) messageIds.push(sent);
        }
      }
    }

    return messageIds;
  }

  /** Create an MCP sendFile callback bound to a Feishu chat context. */
  private createMcpSendFileCallback(ctx: FeishuContext): McpSendFileCallback {
    return async (filePath, opts) => {
      try {
        await this.channel.sendFile(ctx.chatId, filePath, {
          caption: opts?.caption,
          replyTo: ctx.messageId,
          asPhoto: opts?.kind === 'photo',
        });
        return { ok: true };
      } catch (e: any) {
        this.log(`[mcp] sendFile failed: ${filePath} error=${e?.message || e}`);
        return { ok: false, error: e?.message || 'send failed' };
      }
    };
  }

  // ---- command router -------------------------------------------------------

  async handleCommand(cmd: string, args: string, ctx: FeishuContext) {
    try {
      switch (cmd) {
        case 'start':    await this.cmdStart(ctx); return;
        case 'sessions': await this.cmdSessions(ctx, args); return;
        case 'agents':   await this.cmdAgents(ctx, args); return;
        case 'models':   await this.cmdModels(ctx, args); return;
        case 'skills':   await this.cmdSkills(ctx); return;
        case 'status':   await this.cmdStatus(ctx); return;
        case 'host':     await this.cmdHost(ctx); return;
        case 'switch':   await this.cmdSwitch(ctx, args); return;
        case 'restart':  await this.cmdRestart(ctx); return;
        default:
          // Skill commands
          if (cmd.startsWith(FeishuBot.SKILL_CMD_PREFIX)) {
            await this.cmdSkill(cmd, args, ctx);
            return;
          }
          // Unknown command — treat as message
          await this.handleMessage({ text: `/${cmd}${args ? ' ' + args : ''}`, files: [] }, ctx);
      }
    } catch (e: any) {
      this.log(`cmd error: ${e}`);
      await ctx.reply(`Error: ${String(e).slice(0, 200)}`);
    }
  }

  private async cmdSkill(cmd: string, args: string, ctx: FeishuContext) {
    const resolved = resolveSkillPrompt(this, ctx.chatId, cmd, args);
    if (!resolved) {
      await ctx.reply(`Skill not found for command /${cmd} in:\n\`${this.workdir}\``);
      return;
    }
    this.log(`skill: ${resolved.skillName} agent=${this.chat(ctx.chatId).agent}${args.trim() ? ` args="${args.trim()}"` : ''}`);
    await this.handleMessage({ text: resolved.prompt, files: [] }, ctx);
  }

  private callbackToMessageContext(ctx: FeishuCallbackContext): FeishuContext {
    return {
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      from: ctx.from,
      chatType: 'p2p',
      reply: (text, opts) => ctx.channel.send(ctx.chatId, text, opts),
      editReply: (msgId, text, opts) => ctx.channel.editMessage(ctx.chatId, msgId, text, opts),
      channel: ctx.channel,
      raw: ctx.raw,
    };
  }

  // ---- callback handlers ----------------------------------------------------

  private async handleCallback(data: string, ctx: FeishuCallbackContext) {
    try {
      if (await this.handleSwitchNavigateCallback(data, ctx)) return;
      if (await this.handleSwitchSelectCallback(data, ctx)) return;

      const action = decodeCommandAction(data);
      if (!action) return;
      const result = await executeCommandAction(this, ctx.chatId, action, {
        sessionsPageSize: this.sessionsPageSize,
      });
      await this.applyCommandCallbackResult(ctx, result);
    } catch (e: any) {
      this.log(`callback error: ${e}`);
    }
  }

  private async handleSwitchNavigateCallback(data: string, ctx: FeishuCallbackContext): Promise<boolean> {
    if (!data.startsWith('sw:n:')) return false;
    const [pathId, pageRaw] = data.slice(5).split(':');
    const browsePath = resolveFeishuRegisteredPath(parseInt(pathId, 10));
    if (!browsePath) return true;
    const view = buildSwitchWorkdirCard(this.workdir, browsePath, parseInt(pageRaw, 10) || 0);
    await ctx.channel.editCard(ctx.chatId, ctx.messageId, view);
    return true;
  }

  private async handleSwitchSelectCallback(data: string, ctx: FeishuCallbackContext): Promise<boolean> {
    if (!data.startsWith('sw:s:')) return false;
    const dirPath = resolveFeishuRegisteredPath(parseInt(data.slice(5), 10));
    if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return true;

    const oldPath = this.switchWorkdir(dirPath);
    await ctx.editReply(
      ctx.messageId,
      `**Workdir**\n● \`${oldPath}\`\n→ \`${dirPath}\``,
    );
    return true;
  }

  private async previewCurrentSessionTurn(chatId: string, agent: Agent, sessionId: string | null) {
    try {
      const preview = await getSessionTurnPreviewData(this, agent, sessionId, 50);
      if (!preview) return;
      const previewMarkdown = renderSessionTurnMarkdown(preview.userText, preview.assistantText);
      if (!previewMarkdown) return;
      const sent = await this.channel.send(chatId, previewMarkdown);
      if (sessionId) {
        const runtime = this.getSessionRuntimeByKey(this.sessionKey(agent, sessionId));
        if (runtime && sent) this.registerSessionMessage(chatId, sent, runtime);
      }
    } catch {
      // non-critical
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  async run() {
    const tmpDir = path.join(os.tmpdir(), 'pikiclaw');
    fs.mkdirSync(tmpDir, { recursive: true });

    this.channel = new FeishuChannel({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      workdir: tmpDir,
      allowedChatIds: this.allowedChatIds.size
        ? this.allowedChatIds as Set<string>
        : undefined,
    });
    this.processRuntimeCleanup?.();
    this.processRuntimeCleanup = registerProcessRuntime({
      label: 'feishu',
      getActiveTaskCount: () => this.activeTasks.size,
      prepareForRestart: () => this.cleanupRuntimeForExit(),
      buildRestartEnv: () => this.buildRestartEnv(),
    });
    this.installSignalHandlers();

    try {
      const bot = await this.channel.connect();
      this.connected = true;
      this.log(`bot: ${bot.displayName} (id=${bot.id})`);

      for (const ag of this.fetchAgents().agents) {
        this.log(`agent ${ag.agent}: ${ag.path || 'NOT FOUND'}`);
      }
      this.log(`config: agent=${this.defaultAgent} workdir=${this.workdir} timeout=${this.runTimeout}s`);

      this.channel.onCommand((cmd, args, ctx) => this.handleCommand(cmd, args, ctx));
      this.channel.onMessage((msg, ctx) => this.handleMessage(msg, ctx));
      this.channel.onCallback((data, ctx) => this.handleCallback(data, ctx));
      this.channel.onError(err => this.log(`error: ${err}`));

      this.startKeepAlive();
      void this.setupMenu().catch(err => this.log(`menu setup failed: ${err}`));
      void this.sendStartupNotice().catch(err => this.log(`startup notice failed: ${err}`));
      this.log('✓ Feishu connected, WebSocket listening — ready to receive messages');
      await this.channel.listen();
      this.stopKeepAlive();
      this.log('stopped');
    } finally {
      this.stopKeepAlive();
      if (this.shutdownForceExitTimer) clearTimeout(this.shutdownForceExitTimer);
      this.removeSignalHandlers();
      this.processRuntimeCleanup?.();
      this.processRuntimeCleanup = null;
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

    for (const cid of targets) {
      try {
        const d = getStartData(this, cid);
        const text = renderStart(d);
        await this.channel.send(cid, text);
        this.log(`startup notice sent to chat=${cid}`);
      } catch (e) {
        this.log(`startup notice failed for chat=${cid}: ${e}`);
      }
    }
  }
}
