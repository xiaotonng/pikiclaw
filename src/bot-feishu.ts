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
import { spawn } from 'node:child_process';
import {
  Bot, VERSION, type Agent, type SessionRuntime, type StreamResult,
  fmtTokens, buildPrompt,
  parseAllowedChatIds, shellSplit,
} from './bot.js';
import {
  type BotArtifact,
  stageSessionFiles,
} from './code-agent.js';
import { shutdownAllDrivers } from './agent-driver.js';
import {
  buildDefaultMenuCommands,
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
} from './bot-commands.js';
import { LivePreview } from './bot-telegram-live-preview.js';
import {
  feishuPreviewRenderer,
  buildInitialPreviewMarkdown,
  buildFinalReplyRender,
  renderStart,
  renderSessionsPageCard,
  renderAgentsListCard,
  renderModelsListCard,
  renderStatus,
  renderHost,
} from './bot-feishu-render.js';
import { FeishuChannel, type FeishuContext, type FeishuCallbackContext, type FeishuMessage } from './channel-feishu.js';
import { splitText, supportsChannelCapability } from './channel-base.js';
import { getActiveUserConfig } from './user-config.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

const SHUTDOWN_EXIT_CODE: Record<ShutdownSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};
const SHUTDOWN_FORCE_EXIT_MS = 3_000;

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

  constructor() {
    super();
    const config = getActiveUserConfig();
    // Merge Feishu-specific allowed IDs into base
    if (process.env.FEISHU_ALLOWED_CHAT_IDS) {
      for (const id of parseAllowedChatIds(process.env.FEISHU_ALLOWED_CHAT_IDS)) this.allowedChatIds.add(id);
    }

    this.appId = String(config.feishuAppId || '').trim();
    this.appSecret = String(config.feishuAppSecret || '').trim();
    this.domain = (process.env.FEISHU_DOMAIN || 'https://open.feishu.cn').trim();

    if (!this.appId || !this.appSecret) {
      throw new Error('Missing Feishu credentials. Set FEISHU_APP_ID and FEISHU_APP_SECRET');
    }
  }

  protected override onManagedConfigChange(config: Record<string, any>, opts: { initial?: boolean } = {}) {
    const nextAppId = String(config.feishuAppId || '').trim();
    const nextAppSecret = String(config.feishuAppSecret || '').trim();
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

    try { this.channel.disconnect(); } catch {}
    this.stopKeepAlive();
    shutdownAllDrivers();

    if (this.shutdownForceExitTimer) clearTimeout(this.shutdownForceExitTimer);
    this.shutdownForceExitTimer = setTimeout(() => {
      this.log(`shutdown still pending after ${Math.floor(SHUTDOWN_FORCE_EXIT_MS / 1000)}s, forcing exit`);
      process.exit(this.shutdownExitCode ?? 1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    this.shutdownForceExitTimer.unref?.();
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

  private sessionsPageSize = 5;

  private async cmdSessions(ctx: FeishuContext, args: string) {
    const cs = this.chat(ctx.chatId);

    // Handle sub-commands: /sessions new, /sessions 3, /sessions p2
    const arg = args.trim().toLowerCase();
    if (arg === 'new') {
      this.resetChatConversation(cs);
      await ctx.reply('Session reset. Send a message to start.');
      return;
    }

    const res = await this.fetchSessions(cs.agent);
    if (!res.ok) { await ctx.reply(`Error: ${res.error}`); return; }
    if (!res.sessions.length) { await ctx.reply(`No ${cs.agent} sessions found in:\n\`${this.workdir}\``); return; }

    // Parse page number from "p2", "p3"
    let page = 0;
    const pageMatch = arg.match(/^p(\d+)$/);
    if (pageMatch) page = parseInt(pageMatch[1], 10) - 1;

    // Parse session index selection
    const idx = parseInt(arg, 10);
    if (!isNaN(idx) && idx >= 1) {
      const d = await getSessionsPageData(this, ctx.chatId, 0, 100);
      const target = d.sessions[idx - 1];
      if (target) {
        const session = res.sessions.find(s =>
          s.localSessionId === target.key || s.sessionId === target.key,
        );
        if (session) {
          this.adoptSession(cs, session);
          await ctx.reply(`Switched to session: \`${target.key.slice(0, 16)}\``);
          return;
        }
      }
      await ctx.reply(`Session #${idx} not found.`);
      return;
    }

    const d = await getSessionsPageData(this, ctx.chatId, page, this.sessionsPageSize);
    await ctx.channel.sendCard(ctx.chatId, renderSessionsPageCard(d));
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
    const cs = this.chat(ctx.chatId);
    const arg = args.trim().toLowerCase();

    // Switch agent by name
    if (arg) {
      try {
        const { normalizeAgent } = await import('./bot.js');
        const agent = normalizeAgent(arg);
        if (cs.agent === agent) {
          await ctx.reply(`Already using ${agent}.`);
          return;
        }
        cs.agent = agent;
        this.resetChatConversation(cs);
        this.log(`agent switched to ${agent} chat=${ctx.chatId}`);
        await ctx.reply(`**Switched to ${agent}**\n\nSession has been reset. Send a message to start.`);
        return;
      } catch {
        // Not a valid agent name — show list
      }
    }

    const d = getAgentsListData(this, ctx.chatId);
    await ctx.channel.sendCard(ctx.chatId, renderAgentsListCard(d));
  }

  private async cmdModels(ctx: FeishuContext, args: string) {
    const cs = this.chat(ctx.chatId);
    const arg = args.trim();

    // Switch model by ID or index
    if (arg) {
      const d = await getModelsListData(this, ctx.chatId);
      // Try by index
      const idx = parseInt(arg, 10);
      let modelId: string | null = null;
      if (!isNaN(idx) && idx >= 1 && idx <= d.models.length) {
        modelId = d.models[idx - 1].id;
      } else {
        // Try by ID
        const match = d.models.find(m => m.id === arg || m.alias === arg);
        if (match) modelId = match.id;
      }

      if (modelId) {
        const currentModel = this.modelForAgent(cs.agent);
        if (modelMatchesSelection(cs.agent, modelId, currentModel)) {
          await ctx.reply(`Already using ${modelId}.`);
          return;
        }
        this.setModelForAgent(cs.agent, modelId);
        this.resetChatConversation(cs);
        this.log(`model switched to ${modelId} for ${cs.agent} chat=${ctx.chatId}`);
        await ctx.reply(`**Model switched to \`${modelId}\`**\n\nAgent: ${cs.agent}\nSession has been reset.`);
        return;
      }
    }

    const d = await getModelsListData(this, ctx.chatId);
    await ctx.channel.sendCard(ctx.chatId, renderModelsListCard(d));
  }

  private async cmdSwitch(ctx: FeishuContext, args: string) {
    const arg = args.trim();
    if (!arg) {
      await ctx.reply(
        `**Current workdir:** \`${this.workdir}\`\n\n` +
        `To switch, reply: /switch /path/to/directory`,
      );
      return;
    }

    const resolvedPath = path.resolve(arg.replace(/^~/, process.env.HOME || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      await ctx.reply(`Not a valid directory: \`${resolvedPath}\``);
      return;
    }

    const oldPath = this.switchWorkdir(resolvedPath);
    await ctx.reply(`**Workdir switched**\n\n\`${oldPath}\`\n↓\n\`${resolvedPath}\``);
  }

  private async cmdRestart(ctx: FeishuContext) {
    if (this.activeTasks.size > 0) {
      await ctx.reply(`⚠ ${this.activeTasks.size} task(s) still running. Wait for them to finish or try again.`);
      return;
    }
    await ctx.reply('**Restarting codeclaw...**\n\nPulling latest version. The bot will be back shortly.');
    this.performRestart();
  }

  private performRestart() {
    this.log('restart: disconnecting...');
    this.channel.disconnect();
    this.stopKeepAlive();

    const restartCmd = process.env.CODECLAW_RESTART_CMD || 'npx --yes codeclaw@latest';
    const [bin, ...rawArgs] = shellSplit(restartCmd);
    const allArgs = [...rawArgs, ...process.argv.slice(2)];

    this.log(`restart: spawning \`${bin} ${allArgs.join(' ')}\``);
    const child = spawn(bin, allArgs, {
      stdio: 'inherit',
      detached: true,
      env: { ...process.env, npm_config_yes: process.env.npm_config_yes || 'true' },
    });
    child.unref();
    this.log(`restart: new process spawned (PID ${child.pid}), exiting...`);
    process.exit(0);
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
            localSessionId: session.localSessionId,
            sessionId: session.sessionId,
            title: msg.files[0],
          });
          session.workspacePath = staged.workspacePath;
          this.syncSelectedChats(session);
          if (!staged.importedFiles.length) throw new Error('no files persisted');
          this.log(`[handleMessage] staged files chat=${ctx.chatId} local_session=${staged.localSessionId} files=${staged.importedFiles.length}`);
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
    this.log(`[handleMessage] queued chat=${ctx.chatId} agent=${session.agent} session=${session.sessionId || '(new)'} prompt="${prompt.slice(0, 100)}" files=${files.length}`);

    // Send streaming card (CardKit typewriter effect) or fall back to regular card
    const placeholderId = await this.channel.sendStreamingCard(ctx.chatId, buildInitialPreviewMarkdown(session.agent));
    if (placeholderId) {
      this.registerSessionMessage(ctx.chatId, placeholderId, session);
      this.log(`[handleMessage] streaming card sent msg_id=${placeholderId}`);
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
          livePreview = new LivePreview({
            agent: session.agent,
            chatId: ctx.chatId,
            placeholderMessageId: placeholderId,
            channel: this.channel,
            renderer: feishuPreviewRenderer,
            streamEditIntervalMs: 300,  // CardKit streaming cards handle frequent updates well
            startTimeMs: start,
            canEditMessages: supportsChannelCapability(this.channel, 'editMessages'),
            canSendTyping: false,
            parseMode: 'Markdown',
            log: (message: string) => this.log(message),
          });
          livePreview.start();
        }

        const result = await this.runStream(prompt, session, files, (nextText, nextThinking, nextActivity = '', meta, plan) => {
          livePreview?.update(nextText, nextThinking, nextActivity, meta, plan);
        });
        await livePreview?.settle();

        // End streaming mode — finalize the card before sending final reply
        if (placeholderId) {
          const summary = result.message.slice(0, 80).replace(/\s+/g, ' ').trim() || 'Response complete.';
          await this.channel.endStreaming(placeholderId, summary);
        }

        const artifacts = result.artifacts || [];

        this.log(
          `[handleMessage] done agent=${session.agent} ok=${result.ok} elapsed=${result.elapsedS.toFixed(1)}s ` +
          `tokens=in:${fmtTokens(result.inputTokens)}/out:${fmtTokens(result.outputTokens)} artifacts=${artifacts.length}`,
        );

        if (artifacts.length && result.incomplete && result.message.trim()) {
          result.incomplete = false;
          this.log(`[handleMessage] suppressed incomplete flag: artifacts present`);
        }

        const finalReplyIds = await this.sendFinalReply(ctx, placeholderId, session.agent, result);
        this.registerSessionMessages(ctx.chatId, finalReplyIds, session);

        const artifactIds = await this.sendArtifacts(ctx, artifacts);
        this.registerSessionMessages(ctx.chatId, artifactIds, session);

        this.log(`[handleMessage] final reply sent to chat=${ctx.chatId}`);
      } catch (e: any) {
        const msgText = String(e?.message || e || 'Unknown error');
        this.log(`[handleMessage] task failed chat=${ctx.chatId} error=${msgText}`);
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

  private async sendArtifacts(ctx: FeishuContext, artifacts: BotArtifact[]): Promise<string[]> {
    const messageIds: string[] = [];
    for (const artifact of artifacts) {
      try {
        const sent = await this.channel.sendFile(ctx.chatId, artifact.filePath, {
          caption: artifact.caption,
          asPhoto: artifact.kind === 'photo',
        });
        if (sent) messageIds.push(sent);
      } catch (e) {
        this.log(`artifact upload failed for ${artifact.filename}: ${e}`);
        const sent = await this.channel.send(ctx.chatId, `Artifact upload failed: \`${artifact.filename}\``).catch(() => null);
        if (sent) messageIds.push(sent);
      }
    }
    return messageIds;
  }

  // ---- command router -------------------------------------------------------

  async handleCommand(cmd: string, args: string, ctx: FeishuContext) {
    try {
      switch (cmd) {
        case 'start':    await this.cmdStart(ctx); return;
        case 'sessions': await this.cmdSessions(ctx, args); return;
        case 'agents':   await this.cmdAgents(ctx, args); return;
        case 'models':   await this.cmdModels(ctx, args); return;
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

  // ---- callback handlers ----------------------------------------------------

  private async handleCallback(data: string, ctx: FeishuCallbackContext) {
    try {
      if (data.startsWith('ag:'))   return void await this.onAgentCallback(data.slice(3), ctx);
      if (data.startsWith('mod:'))  return void await this.onModelCallback(data.slice(4), ctx);
      if (data.startsWith('eff:'))  return void await this.onEffortCallback(data.slice(4), ctx);
      if (data.startsWith('sess:')) return void await this.onSessionCallback(data.slice(5), ctx);
      if (data.startsWith('sp:'))   return void await this.onSessionsPageCallback(data.slice(3), ctx);
    } catch (e: any) {
      this.log(`callback error: ${e}`);
    }
  }

  private async onAgentCallback(agent: string, ctx: FeishuCallbackContext) {
    const cs = this.chat(ctx.chatId);
    if (cs.agent === agent) return;
    cs.agent = agent as Agent;
    this.resetChatConversation(cs);
    this.log(`agent switched to ${agent} chat=${ctx.chatId}`);
    await ctx.editReply(ctx.messageId, `**Switched to ${agent}**\n\nSession has been reset. Send a message to start.`);
  }

  private async onModelCallback(modelId: string, ctx: FeishuCallbackContext) {
    const cs = this.chat(ctx.chatId);
    if (modelMatchesSelection(cs.agent, modelId, this.modelForAgent(cs.agent))) return;
    this.setModelForAgent(cs.agent, modelId);
    this.resetChatConversation(cs);
    this.log(`model switched to ${modelId} for ${cs.agent} chat=${ctx.chatId}`);
    await ctx.editReply(ctx.messageId, `**Model switched to \`${modelId}\`**\n\nAgent: ${cs.agent}\nSession has been reset.`);
  }

  private async onEffortCallback(effortId: string, ctx: FeishuCallbackContext) {
    const cs = this.chat(ctx.chatId);
    if (effortId === this.effortForAgent(cs.agent)) return;
    this.setEffortForAgent(cs.agent, effortId);
    this.log(`effort switched to ${effortId} for ${cs.agent} chat=${ctx.chatId}`);
    await ctx.editReply(ctx.messageId, `**Thinking effort set to \`${effortId}\`**\n\nAgent: ${cs.agent}\nTakes effect on next message.`);
  }

  private async onSessionCallback(sessionKey: string, ctx: FeishuCallbackContext) {
    const cs = this.chat(ctx.chatId);
    if (sessionKey === 'new') {
      this.resetChatConversation(cs);
      await ctx.editReply(ctx.messageId, 'Session reset. Send a message to start.');
      return;
    }
    const res = await this.fetchSessions(cs.agent);
    if (!res.ok) return;
    const session = res.sessions.find(s =>
      s.localSessionId === sessionKey || s.sessionId === sessionKey,
    );
    if (!session) return;
    this.adoptSession(cs, session);
    const displayId = session.localSessionId || session.sessionId || sessionKey;
    await ctx.editReply(ctx.messageId, `Switched to session: \`${displayId.slice(0, 16)}\``);
  }

  private async onSessionsPageCallback(pageStr: string, ctx: FeishuCallbackContext) {
    const page = parseInt(pageStr, 10);
    if (isNaN(page) || page < 0) return;
    const d = await getSessionsPageData(this, ctx.chatId, page, this.sessionsPageSize);
    await ctx.channel.editCard(ctx.chatId, ctx.messageId, renderSessionsPageCard(d));
  }

  // ---- lifecycle ------------------------------------------------------------

  async run() {
    const tmpDir = path.join(os.tmpdir(), 'codeclaw');
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
    this.installSignalHandlers();

    try {
      const bot = await this.channel.connect();
      this.log(`bot: ${bot.displayName} (id=${bot.id})`);

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
      this.log('WebSocket listening started');
      await this.channel.listen();
      this.stopKeepAlive();
      this.log('stopped');
    } finally {
      this.stopKeepAlive();
      if (this.shutdownForceExitTimer) clearTimeout(this.shutdownForceExitTimer);
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

    const text = `**${VERSION}** codeclaw is online.\nSend /start to get started.`;
    for (const cid of targets) {
      try {
        await this.channel.send(cid, text);
        this.log(`startup notice sent to chat=${cid}`);
      } catch (e) {
        this.log(`startup notice failed for chat=${cid}: ${e}`);
      }
    }
  }
}
