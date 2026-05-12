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
import {
  currentHumanLoopQuestion,
  type HumanLoopPromptState,
} from '../../bot/human-loop.js';
import {
  buildAgentsCommandView,
  buildModeCommandView,
  buildModelsCommandView,
  buildSessionsCommandView,
  buildSkillsCommandView,
  decodeCommandAction,
  encodeCommandAction,
  executeCommandAction,
  type CommandActionButton,
  type CommandActionResult,
  type CommandSelectionView,
} from '../../bot/command-ui.js';
import { BOT_SHUTDOWN_FORCE_EXIT_MS, buildSessionTaskId } from '../../bot/orchestration.js';
import { shutdownAllDrivers } from '../../agent/driver.js';
import { expandTilde } from '../../core/platform.js';
import type { McpSendFileCallback } from '../../agent/mcp/bridge.js';
import {
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
  getWorkspacesData,
  handleGoalCommand,
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

  public override requestStop(): void {
    super.requestStop();
    try { this.channel?.disconnect(); } catch {}
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

    // `/cancel` aborts any pending command-UI / im_ask_user prompt for this
    // chat. Special-cased before the auto-cancel below so a bare `/cancel`
    // doesn't get treated as the start of a new interactive command.
    if (command === 'cancel' || command === 'quit') {
      const pending = this.pendingHumanLoopPrompt(ctx.chatId);
      if (pending) {
        this.humanLoopCancel(pending.promptId, 'Cancelled by user.');
        await ctx.reply('已取消。');
      } else {
        await ctx.reply('没有正在等待的交互。');
      }
      return true;
    }

    // Auto-clear any stale picker before starting a new interactive command
    // so the user isn't trapped behind a forgotten `/agent` / `/models` etc.
    const pendingPrompt = this.pendingHumanLoopPrompt(ctx.chatId);
    if (pendingPrompt) {
      this.humanLoopCancel(pendingPrompt.promptId, 'Cancelled — new command issued.');
    }

    switch (command) {
      case 'help':
        await ctx.reply([
          '/help - Show commands',
          '/new - New session',
          '/status - Session status',
          '/host - Host system info',
          '/agent [codex|claude|gemini] - Switch agent (interactive when no arg)',
          '/models [name|#] - Switch model (interactive when no arg)',
          '/mode [plan|code] - Toggle plan mode (claude only)',
          '/switch [path] - Change workdir',
          '/workspaces [#] - Pick saved workspace',
          '/sessions [new|#] - List/switch sessions',
          '/skills - List & run project skills',
          '/cancel - Cancel an active interactive prompt',
          '/stop - Stop current task',
          '/restart - Restart pikiclaw',
        ].join('\n'));
        return true;
      case 'new': {
        this.resetConversationForChat(ctx.chatId);
        await ctx.reply('Started a new session.');
        return true;
      }
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
      case 'workspaces':
        await this.cmdWorkspaces(ctx, args);
        return true;
      case 'sessions':
        await this.cmdSessions(ctx, args);
        return true;
      case 'skills':
        await this.cmdSkills(ctx);
        return true;
      case 'goal':
        await this.cmdGoal(ctx, args);
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
    if (args) {
      // Power-user shortcut: `/agent claude` switches directly without the
      // interactive picker — same behaviour as before, preserved for muscle
      // memory and scripted flows.
      try {
        const agent = normalizeAgent(args);
        this.switchAgentForChat(ctx.chatId, agent);
        await ctx.reply(`Agent switched to ${agent}.`);
      } catch {
        await ctx.reply('Unknown agent. Use: /agent codex|claude|gemini');
      }
      return;
    }
    await this.runCommandUiLoop(ctx, () => buildAgentsCommandView(this, ctx.chatId));
  }

  private async cmdModels(ctx: WeixinContext, args: string) {
    if (args) {
      // Power-user shortcut: `/models <number|name>` switches directly. Skips
      // the multi-step picker (model + effort + Apply) used by the interactive
      // path; effort stays unchanged.
      const d = await getModelsListData(this, ctx.chatId);
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
    await this.runCommandUiLoop(ctx, () => buildModelsCommandView(this, ctx.chatId));
  }

  private async cmdMode(ctx: WeixinContext, args: string) {
    if (this.chat(ctx.chatId).agent !== 'claude') {
      await ctx.reply('Mode toggle is only available for Claude agent.');
      return;
    }
    if (args === 'plan') {
      this.switchPermissionModeForChat(ctx.chatId, 'plan');
      await ctx.reply('Mode: Plan (read-only)');
      return;
    }
    if (args === 'code') {
      this.switchPermissionModeForChat(ctx.chatId, 'bypassPermissions');
      await ctx.reply('Mode: Code (full access)');
      return;
    }
    await this.runCommandUiLoop(ctx, () => buildModeCommandView(this, ctx.chatId));
  }

  private async cmdSwitch(ctx: WeixinContext, args: string) {
    const wd = this.chatWorkdir(ctx.chatId);
    if (args) {
      const resolvedPath = path.resolve(expandTilde(args));
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
        await ctx.reply(`Not a valid directory: ${resolvedPath}`);
        return;
      }
      const oldPath = this.switchWorkdir(resolvedPath);
      await ctx.reply(`Workdir switched:\n${oldPath}\n→ ${resolvedPath}`);
      return;
    }
    const savedCount = getWorkspacesData(this, ctx.chatId).workspaces.length;
    const hint = savedCount > 0
      ? `\n\nTip: ${savedCount} saved workspace${savedCount === 1 ? '' : 's'} — use /workspaces to pick one.`
      : '';
    await ctx.reply(`Current workdir: ${wd}\n\nUsage: /switch <path>${hint}`);
  }

  private async cmdWorkspaces(ctx: WeixinContext, args: string) {
    const data = getWorkspacesData(this, ctx.chatId);
    if (data.workspaces.length === 0) {
      await ctx.reply(
        'No saved workspaces yet.\n\n' +
        'Add workspaces from the Dashboard (Sessions → Add Workspace), then use /workspaces to switch with one tap.\n\n' +
        'You can still browse the file system with /switch <path>.',
      );
      return;
    }

    const trimmed = args.trim();
    if (trimmed) {
      // Power-user shortcut: `/workspaces <#>` switches directly.
      const idx = parseInt(trimmed, 10);
      if (Number.isNaN(idx) || idx < 1 || idx > data.workspaces.length) {
        await ctx.reply(`Workspace #${trimmed} not found. Use /workspaces to list.`);
        return;
      }
      const ws = data.workspaces[idx - 1];
      if (!ws.exists) {
        await ctx.reply(`Workspace path is missing on disk:\n${ws.path}`);
        return;
      }
      const oldPath = this.switchWorkdir(ws.path);
      await ctx.reply(`Workdir switched:\n${oldPath}\n→ ${ws.path}`);
      return;
    }

    // Interactive picker — there is no `command-ui` builder for workspaces
    // (Telegram/Feishu render this via channel-local helpers), so we open a
    // tailored human-loop prompt here. Disabled rows for missing paths are
    // marked so users see them but can't pick.
    const taskId = `wxcmd-ws-${Date.now().toString(36)}`;
    const promptLines: string[] = [
      '【Workspaces】',
      `Current: ${data.currentWorkdir}`,
      '',
    ];
    const pickable: Array<{ index: number; ws: typeof data.workspaces[number] }> = [];
    data.workspaces.forEach((ws, i) => {
      const marker = ws.isCurrent ? '✓' : ws.exists ? ' ' : '⚠';
      promptLines.push(`${marker} ${i + 1}. ${ws.name}`);
      promptLines.push(`     ${ws.path}${!ws.exists ? '  [missing]' : ''}`);
      if (ws.exists && !ws.isCurrent) pickable.push({ index: i, ws });
    });
    if (!pickable.length) {
      promptLines.push('', 'No switchable workspaces (all current or missing).');
      await ctx.reply(promptLines.join('\n'));
      return;
    }
    promptLines.push('', '━━━━━━');
    pickable.forEach((p, i) => promptLines.push(`${i + 1}. ${p.ws.name} — ${p.ws.path}`));
    promptLines.push('', '回复编号选择,或回复 /cancel 取消');
    const promptText = promptLines.join('\n');

    const options = pickable.map(p => ({
      label: `${p.ws.name} — ${p.ws.path}`,
      description: null,
      value: `ws:${p.index}`,
    }));

    await new Promise<void>((resolve) => {
      const active = this.beginHumanLoopPrompt({
        taskId,
        chatId: ctx.chatId,
        title: 'Workspaces',
        hint: 'Reply with the option number to switch.',
        questions: [{
          id: 'pick',
          header: 'Workspaces',
          prompt: promptText,
          options,
          allowFreeform: false,
        }],
        resolveWith: (answers) => {
          const picked = answers['pick']?.[0] || '';
          if (!picked.startsWith('ws:')) return null;
          const idx = parseInt(picked.slice(3), 10);
          if (!Number.isFinite(idx) || idx < 0 || idx >= data.workspaces.length) return null;
          return { workspaceIndex: idx };
        },
      });

      void this.channel.send(ctx.chatId, promptText)
        .catch(err => this.log(`weixin /workspaces send failed: ${describeError(err)}`));

      active.result
        .then(async (resolved) => {
          const idx = (resolved as any)?.workspaceIndex;
          if (typeof idx !== 'number') { resolve(); return; }
          const ws = data.workspaces[idx];
          if (!ws?.exists) {
            await ctx.reply('Workspace path is missing on disk.');
            resolve(); return;
          }
          const oldPath = this.switchWorkdir(ws.path);
          await ctx.reply(`Workdir switched:\n${oldPath}\n→ ${ws.path}`);
          resolve();
        })
        .catch(() => resolve());
    });
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
      // Power-user shortcut: `/sessions <#>` jumps directly using the same
      // first-100 lookup the old text flow used.
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
    // Interactive list with pagination — `executeCommandAction` returns the
    // next page as a fresh view, so the loop re-renders without leaving.
    await this.runCommandUiLoop(ctx, () => buildSessionsCommandView(this, ctx.chatId, 0));
  }

  private async cmdSkills(ctx: WeixinContext) {
    await this.runCommandUiLoop(ctx, () => buildSkillsCommandView(this, ctx.chatId));
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

  private async cmdGoal(ctx: WeixinContext, args: string) {
    const reply = await handleGoalCommand(this, ctx.chatId, args);
    if (reply == null) {
      await ctx.reply('No session selected. Use /sessions to pick one first.');
      return;
    }
    await ctx.reply(reply);
  }

  private async cmdRestart(ctx: WeixinContext) {
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

  /**
   * Format a human-in-the-loop prompt as plain text for WeChat (no card / button
   * support on personal accounts). Options are numbered so the user can either
   * reply with the number or freeform text — both are routed back through the
   * same handler in `handleMessage`.
   */
  private formatHumanLoopPromptText(prompt: HumanLoopPromptState): string {
    const question = currentHumanLoopQuestion(prompt);
    const lines: string[] = [];
    lines.push(`【${prompt.title || 'Pikiclaw needs your input'}】`);
    if (prompt.hint) lines.push(prompt.hint);
    if (prompt.questions.length > 1) {
      lines.push(`(${prompt.currentIndex + 1}/${prompt.questions.length})`);
    }
    if (question) {
      lines.push('');
      lines.push(question.prompt);
      if (question.options && question.options.length) {
        lines.push('');
        question.options.forEach((opt, idx) => {
          lines.push(`${idx + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
        });
        lines.push('');
        lines.push('Reply with a number to pick an option, or type your own answer.');
      } else {
        lines.push('');
        lines.push('Reply with your answer.');
      }
    }
    return lines.join('\n');
  }

  protected override async renderInteractionPrompt(prompt: HumanLoopPromptState, chatId: string | number): Promise<void> {
    const text = this.formatHumanLoopPromptText(prompt);
    try {
      await this.channel.send(String(chatId), text);
    } catch (error) {
      this.log(`weixin renderInteractionPrompt failed: ${describeError(error)}`);
    }
  }

  /**
   * If the incoming text looks like an option number (e.g. "1", "2.", "③"),
   * resolve it against the current question's options. Otherwise return null
   * and let the freeform path take over.
   */
  private parseHumanLoopOptionPick(text: string, prompt: HumanLoopPromptState): string | null {
    const question = currentHumanLoopQuestion(prompt);
    if (!question?.options?.length) return null;
    const trimmed = text.replace(/[.。、)]\s*$/, '').trim();
    const match = trimmed.match(/^(\d+)$/);
    if (!match) return null;
    const idx = parseInt(match[1], 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > question.options.length) return null;
    const opt = question.options[idx - 1];
    return opt?.value || opt?.label || null;
  }

  // ---- Command-UI adapter (numbered-text fallback for non-card IMs) -------
  //
  // Telegram / Feishu render `CommandSelectionView` as tap-able button cards.
  // WeChat (personal accounts) can't render cards, so we flatten each view's
  // button rows into a numbered text prompt and let the user reply with a
  // digit. Re-uses the SAME `executeCommandAction` data layer — no parallel
  // logic — so `/agents` / `/models` / `/sessions` / `/skills` / `/mode`
  // behave identically across channels, just rendered differently.

  private decorateCommandButtonLabel(button: CommandActionButton): string {
    let label = button.label.trim();
    if (button.state === 'current' || button.primary) label += ' ✓';
    if (button.state === 'running') label += ' [running]';
    if (button.state === 'unavailable') label += ' [n/a]';
    return label;
  }

  /**
   * Render a `CommandSelectionView` as plain WeChat text: title + meta lines +
   * detailed item list (when present) + numbered button list. Always ends with
   * "回复编号选择" so the user knows what to do next.
   */
  private formatCommandViewText(view: CommandSelectionView, buttons: CommandActionButton[]): string {
    const lines: string[] = [];
    lines.push(`【${view.title}】`);
    if (view.detail) lines.push(view.detail);
    for (const meta of view.metaLines) lines.push(meta);
    if (view.items?.length) {
      lines.push('');
      for (const item of view.items) {
        const marker = item.state === 'current' ? '✓' : item.state === 'running' ? '⟳' : ' ';
        lines.push(`${marker} ${item.label}`);
        if (item.detail) lines.push(`   ${item.detail}`);
      }
    }
    if (buttons.length) {
      lines.push('');
      lines.push('━━━━━━');
      buttons.forEach((b, i) => lines.push(`${i + 1}. ${this.decorateCommandButtonLabel(b)}`));
      lines.push('', '回复编号选择,或回复 /cancel 取消');
    } else if (view.emptyText) {
      lines.push('', view.emptyText);
    } else if (view.helperText) {
      lines.push('', view.helperText);
    }
    return lines.join('\n');
  }

  private formatCommandNotice(notice: { title: string; value?: string | null; detail?: string | null }): string {
    const parts: string[] = [`【${notice.title}】`];
    if (notice.value) parts.push(notice.value);
    if (notice.detail) parts.push(notice.detail);
    return parts.join('\n');
  }

  /**
   * Open one prompt for a `CommandSelectionView` and resolve once the user
   * picks an option (or cancels). The picked CommandAction is executed via the
   * shared `executeCommandAction` so the side effects (state mutations,
   * notices) match every other channel exactly.
   */
  private async promptCommandView(ctx: WeixinContext, view: CommandSelectionView): Promise<CommandActionResult | null> {
    const buttons = view.rows.flat();
    if (!buttons.length) {
      await ctx.reply(this.formatCommandViewText(view, []));
      return null;
    }

    const taskId = `wxcmd-${Date.now().toString(36)}`;
    const promptText = this.formatCommandViewText(view, buttons);
    const options = buttons.map(button => ({
      label: this.decorateCommandButtonLabel(button),
      description: null,
      value: encodeCommandAction(button.action),
    }));

    return new Promise<CommandActionResult | null>((resolve) => {
      const active = this.beginHumanLoopPrompt({
        taskId,
        chatId: ctx.chatId,
        title: view.title,
        hint: view.helperText || null,
        questions: [{
          id: 'pick',
          header: view.title,
          prompt: promptText,
          options,
          allowFreeform: false,
        }],
        resolveWith: (answers) => {
          const picked = answers['pick']?.[0];
          if (!picked) return null;
          const action = decodeCommandAction(picked);
          return action ? { action } : null;
        },
      });

      void this.channel.send(ctx.chatId, promptText)
        .catch(err => this.log(`weixin command UI send failed: ${describeError(err)}`));

      active.result
        .then(async (resolved) => {
          const action = (resolved as any)?.action ?? null;
          if (!action) { resolve(null); return; }
          try {
            const result = await executeCommandAction(this, ctx.chatId, action);
            resolve(result);
          } catch (err) {
            this.log(`weixin executeCommandAction failed: ${describeError(err)}`);
            resolve(null);
          }
        })
        .catch(() => resolve(null));
    });
  }

  /**
   * Multi-step command flow driver. Some views (notably `/models`'s "select
   * model → set effort → Apply") return another `CommandSelectionView` from
   * `executeCommandAction` rather than a terminal notice; this loop keeps
   * re-prompting until we hit a notice / skill / noop / cancellation. Capped
   * at 12 iterations to guard against pathological loops.
   */
  private async runCommandUiLoop(ctx: WeixinContext, viewBuilder: () => Promise<CommandSelectionView> | CommandSelectionView): Promise<void> {
    let view: CommandSelectionView | null = await Promise.resolve(viewBuilder());
    let safety = 12;
    while (view && safety-- > 0) {
      const result = await this.promptCommandView(ctx, view);
      if (!result) return;
      switch (result.kind) {
        case 'view':
          view = result.view;
          continue;
        case 'notice':
          await ctx.reply(this.formatCommandNotice(result.notice));
          return;
        case 'skill':
          // Dispatch the resolved skill prompt back through the regular task
          // pipeline (same machinery as a typed message), so the agent picks
          // it up with the right session + workspace.
          await ctx.reply(`Running /${result.skillName}…`);
          await this.dispatchUserPrompt(ctx, result.prompt, []);
          return;
        case 'noop':
          await ctx.reply(result.message || '(no change)');
          return;
      }
    }
    if (safety <= 0) await ctx.reply('Command UI loop terminated (too many steps).');
  }

  /**
   * Submit a user-authored prompt through the same path `handleMessage` uses
   * for natural-language messages. Lets the command-UI loop forward a resolved
   * `/skill` expansion as if the user had typed it.
   */
  private async dispatchUserPrompt(ctx: WeixinContext, text: string, files: string[]): Promise<void> {
    const session = this.resolveSession(ctx.chatId, text, files);
    const prompt = buildPrompt(text, files);
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
      if (task?.cancelled) { this.finishTask(taskId); return; }
      try {
        const result = await this.runStream(
          prompt,
          session,
          files,
          () => {},
          undefined,
          this.createMcpSendFile(ctx.chatId),
          abortController.signal,
          this.createInteractionHandler(ctx.chatId, taskId, session.key),
        );
        await this.sendResult(ctx.chatId, result);
      } catch (error) {
        await ctx.reply(`Error: ${describeError(error)}`);
      } finally {
        this.finishTask(taskId);
        this.syncSelectedChats(session);
      }
    }, taskId).catch(error => {
      this.finishTask(taskId);
      this.log(`weixin queue execution failed: ${describeError(error)}`);
    });
  }

  private async handleMessage(msg: WeixinMessagePayload, ctx: WeixinContext) {
    const text = msg.text.trim();
    if (text.startsWith('/') && await this.handleCommand(text, ctx)) return;
    if (!text && !msg.files.length) {
      await ctx.reply('This Weixin channel currently supports text input only.');
      return;
    }

    // Active human-in-the-loop prompt takes priority — text-only replies are
    // routed back to the pending question (option-number pick OR freeform).
    const pendingPrompt = this.pendingHumanLoopPrompt(ctx.chatId);
    if (pendingPrompt && text && !msg.files.length) {
      const optionValue = this.parseHumanLoopOptionPick(text, pendingPrompt);
      const result = optionValue
        ? this.humanLoopSelectOption(pendingPrompt.promptId, optionValue)
        : this.humanLoopSubmitText(ctx.chatId, text);
      if (!result) {
        await ctx.reply('Could not record that answer. Please retry or wait for the agent.');
        return;
      }
      if (result.completed) {
        await ctx.reply('Answer submitted.');
      } else if (result.advanced) {
        const next = this.humanLoopPrompt(pendingPrompt.promptId);
        if (next) await this.channel.send(ctx.chatId, this.formatHumanLoopPromptText(next));
      } else {
        await ctx.reply('Answer recorded.');
      }
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
          this.createInteractionHandler(ctx.chatId, taskId, session.key),
        );
        await this.sendResult(ctx.chatId, result);
      } catch (error) {
        await ctx.reply(`Error: ${describeError(error)}`);
      } finally {
        if (typingTimer) clearInterval(typingTimer);
        this.finishTask(taskId);
        this.syncSelectedChats(session);
      }
    }, taskId).catch(error => {
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
      this.channel.onError(error => this.log(`error: ${describeError(error)}`, 'warn'));
      this.channel.onLog((msg, level) => this.log(msg, level));

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
