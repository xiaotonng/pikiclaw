/**
 * WeChat bot orchestration.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Bot,
  buildPrompt,
  fmtUptime,
  fmtBytes,
  normalizeAgent,
  parseAllowedChatIds,
  type SessionRuntime,
  type StreamResult,
} from '../../bot/bot.js';
import { BOT_SHUTDOWN_FORCE_EXIT_MS, buildSessionTaskId } from '../../bot/orchestration.js';
import { shutdownAllDrivers } from '../../agent/driver.js';
import type { McpSendFileCallback } from '../../agent/mcp/bridge.js';
import {
  formatActiveTaskRestartError,
  getActiveTaskCount,
  registerProcessRuntime,
  requestProcessRestart,
} from '../../core/process-control.js';
import {
  getStatusDataAsync,
  getHostDataSync,
  getAgentsListData,
  getSkillsListData,
  getModelsListData,
  getSessionsPageData,
  getStartData,
} from '../../bot/commands.js';
import { WeixinChannel, type WeixinContext, type WeixinMessagePayload } from './channel.js';
import { getActiveUserConfig } from '../../core/config/user-config.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

const SHUTDOWN_EXIT_CODE: Record<ShutdownSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

export class WeixinBot extends Bot {
  private botToken: string;
  private accountId: string;
  private baseUrl: string;
  private channel!: WeixinChannel;
  private nextTaskId = 1;
  private shutdownInFlight = false;
  private shutdownExitCode: number | null = null;
  private shutdownForceExitTimer: ReturnType<typeof setTimeout> | null = null;
  private signalHandlers: Partial<Record<ShutdownSignal, () => void>> = {};
  private processRuntimeCleanup: (() => void) | null = null;

  constructor() {
    super();
    const config = getActiveUserConfig();
    if (process.env.WEIXIN_ALLOWED_USER_IDS) {
      for (const id of parseAllowedChatIds(process.env.WEIXIN_ALLOWED_USER_IDS)) this.allowedChatIds.add(id);
    }
    this.baseUrl = String(config.weixinBaseUrl || process.env.WEIXIN_BASE_URL || '').trim();
    this.botToken = String(config.weixinBotToken || process.env.WEIXIN_BOT_TOKEN || '').trim();
    this.accountId = String(config.weixinAccountId || process.env.WEIXIN_ACCOUNT_ID || '').trim();
    if (!this.baseUrl || !this.botToken || !this.accountId) {
      throw new Error('Missing Weixin credentials. Configure via dashboard QR login first.');
    }
  }

  protected override onManagedConfigChange(config: Record<string, any>, opts: { initial?: boolean } = {}) {
    const nextBaseUrl = String(config.weixinBaseUrl || process.env.WEIXIN_BASE_URL || '').trim();
    const nextBotToken = String(config.weixinBotToken || process.env.WEIXIN_BOT_TOKEN || '').trim();
    const nextAccountId = String(config.weixinAccountId || process.env.WEIXIN_ACCOUNT_ID || '').trim();
    if (nextBaseUrl && nextBaseUrl !== this.baseUrl) {
      this.baseUrl = nextBaseUrl;
      if (!opts.initial) this.log('weixin baseUrl reloaded from setting.json');
    }
    if (nextBotToken && nextBotToken !== this.botToken) {
      this.botToken = nextBotToken;
      if (!opts.initial) this.log('weixin botToken reloaded from setting.json');
    }
    if (nextAccountId && nextAccountId !== this.accountId) {
      this.accountId = nextAccountId;
      if (!opts.initial) this.log('weixin accountId reloaded from setting.json');
    }
  }

  private installSignalHandlers() {
    this.removeSignalHandlers();
    const onSigint = () => this.beginShutdown('SIGINT');
    const onSigterm = () => this.beginShutdown('SIGTERM');
    this.signalHandlers = { SIGINT: onSigint, SIGTERM: onSigterm };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }

  private removeSignalHandlers() {
    for (const signal of Object.keys(this.signalHandlers) as ShutdownSignal[]) {
      const handler = this.signalHandlers[signal];
      if (handler) process.off(signal, handler);
    }
    this.signalHandlers = {};
  }

  private clearShutdownForceExitTimer() {
    if (!this.shutdownForceExitTimer) return;
    clearTimeout(this.shutdownForceExitTimer);
    this.shutdownForceExitTimer = null;
  }

  private cleanupRuntimeForExit() {
    try { this.channel.disconnect(); } catch {}
    this.stopKeepAlive();
    shutdownAllDrivers();
  }

  private beginShutdown(signal: ShutdownSignal) {
    if (this.shutdownInFlight) return;
    this.shutdownInFlight = true;
    this.shutdownExitCode = SHUTDOWN_EXIT_CODE[signal];
    this.log(`${signal}, shutting down...`);
    this.cleanupRuntimeForExit();
    this.clearShutdownForceExitTimer();
    this.shutdownForceExitTimer = setTimeout(() => {
      this.log(`shutdown still pending after ${Math.floor(BOT_SHUTDOWN_FORCE_EXIT_MS / 1000)}s, forcing exit`);
      process.exit(this.shutdownExitCode ?? 1);
    }, BOT_SHUTDOWN_FORCE_EXIT_MS);
    this.shutdownForceExitTimer.unref?.();
  }

  private resolveSession(chatId: string, title: string, files: string[]): SessionRuntime {
    return this.ensureSessionForChat(chatId, title, files);
  }

  private async handleCommand(text: string, ctx: WeixinContext): Promise<boolean> {
    const [rawCommand, ...rest] = text.trim().slice(1).split(/\s+/);
    const command = rawCommand?.toLowerCase() || '';
    const args = rest.join(' ').trim();
    switch (command) {
      case 'help':
        await ctx.reply([
          '/help - Show commands',
          '/new - New session',
          '/status - Session status',
          '/host - Host system info',
          '/agent [codex|claude|gemini] - Switch agent',
          '/models [name|#] - Switch model',
          '/mode [plan|code] - Toggle plan mode (claude only)',
          '/switch [path] - Change workdir',
          '/sessions [new|#] - List/switch sessions',
          '/skills - List project skills',
          '/stop - Stop current task',
          '/restart - Restart pikiclaw',
        ].join('\n'));
        return true;
      case 'new':
        this.resetConversationForChat(ctx.chatId);
        await ctx.reply('Started a new session.');
        return true;
      case 'status':
        await this.cmdStatus(ctx);
        return true;
      case 'host':
        await this.cmdHost(ctx);
        return true;
      case 'agent':
        await this.cmdAgent(ctx, args);
        return true;
      case 'models':
        await this.cmdModels(ctx, args);
        return true;
      case 'mode':
        await this.cmdMode(ctx, args);
        return true;
      case 'switch':
        await this.cmdSwitch(ctx, args);
        return true;
      case 'sessions':
        await this.cmdSessions(ctx, args);
        return true;
      case 'skills':
        await this.cmdSkills(ctx);
        return true;
      case 'stop':
        await this.cmdStop(ctx);
        return true;
      case 'restart':
        await this.cmdRestart(ctx);
        return true;
      case 'start':
        await this.cmdStart(ctx);
        return true;
      default:
        return false;
    }
  }

  private async cmdStart(ctx: WeixinContext) {
    const d = getStartData(this, ctx.chatId);
    const lines = [`pikiclaw v${d.version}`, `Workdir: ${d.workdir}`, '', `Agent: ${d.agent}`];
    for (const a of d.agentDetails) {
      const parts = [`  ${a.agent}: ${a.model}`];
      if (a.effort) parts[0] += ` (effort: ${a.effort})`;
      lines.push(parts[0]);
    }
    lines.push('', 'Ready. Send a message to start.');
    await ctx.reply(lines.join('\n'));
  }

  private async cmdStatus(ctx: WeixinContext) {
    const d = await getStatusDataAsync(this, ctx.chatId);
    const lines = [
      `pikiclaw v${d.version}`,
      `Uptime: ${fmtUptime(d.uptime)}`,
      `PID: ${d.pid} | RSS: ${fmtBytes(d.memRss)} | Heap: ${fmtBytes(d.memHeap)}`,
      `Workdir: ${d.workdir}`,
      '',
      `Agent: ${d.agent}`,
      `Model: ${d.model || '-'}`,
      `Session: ${d.sessionId ? d.sessionId.slice(0, 16) : '(new)'}`,
      `Tasks: ${d.activeTasksCount}`,
    ];
    if (d.running) {
      lines.push(`Running: ${fmtUptime(Date.now() - d.running.startedAt)}`);
    }
    await ctx.reply(lines.join('\n'));
  }

  private async cmdHost(ctx: WeixinContext) {
    const d = getHostDataSync(this);
    const lines = [
      `Host: ${d.hostName}`,
      `CPU: ${d.cpuModel} x${d.cpuCount}`,
    ];
    if (d.cpuUsage) {
      lines.push(`CPU Usage: ${d.cpuUsage.usedPercent.toFixed(1)}% (user ${d.cpuUsage.userPercent.toFixed(1)}%, sys ${d.cpuUsage.sysPercent.toFixed(1)}%)`);
    }
    lines.push(
      `Memory: ${fmtBytes(d.memoryUsed)} / ${fmtBytes(d.totalMem)} (${d.memoryPercent.toFixed(0)}%)`,
      `Available: ${fmtBytes(d.memoryAvailable)}`,
    );
    if (d.battery) lines.push(`Battery: ${d.battery.percent} (${d.battery.state})`);
    if (d.disk) lines.push(`Disk: ${d.disk.used} / ${d.disk.total} (${d.disk.percent})`);
    lines.push(`Process: PID ${d.selfPid} | RSS ${fmtBytes(d.selfRss)} | Heap ${fmtBytes(d.selfHeap)}`);
    if (d.topProcs.length > 1) {
      lines.push('', 'Top Processes:');
      lines.push(...d.topProcs);
    }
    await ctx.reply(lines.join('\n'));
  }

  private async cmdAgent(ctx: WeixinContext, args: string) {
    if (!args) {
      const d = getAgentsListData(this, ctx.chatId);
      const lines = [`Current: ${d.currentAgent}`, ''];
      for (const a of d.agents) {
        const mark = a.isCurrent ? ' ←' : '';
        const ver = a.version ? ` (${a.version})` : '';
        lines.push(`${a.installed ? '✓' : '✗'} ${a.agent}${ver}${mark}`);
      }
      lines.push('', 'Usage: /agent codex|claude|gemini');
      await ctx.reply(lines.join('\n'));
      return;
    }
    try {
      const agent = normalizeAgent(args);
      this.switchAgentForChat(ctx.chatId, agent);
      await ctx.reply(`Agent switched to ${agent}.`);
    } catch {
      await ctx.reply('Unknown agent. Use: /agent codex|claude|gemini');
    }
  }

  private async cmdModels(ctx: WeixinContext, args: string) {
    const d = await getModelsListData(this, ctx.chatId);
    if (args) {
      const idx = parseInt(args, 10);
      let modelId: string | null = null;
      if (!isNaN(idx) && idx >= 1 && idx <= d.models.length) {
        modelId = d.models[idx - 1].id;
      } else {
        const match = d.models.find(m => m.id === args || m.alias === args);
        if (match) modelId = match.id;
      }
      if (modelId) {
        this.switchModelForChat(ctx.chatId, modelId);
        await ctx.reply(`Model switched to ${modelId}.`);
        return;
      }
      await ctx.reply(`Unknown model: ${args}`);
      return;
    }
    const lines = [`Current: ${d.currentModel}`, ''];
    d.models.forEach((m, i) => {
      const alias = m.alias ? ` (${m.alias})` : '';
      const mark = m.isCurrent ? ' ←' : '';
      lines.push(`${i + 1}. ${m.id}${alias}${mark}`);
    });
    if (d.effort) {
      lines.push('', `Effort: ${d.effort.current}`);
      for (const lv of d.effort.levels) {
        const mark = lv.isCurrent ? ' ←' : '';
        lines.push(`  ${lv.id} - ${lv.label}${mark}`);
      }
    }
    lines.push('', 'Usage: /models <name|number>');
    await ctx.reply(lines.join('\n'));
  }

  private async cmdMode(ctx: WeixinContext, args: string) {
    if (this.chat(ctx.chatId).agent !== 'claude') {
      await ctx.reply('Mode toggle is only available for Claude agent.');
      return;
    }
    const isPlan = this.agentConfigs.claude.permissionMode === 'plan';
    if (args === 'plan') {
      this.switchPermissionModeForChat(ctx.chatId, 'plan');
      await ctx.reply('Mode: Plan (read-only)');
    } else if (args === 'code') {
      this.switchPermissionModeForChat(ctx.chatId, 'bypassPermissions');
      await ctx.reply('Mode: Code (full access)');
    } else {
      await ctx.reply(`Current: ${isPlan ? 'Plan (read-only)' : 'Code (full access)'}\n\nUsage: /mode plan|code`);
    }
  }

  private async cmdSwitch(ctx: WeixinContext, args: string) {
    const wd = this.chatWorkdir(ctx.chatId);
    if (args) {
      const resolvedPath = path.resolve(args.replace(/^~/, process.env.HOME || os.homedir()));
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
        await ctx.reply(`Not a valid directory: ${resolvedPath}`);
        return;
      }
      const oldPath = this.switchWorkdir(resolvedPath);
      await ctx.reply(`Workdir switched:\n${oldPath}\n→ ${resolvedPath}`);
      return;
    }
    await ctx.reply(`Current workdir: ${wd}\n\nUsage: /switch <path>`);
  }

  private async cmdSessions(ctx: WeixinContext, args: string) {
    const arg = args.trim().toLowerCase();
    if (arg === 'new') {
      this.resetConversationForChat(ctx.chatId);
      await ctx.reply('Started a new session.');
      return;
    }
    const idx = parseInt(arg, 10);
    if (!isNaN(idx) && idx >= 1) {
      const d = await getSessionsPageData(this, ctx.chatId, 0, 100);
      const target = d.sessions[idx - 1];
      if (target) {
        const result = await this.fetchSessions(this.chat(ctx.chatId).agent, this.chatWorkdir(ctx.chatId));
        const session = result.sessions.find(s => s.sessionId === target.key);
        if (session) {
          this.adoptExistingSessionForChat(ctx.chatId, session);
          await ctx.reply(`Switched to session ${target.title}`);
        } else {
          await ctx.reply(`Session not found.`);
        }
        return;
      }
      await ctx.reply(`Session #${idx} not found.`);
      return;
    }
    const d = await getSessionsPageData(this, ctx.chatId, 0, 10);
    if (!d.sessions.length) {
      await ctx.reply('No sessions found.');
      return;
    }
    const lines = [`Sessions (${d.total}):`, ''];
    d.sessions.forEach((s, i) => {
      const mark = s.isCurrent ? ' ←' : '';
      const running = s.isRunning ? ' [running]' : '';
      lines.push(`${i + 1}. ${s.title} · ${s.time}${mark}${running}`);
    });
    lines.push('', 'Usage: /sessions new | /sessions <#>');
    await ctx.reply(lines.join('\n'));
  }

  private async cmdSkills(ctx: WeixinContext) {
    const d = getSkillsListData(this, ctx.chatId);
    if (!d.skills.length) {
      await ctx.reply('No project skills found.');
      return;
    }
    const lines = [`Skills (${d.agent}):`, ''];
    for (const s of d.skills) {
      const desc = s.description ? ` - ${s.description}` : '';
      lines.push(`/${s.command} (${s.label})${desc}`);
    }
    await ctx.reply(lines.join('\n'));
  }

  private async cmdStop(ctx: WeixinContext) {
    const session = this.selectedSession(ctx.chatId);
    if (!session) {
      await ctx.reply('No active session to stop.');
      return;
    }
    const { interrupted, cancelledQueued } = this.stopTasksForSession(session.key);
    if (!interrupted && cancelledQueued === 0) {
      await ctx.reply('No running or queued work for the current session.');
      return;
    }
    const parts: string[] = [];
    if (interrupted) parts.push('interrupted current run');
    if (cancelledQueued > 0) parts.push(`cancelled ${cancelledQueued} queued task(s)`);
    await ctx.reply(`Stopped: ${parts.join(', ')}.`);
  }

  private async cmdRestart(ctx: WeixinContext) {
    const activeTasks = getActiveTaskCount();
    if (activeTasks > 0) {
      await ctx.reply(formatActiveTaskRestartError(activeTasks));
      return;
    }
    await ctx.reply('Restarting pikiclaw...');
    void requestProcessRestart({ log: msg => this.log(msg) });
  }

  private createMcpSendFile(chatId: string): McpSendFileCallback {
    return async (filePath) => {
      try {
        await this.channel.send(chatId, `Artifact ready: ${path.basename(filePath)}\n${filePath}`);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    };
  }

  private async sendResult(chatId: string, result: StreamResult) {
    const text = result.ok
      ? (result.message.trim() || 'Task finished.')
      : ['Task failed.', result.error || result.message || 'Unknown error.'].filter(Boolean).join('\n');
    await this.channel.send(chatId, text);
  }

  private async handleMessage(msg: WeixinMessagePayload, ctx: WeixinContext) {
    const text = msg.text.trim();
    if (text.startsWith('/') && await this.handleCommand(text, ctx)) return;
    if (!text && !msg.files.length) {
      await ctx.reply('This Weixin channel currently supports text input only.');
      return;
    }

    const session = this.resolveSession(ctx.chatId, text, msg.files);
    const prompt = buildPrompt(text, msg.files);
    const taskId = buildSessionTaskId(session, this.nextTaskId++);
    this.beginTask({
      taskId,
      chatId: ctx.chatId,
      agent: session.agent,
      sessionKey: session.key,
      prompt,
      startedAt: Date.now(),
      sourceMessageId: ctx.messageId,
    });

    void this.queueSessionTask(session, async () => {
      const abortController = new AbortController();
      const task = this.markTaskRunning(taskId, () => abortController.abort());
      if (task?.cancelled) {
        this.finishTask(taskId);
        return;
      }

      let typingTimer: ReturnType<typeof setInterval> | null = null;
      try {
        await ctx.sendTyping().catch(() => {});
        typingTimer = setInterval(() => {
          void ctx.sendTyping().catch(() => {});
        }, 4_000);
        typingTimer.unref?.();

        const result = await this.runStream(
          prompt,
          session,
          msg.files,
          () => {},
          undefined,
          this.createMcpSendFile(ctx.chatId),
          abortController.signal,
        );
        await this.sendResult(ctx.chatId, result);
      } catch (error) {
        await ctx.reply(`Error: ${describeError(error)}`);
      } finally {
        if (typingTimer) clearInterval(typingTimer);
        this.finishTask(taskId);
        this.syncSelectedChats(session);
      }
    }).catch(error => {
      this.finishTask(taskId);
      this.log(`weixin queue execution failed: ${describeError(error)}`);
    });
  }

  async run() {
    const tmpDir = path.join(os.tmpdir(), 'pikiclaw');
    fs.mkdirSync(tmpDir, { recursive: true });

    this.channel = new WeixinChannel({
      token: this.botToken,
      accountId: this.accountId,
      baseUrl: this.baseUrl,
      allowedChatIds: this.allowedChatIds.size ? new Set([...this.allowedChatIds].map(value => String(value))) : undefined,
    });
    this.processRuntimeCleanup?.();
    this.processRuntimeCleanup = registerProcessRuntime({
      label: 'weixin',
      getActiveTaskCount: () => this.activeTasks.size,
      prepareForRestart: () => this.cleanupRuntimeForExit(),
    });
    this.installSignalHandlers();

    try {
      const bot = await this.channel.connect();
      this.connected = true;
      this.log(`bot: ${bot.displayName} (id=${bot.id})`);
      for (const agent of this.fetchAgents().agents) {
        this.log(`agent ${agent.agent}: ${agent.path || 'NOT FOUND'}`);
      }
      this.log(`config: agent=${this.defaultAgent} workdir=${this.workdir} timeout=${this.runTimeout}s`);

      this.channel.onMessage((msg, ctx) => this.handleMessage(msg, ctx));
      this.channel.onError(error => this.log(`error: ${describeError(error)}`));

      this.startKeepAlive();
      this.log('✓ Weixin connected, long-polling started — ready to receive messages');
      await this.channel.listen();
      this.stopKeepAlive();
      this.log('stopped');
    } finally {
      this.stopKeepAlive();
      this.clearShutdownForceExitTimer();
      this.removeSignalHandlers();
      this.processRuntimeCleanup?.();
      this.processRuntimeCleanup = null;
      if (this.shutdownInFlight) process.exit(this.shutdownExitCode ?? 1);
    }
  }
}
