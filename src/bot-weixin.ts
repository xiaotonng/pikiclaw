import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Bot,
  buildPrompt,
  fmtUptime,
  normalizeAgent,
  parseAllowedChatIds,
  type SessionRuntime,
  type StreamResult,
} from './bot.js';
import { BOT_SHUTDOWN_FORCE_EXIT_MS, buildSessionTaskId } from './bot-orchestration.js';
import { shutdownAllDrivers } from './agent-driver.js';
import type { McpSendFileCallback } from './mcp-bridge.js';
import { registerProcessRuntime } from './process-control.js';
import { WeixinChannel, type WeixinContext, type WeixinMessagePayload } from './channel-weixin.js';
import { getActiveUserConfig } from './user-config.js';

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

  private buildStatusText(chatId: string): string {
    const status = this.getStatusData(chatId);
    return [
      `Agent: ${status.agent}`,
      `Model: ${status.model || '-'}`,
      `Session: ${status.sessionId || 'new'}`,
      `Tasks: ${status.activeTasksCount}`,
      `Workdir: ${status.workdir}`,
      `Uptime: ${fmtUptime(status.uptime)}`,
    ].join('\n');
  }

  private async handleCommand(text: string, ctx: WeixinContext): Promise<boolean> {
    const [rawCommand, ...rest] = text.trim().slice(1).split(/\s+/);
    const command = rawCommand?.toLowerCase() || '';
    const args = rest.join(' ').trim();
    switch (command) {
      case 'help':
        await ctx.reply([
          '/help',
          '/new',
          '/status',
          '/agent codex|claude|gemini',
        ].join('\n'));
        return true;
      case 'new':
        this.resetConversationForChat(ctx.chatId);
        await ctx.reply('Started a new session.');
        return true;
      case 'status':
        await ctx.reply(this.buildStatusText(ctx.chatId));
        return true;
      case 'agent':
        if (!args) {
          await ctx.reply('Usage: /agent codex|claude|gemini');
          return true;
        }
        try {
          const agent = normalizeAgent(args);
          this.switchAgentForChat(ctx.chatId, agent);
          await ctx.reply(`Agent switched to ${agent}.`);
        } catch {
          await ctx.reply('Usage: /agent codex|claude|gemini');
        }
        return true;
      default:
        return false;
    }
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
