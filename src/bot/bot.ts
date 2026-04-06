/**
 * Shared Bot base class: chat state, session lifecycle, task queue, streaming bridge.
 *
 * Channel-agnostic. Subclassed per IM channel (see channels/telegram/bot.ts, etc.).
 */

import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { getActiveUserConfig, onUserConfigChange, resolveUserWorkdir, setUserWorkdir } from '../core/config/user-config.js';
import {
  doStream, ensureManagedSession, findManagedThreadSession, getUsage, initializeProjectSkills, listAgents, listModels, listSkills, stageSessionFiles,
  type Agent, type CodexCumulativeUsage, type StreamOpts, type StreamResult, type StreamPreviewMeta, type StreamPreviewPlan, type SessionInfo, type UsageResult,
  type CodexInteractionRequest, type CodexTurnControl,
  type ModelInfo, type ModelListResult, type TailMessage, type SessionTailResult,
  type SkillInfo, type SkillListResult, type AgentDetectOptions, isPendingSessionId,
  type SessionClassification, type SessionMessagesOpts, type SessionMessagesResult,
} from '../agent/index.js';
import {
  querySessions, querySessionTail, updateSession,
  type SessionQueryResult,
} from './session-hub.js';
import { getDriver, hasDriver, allDriverIds } from '../agent/driver.js';
import { resolveGuiIntegrationConfig } from '../agent/mcp/bridge.js';
import { terminateProcessTree } from '../core/process-control.js';
import { VERSION } from '../core/version.js';
import {
  type HumanLoopPromptState, type HumanLoopQuestion,
  buildHumanLoopResponse, createEmptyHumanLoopAnswer, currentHumanLoopQuestion,
  isHumanLoopAwaitingText, setHumanLoopOption, setHumanLoopText, skipHumanLoopQuestion,
} from './human-loop.js';
import { writeScopedLog, type LogLevel } from '../core/logging.js';
import {
  resolveAgentEffort,
  resolveAgentModel,
} from '../core/config/runtime-config.js';
import {
  envBool, envString, envInt, shellSplit, whichSync,
  fmtTokens, fmtUptime, fmtBytes,
  parseAllowedChatIds, listSubdirs,
  extractThinkingTail, formatThinkingForDisplay,
  buildPrompt, ensureGitignore,
  type ChatId,
} from '../core/utils.js';
import {
  getHostBatteryData, getHostCpuUsageData, getHostDisplayName, getHostMemoryUsageData,
  type HostBatteryData, type HostCpuUsageData, type HostMemoryUsageData,
} from './host.js';

export { updateSession, type Agent, type CodexCumulativeUsage, type StreamResult, type StreamPreviewMeta, type StreamPreviewPlan, type SessionInfo, type UsageResult, type ModelInfo, type ModelListResult, type TailMessage, type SessionTailResult, type SkillInfo, type SkillListResult, type SessionClassification, type SessionMessagesOpts, type SessionMessagesResult, type SessionQueryResult };
export { envBool, envString, envInt, shellSplit, whichSync, fmtTokens, fmtUptime, fmtBytes, parseAllowedChatIds, listSubdirs, extractThinkingTail, formatThinkingForDisplay, buildPrompt, ensureGitignore, type ChatId } from '../core/utils.js';
export { getHostBatteryData, getHostCpuUsageData, getHostDisplayName, getHostMemoryUsageData, type HostBatteryData, type HostCpuUsageData, type HostMemoryUsageData } from './host.js';
import { BOT_TIMEOUTS } from '../core/constants.js';

export const DEFAULT_RUN_TIMEOUT_S = BOT_TIMEOUTS.defaultRunTimeoutS;
const MACOS_USER_ACTIVITY_PULSE_INTERVAL_MS = BOT_TIMEOUTS.macosUserActivityPulseInterval;
const MACOS_USER_ACTIVITY_PULSE_TIMEOUT_S = BOT_TIMEOUTS.macosUserActivityPulseTimeoutS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeAgent(raw: string): Agent {
  const v = raw.trim().toLowerCase();
  if (!hasDriver(v)) throw new Error(`Invalid agent: ${v}. Use: ${allDriverIds().join(', ')}`);
  return v;
}

export function thinkLabel(agent: Agent): string {
  try { return getDriver(agent).thinkLabel; } catch { return 'Thinking'; }
}

function appendExtraPrompt(base: string | undefined, extra: string): string {
  const lhs = String(base || '').trim();
  const rhs = String(extra || '').trim();
  if (!lhs) return rhs;
  if (!rhs) return lhs;
  return `${lhs}\n\n${rhs}`;
}

function buildMcpDeliveryPrompt(): string {
  return [
    '[Artifact Return]',
    'This is an IM conversation, so pay attention to the IM tools.',
  ].join('\n');
}

function buildBrowserAutomationPrompt(browserEnabled: boolean): string {
  if (!browserEnabled) {
    return [
      '[Browser Automation]',
      'Managed browser automation is disabled by default for this session.',
      process.platform === 'darwin'
        ? 'On macOS, operate your main browser directly with native commands such as open, osascript, and screencapture when needed.'
        : 'Use native OS or browser commands directly when browser automation is not enabled.',
    ].join('\n');
  }
  return [
    '[Browser Automation]',
    'A Playwright MCP browser server is already configured to use the local Chrome channel with a persistent profile.',
    'Do not call browser_install unless a browser tool explicitly reports that Chrome or the browser is missing.',
    'If you need a new tab, use browser_tabs with action="new".',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// ChatState
// ---------------------------------------------------------------------------

export interface ChatState {
  agent: Agent;
  sessionId: string | null;
  workspacePath?: string | null;
  codexCumulative?: CodexCumulativeUsage;
  modelId?: string | null;
  activeSessionKey?: string | null;
  activeThreadId?: string | null;
  /** Per-chat workdir override; null = use global bot.workdir. */
  workdir?: string | null;
}

export interface SessionRuntime {
  key: string;
  workdir: string;
  agent: Agent;
  sessionId: string | null;
  workspacePath: string | null;
  threadId: string | null;
  codexCumulative?: CodexCumulativeUsage;
  modelId?: string | null;
  thinkingEffort?: string | null;
  runningTaskIds: Set<string>;
}

/** Events emitted to dashboard listeners during a stream. */
export type StreamEvent =
  | { type: 'start'; taskId: string; agent: string; sessionId: string | null }
  | { type: 'text'; text: string; thinking: string; activity?: string; plan?: StreamPreviewPlan | null }
  | { type: 'done'; taskId: string; sessionId: string | null; error?: string }
  | { type: 'queued'; taskId: string; position: number }
  | { type: 'cancelled'; taskId: string };

/** Snapshot of the latest streaming state for a session (used by polling endpoint). */
export interface StreamSnapshot {
  phase: 'queued' | 'streaming' | 'done';
  taskId: string;
  queuedTaskId?: string;
  text?: string;
  thinking?: string;
  activity?: string;
  plan?: StreamPreviewPlan | null;
  sessionId?: string | null;
  error?: string;
  updatedAt: number;
}

export interface RunningTask {
  taskId: string;
  actionId?: string;
  chatId: ChatId;
  agent: Agent;
  sessionKey: string;
  prompt: string;
  attachments?: string[];
  startedAt: number;
  sourceMessageId: number | string;
  status?: 'queued' | 'running';
  cancelled?: boolean;
  abort?: (() => void) | null;
  steer?: ((prompt: string, attachments?: string[]) => Promise<boolean>) | null;
  freezePreviewOnAbort?: boolean;
  placeholderMessageIds?: Array<number | string>;
}

export interface BeginHumanLoopPromptOpts {
  taskId: string;
  chatId: ChatId;
  title: string;
  detail?: string | null;
  hint?: string | null;
  questions: HumanLoopQuestion[];
  resolveWith: (answers: Record<string, string[]>) => Record<string, any> | null;
}

export interface ActiveHumanLoopPrompt {
  prompt: HumanLoopPromptState<ChatId>;
  result: Promise<Record<string, any> | null>;
}

export interface SubmitSessionTaskOpts {
  agent: Agent;
  sessionId: string;
  workdir: string;
  prompt: string;
  attachments?: string[];
  modelId?: string | null;
  thinkingEffort?: string | null;
  sourceMessageId?: number | string;
  chatId?: ChatId;
  onText?: (
    text: string,
    thinking: string,
    activity?: string,
    meta?: StreamPreviewMeta,
    plan?: StreamPreviewPlan | null,
  ) => void;
}

export interface SubmittedSessionTask {
  ok: true;
  taskId: string;
  sessionKey: string;
  queued: true;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class Bot {
  workdir: string;
  defaultAgent: Agent;
  runTimeout: number;
  allowedChatIds: Set<ChatId>;

  // Per-agent config — keyed by agent id
  agentConfigs: Record<string, Record<string, any>> = {};

  // Convenience accessors (backward-compat)
  get codexModel(): string { return this.agentConfigs.codex?.model || ''; }
  set codexModel(v: string) { this.agentConfigs.codex.model = v; }
  get codexReasoningEffort(): string { return this.agentConfigs.codex?.reasoningEffort || 'xhigh'; }
  set codexReasoningEffort(v: string) { this.agentConfigs.codex.reasoningEffort = v; }
  get codexFullAccess(): boolean { return this.agentConfigs.codex?.fullAccess ?? true; }
  get codexExtraArgs(): string[] { return this.agentConfigs.codex?.extraArgs || []; }
  get claudeModel(): string { return this.agentConfigs.claude?.model || ''; }
  set claudeModel(v: string) { this.agentConfigs.claude.model = v; }
  get claudePermissionMode(): string { return this.agentConfigs.claude?.permissionMode || 'bypassPermissions'; }
  get claudeExtraArgs(): string[] { return this.agentConfigs.claude?.extraArgs || []; }
  get geminiApprovalMode(): string { return this.agentConfigs.gemini?.approvalMode || 'yolo'; }
  get geminiSandbox(): boolean { return this.agentConfigs.gemini?.sandbox ?? false; }
  get geminiExtraArgs(): string[] { return this.agentConfigs.gemini?.extraArgs || []; }

  chats = new Map<ChatId, ChatState>();
  sessionStates = new Map<string, SessionRuntime>();
  activeTasks = new Map<string, RunningTask>();
  startedAt = Date.now();
  connected = false;
  stats = { totalTurns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0 };

  /* ── Dashboard stream state (polling-friendly snapshots) ── */
  private streamSnapshots = new Map<string, StreamSnapshot>();
  private snapshotCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Get the current streaming snapshot for a session (used by polling endpoint). */
  getStreamSnapshot(sessionKey: string): StreamSnapshot | null {
    return this.streamSnapshots.get(sessionKey) ?? null;
  }

  /* ── Dashboard SSE push (injected by dashboard layer to avoid circular import) ── */
  private _onStreamSnapshot: ((sessionKey: string, snapshot: StreamSnapshot | null) => void) | null = null;
  private streamPushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private streamPushPending = new Map<string, boolean>();

  /** Called by the dashboard layer to subscribe to stream snapshot changes. */
  onStreamSnapshot(cb: (sessionKey: string, snapshot: StreamSnapshot | null) => void): void {
    this._onStreamSnapshot = cb;
  }

  private pushSnapshotToSSE(sessionKey: string, immediate: boolean) {
    if (!this._onStreamSnapshot) return;
    const snap = this.streamSnapshots.get(sessionKey) ?? null;
    const emit = () => this._onStreamSnapshot!(sessionKey, snap ? { ...snap } : null);
    if (immediate) {
      const timer = this.streamPushTimers.get(sessionKey);
      if (timer) { clearTimeout(timer); this.streamPushTimers.delete(sessionKey); }
      this.streamPushPending.delete(sessionKey);
      emit();
    } else {
      // Coalesce: if a timer is pending, just mark dirty
      this.streamPushPending.set(sessionKey, true);
      if (this.streamPushTimers.has(sessionKey)) return;
      this.streamPushTimers.set(sessionKey, setTimeout(() => {
        this.streamPushTimers.delete(sessionKey);
        if (this.streamPushPending.get(sessionKey)) {
          this.streamPushPending.delete(sessionKey);
          emit();
        }
      }, 200));
    }
  }

  /** Emit a streaming event — updates the polling snapshot. */
  emitStream(sessionKey: string, event: StreamEvent) {
    // Clear any pending cleanup timer
    const pending = this.snapshotCleanupTimers.get(sessionKey);
    if (pending) { clearTimeout(pending); this.snapshotCleanupTimers.delete(sessionKey); }

    const now = Date.now();
    switch (event.type) {
      case 'queued': {
        const existing = this.streamSnapshots.get(sessionKey);
        if (existing && (existing.phase === 'streaming' || existing.phase === 'done')) {
          // Don't overwrite active stream — annotate with queued task info
          existing.queuedTaskId = event.taskId;
          existing.updatedAt = now;
        } else {
          this.streamSnapshots.set(sessionKey, { phase: 'queued', taskId: event.taskId, updatedAt: now });
        }
        break;
      }
      case 'start':
        this.streamSnapshots.set(sessionKey, {
          phase: 'streaming', taskId: event.taskId,
          text: '', thinking: '', activity: '', plan: null, sessionId: event.sessionId, updatedAt: now,
        });
        break;
      case 'text': {
        const snap = this.streamSnapshots.get(sessionKey);
        if (snap) {
          snap.text = event.text;
          snap.thinking = event.thinking;
          snap.activity = event.activity;
          snap.plan = event.plan?.steps?.length ? event.plan : null;
          snap.updatedAt = now;
        }
        break;
      }
      case 'done': {
        const prev = this.streamSnapshots.get(sessionKey);
        this.streamSnapshots.set(sessionKey, {
          phase: 'done',
          taskId: event.taskId,
          sessionId: event.sessionId,
          text: prev?.text || '',
          thinking: prev?.thinking || '',
          activity: prev?.activity || '',
          error: event.error,
          plan: prev?.plan ?? null,
          queuedTaskId: prev?.queuedTaskId,
          updatedAt: now,
        });
        // Auto-clean 'done' snapshot after 10s so stale state doesn't linger
        this.snapshotCleanupTimers.set(sessionKey, setTimeout(() => {
          this.streamSnapshots.delete(sessionKey);
          this.snapshotCleanupTimers.delete(sessionKey);
        }, 10_000));
        break;
      }
      case 'cancelled': {
        const snap = this.streamSnapshots.get(sessionKey);
        if (snap && snap.queuedTaskId === event.taskId) {
          // Cancelled the queued task — keep the running/done snapshot
          delete snap.queuedTaskId;
        } else {
          this.streamSnapshots.delete(sessionKey);
        }
        break;
      }
    }

    // Push to dashboard SSE — throttle text events, push everything else immediately
    try {
      this.pushSnapshotToSSE(sessionKey, event.type !== 'text');
    } catch { /* dashboard not loaded yet — ignore */ }
  }

  private keepAliveProc: ReturnType<typeof spawn> | null = null;
  private keepAlivePulseTimer: ReturnType<typeof setInterval> | null = null;
  private sessionChains = new Map<string, Promise<void>>();
  private userConfigUnsubscribe: (() => void) | null = null;
  private taskKeysBySourceMessage = new Map<string, string>();
  private taskKeysByActionId = new Map<string, string>();
  private withdrawnSourceMessages = new Set<string>();
  private nextTaskActionId = 1;
  private humanLoopPrompts = new Map<string, HumanLoopPromptState<ChatId>>();
  private humanLoopPromptIdsByChat = new Map<string, string[]>();
  private nextHumanLoopPromptId = 1;

  constructor() {
    this.workdir = resolveUserWorkdir();
    ensureGitignore(this.workdir);
    initializeProjectSkills(this.workdir);
    const config = getActiveUserConfig();

    // Initialize per-agent configs
    this.agentConfigs = {
      codex: {
        model: resolveAgentModel(config, 'codex'),
        reasoningEffort: resolveAgentEffort(config, 'codex') || 'xhigh',
        fullAccess: envBool('CODEX_FULL_ACCESS', true),
        extraArgs: shellSplit(process.env.CODEX_EXTRA_ARGS || ''),
      },
      claude: {
        model: resolveAgentModel(config, 'claude'),
        reasoningEffort: resolveAgentEffort(config, 'claude') || 'high',
        permissionMode: (process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions').trim(),
        extraArgs: shellSplit(process.env.CLAUDE_EXTRA_ARGS || ''),
      },
      gemini: {
        model: resolveAgentModel(config, 'gemini'),
        approvalMode: envString('GEMINI_APPROVAL_MODE', 'yolo'),
        sandbox: envBool('GEMINI_SANDBOX', false),
        extraArgs: shellSplit(process.env.GEMINI_EXTRA_ARGS || ''),
      },
    };

    this.defaultAgent = normalizeAgent('codex');
    this.runTimeout = envInt('PIKICLAW_TIMEOUT', DEFAULT_RUN_TIMEOUT_S);
    this.allowedChatIds = parseAllowedChatIds(process.env.PIKICLAW_ALLOWED_IDS || '');
    this.refreshManagedConfig(getActiveUserConfig(), { initial: true });
    this.userConfigUnsubscribe = onUserConfigChange(config => this.refreshManagedConfig(config));
  }

  log(msg: string, level: LogLevel = 'info') {
    writeScopedLog('pikiclaw', msg, { level });
  }

  debug(msg: string) {
    this.log(msg, 'debug');
  }

  warn(msg: string) {
    this.log(msg, 'warn');
  }

  error(msg: string) {
    this.log(msg, 'error');
  }

  chat(chatId: ChatId): ChatState {
    let s = this.chats.get(chatId);
    if (!s) { s = { agent: this.defaultAgent, sessionId: null, activeSessionKey: null, activeThreadId: null, modelId: null }; this.chats.set(chatId, s); }
    return s;
  }

  /** Effective workdir for a chat — per-chat override or global fallback. */
  chatWorkdir(chatId: ChatId): string {
    return this.chats.get(chatId)?.workdir || this.workdir;
  }

  protected sessionKey(agent: Agent, sessionId: string): string {
    return `${agent}:${sessionId}`;
  }

  protected getSessionRuntimeByKey(sessionKey: string | null | undefined, opts: { allowAnyWorkdir?: boolean } = {}): SessionRuntime | null {
    if (!sessionKey) return null;
    const runtime = this.sessionStates.get(sessionKey) || null;
    if (!runtime) return null;
    if (!opts.allowAnyWorkdir && runtime.workdir !== this.workdir) return null;
    return runtime;
  }

  protected getSelectedSession(cs: ChatState): SessionRuntime | null {
    return this.getSessionRuntimeByKey(cs.activeSessionKey, { allowAnyWorkdir: true });
  }

  protected hydrateSessionRuntime(session: {
    agent: Agent;
    sessionId: string | null;
    workdir?: string | null;
    workspacePath?: string | null;
    threadId?: string | null;
    codexCumulative?: CodexCumulativeUsage;
    modelId?: string | null;
    thinkingEffort?: string | null;
  }): SessionRuntime | null {
    if (!session.sessionId) return null;
    return this.upsertSessionRuntime({
      agent: session.agent,
      sessionId: session.sessionId,
      workdir: session.workdir || this.workdir,
      workspacePath: session.workspacePath ?? null,
      threadId: session.threadId ?? null,
      codexCumulative: session.codexCumulative,
      modelId: session.modelId ?? null,
      thinkingEffort: session.thinkingEffort ?? null,
    });
  }

  protected upsertSessionRuntime(session: {
    agent: Agent;
    sessionId: string;
    workspacePath?: string | null;
    threadId?: string | null;
    codexCumulative?: CodexCumulativeUsage;
    modelId?: string | null;
    thinkingEffort?: string | null;
    workdir?: string;
  }): SessionRuntime {
    const workdir = path.resolve(session.workdir || this.workdir);
    const key = this.sessionKey(session.agent, session.sessionId);
    const existing = this.sessionStates.get(key);
    if (existing) {
      existing.workdir = workdir;
      existing.agent = session.agent;
      existing.sessionId = session.sessionId;
      if (session.workspacePath !== undefined) existing.workspacePath = session.workspacePath ?? null;
      if (session.threadId !== undefined) existing.threadId = session.threadId ?? null;
      if (session.codexCumulative !== undefined) existing.codexCumulative = session.codexCumulative;
      if (session.modelId !== undefined) existing.modelId = session.modelId ?? null;
      if (session.thinkingEffort !== undefined) existing.thinkingEffort = session.thinkingEffort ?? null;
      return existing;
    }

    const runtime: SessionRuntime = {
      key,
      workdir,
      agent: session.agent,
      sessionId: session.sessionId,
      workspacePath: session.workspacePath ?? null,
      threadId: session.threadId ?? null,
      codexCumulative: session.codexCumulative,
      modelId: session.modelId ?? null,
      thinkingEffort: session.thinkingEffort ?? null,
      runningTaskIds: new Set<string>(),
    };
    this.sessionStates.set(key, runtime);
    return runtime;
  }

  protected applySessionSelection(cs: ChatState, session: SessionRuntime | null, opts: { preserveThread?: boolean } = {}) {
    const previousSessionKey = cs.activeSessionKey ?? null;
    cs.activeSessionKey = session?.key ?? null;
    if (session) {
      cs.agent = session.agent;
      cs.sessionId = session.sessionId;
      cs.workspacePath = session.workspacePath;
      cs.activeThreadId = session.threadId;
      cs.codexCumulative = session.codexCumulative;
      cs.modelId = session.modelId ?? null;
      cs.workdir = session.workdir;
      if (previousSessionKey && previousSessionKey !== session.key) this.maybeEvictSessionRuntime(previousSessionKey);
      return;
    }
    cs.sessionId = null;
    cs.workspacePath = null;
    if (!opts.preserveThread) cs.activeThreadId = null;
    cs.codexCumulative = undefined;
    cs.modelId = null;
    if (previousSessionKey) this.maybeEvictSessionRuntime(previousSessionKey);
  }

  protected resetChatConversation(cs: ChatState, opts?: { clearWorkdir?: boolean; clearThread?: boolean }) {
    this.applySessionSelection(cs, null, { preserveThread: opts?.clearThread === false });
    if (opts?.clearWorkdir) cs.workdir = null;
  }

  protected adoptSession(cs: ChatState, session: Pick<SessionInfo, 'agent' | 'sessionId' | 'workdir' | 'workspacePath' | 'model' | 'title' | 'threadId'>) {
    if (!session.sessionId) {
      this.applySessionSelection(cs, null);
      return;
    }
    const managed = ensureManagedSession({
      agent: session.agent,
      sessionId: session.sessionId,
      workdir: 'workdir' in session && session.workdir ? session.workdir : this.workdir,
      title: session.title ?? null,
      model: session.model ?? null,
      threadId: session.threadId ?? null,
    });
    const runtime = this.hydrateSessionRuntime({
      agent: session.agent,
      sessionId: session.sessionId,
      workdir: 'workdir' in session ? session.workdir : null,
      workspacePath: managed.workspacePath ?? session.workspacePath ?? null,
      threadId: managed.threadId ?? session.threadId ?? null,
      modelId: session.model ?? managed.model ?? null,
    });
    if (!runtime) {
      this.applySessionSelection(cs, null);
      return;
    }
    this.applySessionSelection(cs, runtime);
  }

  protected syncSelectedChats(session: SessionRuntime) {
    for (const [, cs] of this.chats) {
      if (cs.activeSessionKey !== session.key) continue;
      this.applySessionSelection(cs, session);
    }
  }

  protected moveSessionStreamSnapshot(previousKey: string, nextKey: string) {
    if (!previousKey || !nextKey || previousKey === nextKey) return;

    const previousSnapshot = this.streamSnapshots.get(previousKey) || null;
    const nextSnapshot = this.streamSnapshots.get(nextKey) || null;
    const mergedSnapshot = previousSnapshot && (
      !nextSnapshot || previousSnapshot.updatedAt >= nextSnapshot.updatedAt
    )
      ? previousSnapshot
      : nextSnapshot;

    this.streamSnapshots.delete(previousKey);
    if (mergedSnapshot) this.streamSnapshots.set(nextKey, mergedSnapshot);

    const previousTimer = this.snapshotCleanupTimers.get(previousKey);
    if (previousTimer) {
      clearTimeout(previousTimer);
      this.snapshotCleanupTimers.delete(previousKey);
      if (mergedSnapshot?.phase === 'done') {
        this.snapshotCleanupTimers.set(nextKey, setTimeout(() => {
          this.streamSnapshots.delete(nextKey);
          this.snapshotCleanupTimers.delete(nextKey);
        }, 10_000));
      }
    }
  }

  protected promoteSessionRuntime(session: SessionRuntime, nextSessionId: string): SessionRuntime {
    const resolvedSessionId = nextSessionId.trim();
    if (!resolvedSessionId || session.sessionId === resolvedSessionId) return session;

    const previousKey = session.key;
    const previousSessionId = session.sessionId;
    const nextKey = this.sessionKey(session.agent, resolvedSessionId);
    const existing = this.sessionStates.get(nextKey);

    if (existing && existing !== session) {
      session.workspacePath = session.workspacePath ?? existing.workspacePath;
      session.threadId = session.threadId ?? existing.threadId;
      session.codexCumulative = session.codexCumulative ?? existing.codexCumulative;
      session.modelId = session.modelId ?? existing.modelId ?? null;
      session.thinkingEffort = session.thinkingEffort ?? existing.thinkingEffort ?? null;
      for (const taskId of existing.runningTaskIds) session.runningTaskIds.add(taskId);
    }

    this.sessionStates.delete(previousKey);
    this.sessionStates.delete(nextKey);
    session.sessionId = resolvedSessionId;
    session.key = nextKey;
    this.sessionStates.set(nextKey, session);

    for (const [, task] of this.activeTasks) {
      if (task.sessionKey === previousKey) task.sessionKey = nextKey;
    }

    const previousChain = this.sessionChains.get(previousKey);
    const nextChain = this.sessionChains.get(nextKey);
    if (previousChain) this.sessionChains.delete(previousKey);
    if (previousChain || nextChain) {
      const mergedChain = previousChain && nextChain && previousChain !== nextChain
        ? Promise.allSettled([previousChain, nextChain]).then(() => {})
        : (previousChain || nextChain)!;
      this.sessionChains.set(nextKey, mergedChain);
    }

    this.moveSessionStreamSnapshot(previousKey, nextKey);

    for (const [, cs] of this.chats) {
      const matchesPreviousSelection = cs.activeSessionKey === previousKey;
      const matchesNextSelection = cs.activeSessionKey === nextKey;
      const matchesSessionId = cs.agent === session.agent && (
        (previousSessionId ? cs.sessionId === previousSessionId : false)
        || cs.sessionId === resolvedSessionId
      );
      if (!matchesPreviousSelection && !matchesNextSelection && !matchesSessionId) continue;
      this.applySessionSelection(cs, session);
    }

    return session;
  }

  protected isSessionSelected(sessionKey: string | null | undefined): boolean {
    if (!sessionKey) return false;
    for (const [, cs] of this.chats) {
      if (cs.activeSessionKey === sessionKey) return true;
    }
    return false;
  }

  protected maybeEvictSessionRuntime(sessionKey: string | null | undefined) {
    const session = this.getSessionRuntimeByKey(sessionKey, { allowAnyWorkdir: true });
    if (!session) return;
    if (session.runningTaskIds.size) return;
    if (session.workdir === this.workdir) return;
    if (this.isSessionSelected(session.key)) return;
    this.sessionStates.delete(session.key);
  }

  protected findThreadSessionRuntime(chatId: ChatId, threadId: string | null | undefined, agent: Agent): SessionRuntime | null {
    if (!threadId) return null;
    const managed = findManagedThreadSession(this.chatWorkdir(chatId), threadId, agent);
    if (!managed?.sessionId) return null;
    return this.hydrateSessionRuntime({
      agent: managed.agent,
      sessionId: managed.sessionId,
      workdir: managed.workdir || this.chatWorkdir(chatId),
      workspacePath: managed.workspacePath ?? null,
      threadId: managed.threadId ?? threadId,
      modelId: managed.model ?? null,
    });
  }

  protected ensureSessionForChat(chatId: ChatId, title: string, files: string[]): SessionRuntime {
    const cs = this.chat(chatId);
    const selected = this.getSelectedSession(cs);
    if (selected) return selected;

    const resumed = this.findThreadSessionRuntime(chatId, cs.activeThreadId, cs.agent);
    if (resumed) {
      this.applySessionSelection(cs, resumed);
      return resumed;
    }

    const wd = this.chatWorkdir(chatId);
    const staged = stageSessionFiles({
      agent: cs.agent,
      workdir: wd,
      files: [],
      sessionId: null,
      title: title || 'New session',
      threadId: cs.activeThreadId ?? null,
    });
    const runtime = this.upsertSessionRuntime({
      agent: cs.agent,
      sessionId: staged.sessionId,
      workspacePath: staged.workspacePath,
      threadId: staged.threadId,
      modelId: this.modelForAgent(cs.agent),
      thinkingEffort: this.effortForAgent(cs.agent),
    });
    this.applySessionSelection(cs, runtime);
    return runtime;
  }

  protected beginTask(task: RunningTask) {
    const nextTask: RunningTask = {
      ...task,
      actionId: task.actionId || `t${(this.nextTaskActionId++).toString(36)}`,
      status: 'queued',
      cancelled: false,
      abort: null,
      placeholderMessageIds: [...(task.placeholderMessageIds || [])],
    };
    this.activeTasks.set(nextTask.taskId, nextTask);
    this.taskKeysBySourceMessage.set(this.sourceMessageKey(task.chatId, task.sourceMessageId), nextTask.taskId);
    this.taskKeysByActionId.set(String(nextTask.actionId), nextTask.taskId);
    const session = this.getSessionRuntimeByKey(task.sessionKey, { allowAnyWorkdir: true });
    session?.runningTaskIds.add(nextTask.taskId);
  }

  protected finishTask(taskId: string) {
    for (const prompt of [...this.humanLoopPrompts.values()]) {
      if (prompt.taskId !== taskId) continue;
      this.clearHumanLoopPrompt(prompt.promptId, new Error('Task finished before prompt was answered.'));
    }
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    this.activeTasks.delete(taskId);
    this.taskKeysBySourceMessage.delete(this.sourceMessageKey(task.chatId, task.sourceMessageId));
    if (task.actionId) this.taskKeysByActionId.delete(String(task.actionId));
    this.withdrawnSourceMessages.delete(this.sourceMessageKey(task.chatId, task.sourceMessageId));
    const session = this.getSessionRuntimeByKey(task.sessionKey, { allowAnyWorkdir: true });
    if (!session) return;
    session.runningTaskIds.delete(taskId);
    this.maybeEvictSessionRuntime(session.key);
  }

  protected runningTaskForSession(sessionKey: string | null | undefined): RunningTask | null {
    const session = this.getSessionRuntimeByKey(sessionKey, { allowAnyWorkdir: true });
    if (!session || !session.runningTaskIds.size) return null;
    let running: RunningTask | null = null;
    for (const taskId of session.runningTaskIds) {
      const task = this.activeTasks.get(taskId);
      if (!task || task.status !== 'running') continue;
      if (!running || task.startedAt < running.startedAt) running = task;
    }
    return running;
  }

  protected markTaskRunning(taskId: string, abort?: (() => void) | null): RunningTask | null {
    const task = this.activeTasks.get(taskId);
    if (!task) return null;
    if (task.cancelled) return task;
    task.status = 'running';
    task.abort = abort || null;
    task.steer = null;
    task.freezePreviewOnAbort = false;
    return task;
  }

  protected registerTaskPlaceholders(taskId: string, messageIds: Array<number | string | null | undefined>) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    if (!task.placeholderMessageIds) task.placeholderMessageIds = [];
    for (const messageId of messageIds) {
      if (messageId == null) continue;
      if (!task.placeholderMessageIds.includes(messageId)) task.placeholderMessageIds.push(messageId);
    }
  }

  protected isSourceMessageWithdrawn(chatId: ChatId, sourceMessageId: number | string): boolean {
    return this.withdrawnSourceMessages.has(this.sourceMessageKey(chatId, sourceMessageId));
  }

  protected actionIdForTask(taskId: string): string | null {
    return this.activeTasks.get(taskId)?.actionId || null;
  }

  protected withdrawQueuedTaskBySourceMessage(chatId: ChatId, sourceMessageId: number | string): RunningTask | null {
    const sourceKey = this.sourceMessageKey(chatId, sourceMessageId);
    this.withdrawnSourceMessages.add(sourceKey);
    const taskId = this.taskKeysBySourceMessage.get(sourceKey);
    if (!taskId) return null;
    const task = this.activeTasks.get(taskId);
    if (!task || task.status !== 'queued') return null;
    task.cancelled = true;
    return task;
  }

  protected stopTasksForSession(sessionKey: string | null | undefined): { interrupted: boolean; cancelledQueued: number } {
    const session = this.getSessionRuntimeByKey(sessionKey, { allowAnyWorkdir: true });
    if (!session) return { interrupted: false, cancelledQueued: 0 };
    let interrupted = false;
    let cancelledQueued = 0;
    for (const taskId of session.runningTaskIds) {
      const task = this.activeTasks.get(taskId);
      if (!task) continue;
      if (task.status === 'queued') {
        if (!task.cancelled) {
          task.cancelled = true;
          cancelledQueued++;
        }
        continue;
      }
      if (!interrupted && task.status === 'running') {
        interrupted = true;
        try { task.abort?.(); } catch {}
      }
    }
    return { interrupted, cancelledQueued };
  }

  protected stopTaskByActionId(actionId: string): { task: RunningTask | null; interrupted: boolean; cancelled: boolean } {
    const taskId = this.taskKeysByActionId.get(String(actionId));
    if (!taskId) return { task: null, interrupted: false, cancelled: false };
    const task = this.activeTasks.get(taskId) || null;
    if (!task) return { task: null, interrupted: false, cancelled: false };
    if (task.status === 'queued') {
      task.cancelled = true;
      return { task, interrupted: false, cancelled: true };
    }
    if (task.status === 'running') {
      try { task.abort?.(); } catch {}
      return { task, interrupted: true, cancelled: false };
    }
    return { task, interrupted: false, cancelled: false };
  }

  /**
   * Steer hands off to the queued task's own placeholder card. Interrupt the
   * active task so the queued task can run next and the current preview can be
   * frozen in place instead of being rewritten as an error.
   */
  protected async steerTaskByActionId(actionId: string): Promise<{ task: RunningTask | null; interrupted: boolean; steered: boolean }> {
    const taskId = this.taskKeysByActionId.get(String(actionId));
    if (!taskId) return { task: null, interrupted: false, steered: false };
    const task = this.activeTasks.get(taskId) || null;
    if (!task || task.status !== 'queued') return { task, interrupted: false, steered: false };
    const interrupted = this.interruptRunningTask(task.sessionKey, { freezePreview: true });
    return { task, interrupted, steered: false };
  }

  /**
   * Interrupt only the currently running task for a session, leaving queued tasks intact.
   * Used by the "Steer" action to let a queued task run next.
   */
  protected interruptRunningTask(sessionKey: string | null | undefined, opts: { freezePreview?: boolean } = {}): boolean {
    const session = this.getSessionRuntimeByKey(sessionKey, { allowAnyWorkdir: true });
    if (!session) return false;
    for (const taskId of session.runningTaskIds) {
      const task = this.activeTasks.get(taskId);
      if (!task || task.status !== 'running') continue;
      task.freezePreviewOnAbort = !!opts.freezePreview;
      try { task.abort?.(); } catch {}
      return true;
    }
    return false;
  }

  /**
   * Return the number of tasks ahead of the given task in its session queue.
   * Counts running + queued (non-cancelled) tasks that were started before this one.
   */
  protected getQueuePosition(sessionKey: string, taskId: string): number {
    const session = this.getSessionRuntimeByKey(sessionKey, { allowAnyWorkdir: true });
    if (!session) return 0;
    let ahead = 0;
    for (const otherId of session.runningTaskIds) {
      if (otherId === taskId) continue;
      const other = this.activeTasks.get(otherId);
      if (!other || other.cancelled) continue;
      if (other.status === 'running' || other.status === 'queued') ahead++;
    }
    return ahead;
  }

  private sourceMessageKey(chatId: ChatId, sourceMessageId: number | string): string {
    return `${String(chatId)}:${String(sourceMessageId)}`;
  }

  protected queueSessionTask<T>(session: SessionRuntime, task: () => Promise<T>): Promise<T> {
    const prev = this.sessionChains.get(session.key) || Promise.resolve();
    const current = prev.catch(() => {}).then(task);
    const settled = current.then(() => {}, () => {});
    const chained = settled.finally(() => {
      if (this.sessionChains.get(session.key) === chained) this.sessionChains.delete(session.key);
    });
    this.sessionChains.set(session.key, chained);
    return current;
  }

  protected sessionHasPendingWork(session: SessionRuntime): boolean {
    return this.sessionChains.has(session.key);
  }

  protected beginHumanLoopPrompt(opts: BeginHumanLoopPromptOpts): ActiveHumanLoopPrompt {
    const promptId = `h${(this.nextHumanLoopPromptId++).toString(36)}`;
    let resolvePrompt!: (response: Record<string, any> | null) => void;
    let rejectPrompt!: (error: Error) => void;
    const result = new Promise<Record<string, any> | null>((resolve, reject) => {
      resolvePrompt = resolve;
      rejectPrompt = reject;
    });
    const answers: Record<string, ReturnType<typeof createEmptyHumanLoopAnswer>> = {};
    for (const question of opts.questions) answers[question.id] = createEmptyHumanLoopAnswer();
    const prompt: HumanLoopPromptState<ChatId> = {
      promptId,
      taskId: opts.taskId,
      chatId: opts.chatId,
      title: opts.title,
      detail: opts.detail ?? null,
      hint: opts.hint ?? null,
      questions: opts.questions,
      currentIndex: 0,
      answers,
      resolveWith: opts.resolveWith,
      resolve: resolvePrompt,
      reject: rejectPrompt,
      messageIds: [],
    };
    this.humanLoopPrompts.set(promptId, prompt);
    const chatKey = String(opts.chatId);
    const promptIds = this.humanLoopPromptIdsByChat.get(chatKey) || [];
    promptIds.push(promptId);
    this.humanLoopPromptIdsByChat.set(chatKey, promptIds);
    return { prompt, result };
  }

  protected pendingHumanLoopPrompt(chatId: ChatId): HumanLoopPromptState<ChatId> | null {
    const promptIds = this.humanLoopPromptIdsByChat.get(String(chatId)) || [];
    for (let i = promptIds.length - 1; i >= 0; i--) {
      const prompt = this.humanLoopPrompts.get(promptIds[i]) || null;
      if (prompt && isHumanLoopAwaitingText(prompt)) return prompt;
    }
    const promptId = promptIds[promptIds.length - 1];
    return promptId ? (this.humanLoopPrompts.get(promptId) || null) : null;
  }

  protected registerHumanLoopMessage(promptId: string, messageId: number | string | null | undefined) {
    if (messageId == null) return;
    const prompt = this.humanLoopPrompts.get(promptId);
    if (!prompt) return;
    if (!prompt.messageIds.includes(messageId)) prompt.messageIds.push(messageId);
  }

  protected resolveHumanLoopPrompt(promptId: string): HumanLoopPromptState<ChatId> | null {
    const prompt = this.humanLoopPrompts.get(promptId) || null;
    if (!prompt) return null;
    this.humanLoopPrompts.delete(promptId);
    this.removeHumanLoopPromptFromChat(prompt.chatId, promptId);
    prompt.resolve(buildHumanLoopResponse(prompt));
    return prompt;
  }

  protected clearHumanLoopPrompt(promptId: string, error?: Error): HumanLoopPromptState<ChatId> | null {
    const prompt = this.humanLoopPrompts.get(promptId) || null;
    if (!prompt) return null;
    this.humanLoopPrompts.delete(promptId);
    this.removeHumanLoopPromptFromChat(prompt.chatId, promptId);
    if (error) prompt.reject(error);
    return prompt;
  }

  protected humanLoopSelectOption(promptId: string, optionValue: string, opts: { requestFreeform?: boolean } = {}) {
    const prompt = this.humanLoopPrompts.get(promptId) || null;
    if (!prompt) return null;
    const result = setHumanLoopOption(prompt, optionValue, opts);
    if (result.completed) this.resolveHumanLoopPrompt(promptId);
    return { prompt, ...result };
  }

  protected humanLoopSkip(promptId: string) {
    const prompt = this.humanLoopPrompts.get(promptId) || null;
    if (!prompt) return null;
    const result = skipHumanLoopQuestion(prompt);
    if (result.completed) this.resolveHumanLoopPrompt(promptId);
    return { prompt, ...result };
  }

  protected humanLoopSubmitText(chatId: ChatId, text: string) {
    const prompt = this.pendingHumanLoopPrompt(chatId);
    if (!prompt) return null;
    if (!isHumanLoopAwaitingText(prompt)) return null;
    const result = setHumanLoopText(prompt, text);
    if (result.completed) this.resolveHumanLoopPrompt(prompt.promptId);
    return { prompt, ...result };
  }

  protected humanLoopCancel(promptId: string, reason = 'Prompt cancelled.') {
    return this.clearHumanLoopPrompt(promptId, new Error(reason));
  }

  protected humanLoopCurrentQuestion(promptId: string): HumanLoopQuestion | null {
    const prompt = this.humanLoopPrompts.get(promptId);
    return prompt ? currentHumanLoopQuestion(prompt) : null;
  }

  protected humanLoopPrompt(promptId: string): HumanLoopPromptState<ChatId> | null {
    return this.humanLoopPrompts.get(promptId) || null;
  }

  private removeHumanLoopPromptFromChat(chatId: ChatId, promptId: string) {
    const chatKey = String(chatId);
    const promptIds = this.humanLoopPromptIdsByChat.get(chatKey) || [];
    const next = promptIds.filter(id => id !== promptId);
    if (next.length) this.humanLoopPromptIdsByChat.set(chatKey, next);
    else this.humanLoopPromptIdsByChat.delete(chatKey);
  }

  selectedSession(chatId: ChatId): SessionRuntime | null {
    return this.getSelectedSession(this.chat(chatId));
  }

  submitSessionTask(opts: SubmitSessionTaskOpts): SubmittedSessionTask {
    const session = this.upsertSessionRuntime({
      agent: opts.agent,
      sessionId: opts.sessionId,
      workdir: opts.workdir,
      workspacePath: null,
      modelId: opts.modelId ?? null,
      thinkingEffort: opts.thinkingEffort ?? null,
    });
    const taskId = `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const prompt = opts.prompt.trim();
    const attachments = opts.attachments || [];
    const currentSessionKey = () => this.activeTasks.get(taskId)?.sessionKey || session.key;

    this.beginTask({
      taskId,
      chatId: opts.chatId ?? 'dashboard',
      agent: session.agent,
      sessionKey: session.key,
      prompt,
      attachments,
      startedAt: Date.now(),
      sourceMessageId: opts.sourceMessageId ?? taskId,
    });
    this.emitStream(session.key, { type: 'queued', taskId, position: this.getQueuePosition(session.key, taskId) });

    void this.queueSessionTask(session, async () => {
      const abortController = new AbortController();
      const task = this.markTaskRunning(taskId, () => abortController.abort());
      if (task?.cancelled) {
        this.emitStream(currentSessionKey(), { type: 'cancelled', taskId });
        this.finishTask(taskId);
        return;
      }

      this.emitStream(currentSessionKey(), { type: 'start', taskId, agent: session.agent, sessionId: session.sessionId });
      try {
        const result = await this.runStream(
          prompt,
          session,
          attachments,
          (text, thinking, activity, meta, plan) => {
            opts.onText?.(text, thinking, activity, meta, plan);
            this.emitStream(currentSessionKey(), { type: 'text', text, thinking, activity, plan });
          },
          undefined,
          undefined,
          abortController.signal,
        );
        this.emitStream(currentSessionKey(), {
          type: 'done',
          taskId,
          sessionId: result.sessionId || session.sessionId,
          ...(result.ok ? {} : { error: result.error || result.message }),
        });
      } catch (error: any) {
        this.emitStream(currentSessionKey(), {
          type: 'done',
          taskId,
          sessionId: session.sessionId,
          error: error?.message || String(error),
        });
      } finally {
        this.finishTask(taskId);
        this.syncSelectedChats(session);
      }
    }).catch(error => {
      this.finishTask(taskId);
      this.error(`[submitSessionTask] queue failed task=${taskId} error=${error?.message || error}`);
    });

    return { ok: true, taskId, sessionKey: session.key, queued: true };
  }

  cancelTask(taskId: string): { task: RunningTask | null; interrupted: boolean; cancelled: boolean } {
    const task = this.activeTasks.get(taskId) || null;
    if (!task) return { task: null, interrupted: false, cancelled: false };
    if (task.status === 'queued') {
      task.cancelled = true;
      this.emitStream(task.sessionKey, { type: 'cancelled', taskId });
      return { task, interrupted: false, cancelled: true };
    }
    if (task.status === 'running') {
      task.cancelled = true;
      try { task.abort?.(); } catch {}
      return { task, interrupted: true, cancelled: false };
    }
    return { task, interrupted: false, cancelled: false };
  }

  async steerTask(taskId: string): Promise<{ task: RunningTask | null; interrupted: boolean; steered: boolean }> {
    const task = this.activeTasks.get(taskId) || null;
    if (!task || task.status !== 'queued') return { task, interrupted: false, steered: false };
    const interrupted = this.interruptRunningTask(task.sessionKey, { freezePreview: true });
    return { task, interrupted, steered: interrupted || !!task };
  }

  resetConversationForChat(chatId: ChatId) {
    this.resetChatConversation(this.chat(chatId));
  }

  adoptExistingSessionForChat(
    chatId: ChatId,
    session: Pick<SessionInfo, 'agent' | 'sessionId' | 'workdir' | 'workspacePath' | 'model' | 'title' | 'threadId'>,
  ): SessionRuntime | null {
    const cs = this.chat(chatId);
    this.adoptSession(cs, session);
    return this.getSelectedSession(cs);
  }

  switchAgentForChat(chatId: ChatId, agent: Agent): boolean {
    const cs = this.chat(chatId);
    if (cs.agent === agent) return false;
    cs.agent = agent;
    const resumed = this.findThreadSessionRuntime(chatId, cs.activeThreadId, agent);
    if (resumed) {
      this.applySessionSelection(cs, resumed);
      this.log(`agent switched to ${agent} chat=${chatId} resumed=${resumed.sessionId}`);
      return true;
    }
    this.resetChatConversation(cs, { clearThread: false });
    this.log(`agent switched to ${agent} chat=${chatId}`);
    return true;
  }

  switchModelForChat(chatId: ChatId, modelId: string) {
    const cs = this.chat(chatId);
    this.setModelForAgent(cs.agent, modelId);
    this.resetChatConversation(cs);
    this.log(`model switched to ${modelId} for ${cs.agent} chat=${chatId}`);
  }

  switchEffortForChat(chatId: ChatId, effort: string) {
    const cs = this.chat(chatId);
    this.setEffortForAgent(cs.agent, effort);
    this.log(`effort switched to ${effort} for ${cs.agent} chat=${chatId}`);
  }

  switchPermissionModeForChat(chatId: ChatId, mode: string) {
    const cs = this.chat(chatId);
    if (cs.agent === 'claude') {
      this.agentConfigs.claude.permissionMode = mode;
      this.resetChatConversation(cs);
      this.log(`permission mode switched to ${mode} for claude chat=${chatId}`);
    }
  }

  modelForAgent(agent: Agent): string {
    return this.agentConfigs[agent]?.model || '';
  }

  fetchSessions(agent: Agent, workdir?: string): Promise<SessionQueryResult> {
    return querySessions({ agent, workdir: workdir || this.workdir });
  }

  fetchSessionTail(agent: Agent, sessionId: string, limit?: number, workdir = this.workdir) {
    return querySessionTail({ agent, sessionId, workdir, limit });
  }

  fetchAgents(options: AgentDetectOptions = {}) {
    return listAgents(options);
  }

  fetchSkills(workdir?: string) {
    const wd = workdir || this.workdir;
    initializeProjectSkills(wd);
    return listSkills(wd);
  }

  fetchModels(agent: Agent, workdir?: string) {
    const wd = workdir || this.workdir;
    return listModels(agent, { workdir: wd, currentModel: this.modelForAgent(agent) });
  }

  setDefaultAgent(agent: Agent) {
    const next = normalizeAgent(agent);
    const prev = this.defaultAgent;
    this.defaultAgent = next;
    for (const [, cs] of this.chats) {
      if (cs.activeSessionKey || cs.sessionId) continue;
      if (cs.agent === prev) cs.agent = next;
    }
    this.log(`default agent changed to ${next}`);
  }

  setModelForAgent(agent: Agent, modelId: string) {
    const config = this.agentConfigs[agent];
    if (config) config.model = modelId;
    this.log(`model for ${agent} changed to ${modelId}`);
  }

  effortForAgent(agent: Agent): string | null {
    if (agent === 'gemini') return null;
    return this.agentConfigs[agent]?.reasoningEffort || 'high';
  }

  setEffortForAgent(agent: Agent, effort: string) {
    const config = this.agentConfigs[agent];
    if (config) config.reasoningEffort = effort;
    this.log(`effort for ${agent} changed to ${effort}`);
  }

  getStatusData(chatId: ChatId) {
    const cs = this.chat(chatId);
    const selectedSession = this.getSelectedSession(cs);
    const selectedTask = this.runningTaskForSession(selectedSession?.key ?? null);
    const fallbackTask = selectedTask || [...this.activeTasks.values()]
      .sort((a, b) => a.startedAt - b.startedAt)[0] || null;
    const model = selectedSession?.modelId || this.modelForAgent(cs.agent);
    const mem = process.memoryUsage();
    return {
      version: VERSION, uptime: Date.now() - this.startedAt,
      memRss: mem.rss, memHeap: mem.heapUsed, pid: process.pid,
      workdir: this.chatWorkdir(chatId), agent: cs.agent, model, sessionId: cs.sessionId,
      workspacePath: cs.workspacePath ?? null,
      running: fallbackTask, activeTasksCount: this.activeTasks.size, stats: this.stats,
      usage: getUsage({ agent: cs.agent, model }),
    };
  }

  getHostData() {
    const cpus = os.cpus();
    const totalMem = os.totalmem(), freeMem = os.freemem();
    const memory = getHostMemoryUsageData(totalMem, freeMem);
    const cpuUsage = getHostCpuUsageData();
    const [loadOne, loadFive, loadFifteen] = os.loadavg();
    let disk: { used: string; total: string; percent: string } | null = null;
    const battery = getHostBatteryData();
    try {
      if (process.platform === 'win32') {
        const driveLetter = this.workdir.charAt(0).toUpperCase();
        const psOut = execSync(
          `powershell -NoProfile -Command "Get-PSDrive -Name ${driveLetter} | ForEach-Object { [PSCustomObject]@{Used=$_.Used;Free=$_.Free} } | ConvertTo-Json"`,
          { encoding: 'utf-8', timeout: 5000 },
        ).trim();
        const info: { Used: number | null; Free: number | null } = JSON.parse(psOut);
        if (info.Used != null && info.Free != null) {
          const used = Number(info.Used), free = Number(info.Free), total = used + free;
          const fmt = (b: number) => b >= 1e12 ? `${(b / 1e12).toFixed(1)}T` : b >= 1e9 ? `${(b / 1e9).toFixed(1)}G` : b >= 1e6 ? `${(b / 1e6).toFixed(1)}M` : `${Math.round(b / 1e3)}K`;
          disk = { used: fmt(used), total: fmt(total), percent: `${Math.round(used / total * 100)}%` };
        }
      } else {
        const df = execSync(`df -h "${this.workdir}" | tail -1`, { encoding: 'utf-8', timeout: 3000 }).trim().split(/\s+/);
        if (df.length >= 5) disk = { used: df[2], total: df[1], percent: df[4] };
      }
    } catch {}
    let topProcs: string[] = [];
    try {
      if (process.platform === 'win32') {
        topProcs = execSync(
          `powershell -NoProfile -Command "Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 5 | ForEach-Object { \\"$($_.Id) $([math]::Round($_.CPU)) $([math]::Round($_.WorkingSet64/1MB)) $($_.ProcessName)\\"" }"`,
          { encoding: 'utf-8', timeout: 5000 },
        ).trim().split('\n');
      } else {
        topProcs = execSync(`ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -6 || ps -eo pid,%cpu,%mem,comm -r 2>/dev/null | head -6`, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n');
      }
    } catch {}
    const mem = process.memoryUsage();
    return {
      hostName: getHostDisplayName(),
      cpuModel: cpus[0]?.model || 'unknown', cpuCount: cpus.length,
      cpuUsage,
      loadAverage: { one: loadOne, five: loadFive, fifteen: loadFifteen },
      totalMem, freeMem, memoryUsed: memory.usedBytes, memoryAvailable: memory.availableBytes, memoryPercent: memory.percent, memorySource: memory.source,
      disk, battery, topProcs,
      selfPid: process.pid, selfRss: mem.rss, selfHeap: mem.heapUsed,
    };
  }

  switchWorkdir(newPath: string, opts: { persist?: boolean } = {}) {
    const old = this.workdir;
    const resolvedPath = path.resolve(newPath.replace(/^~/, process.env.HOME || ''));
    if (opts.persist !== false) {
      setUserWorkdir(resolvedPath, { notify: false });
    } else {
      process.env.PIKICLAW_WORKDIR = resolvedPath;
    }
    this.workdir = resolvedPath;
    for (const [, cs] of this.chats) {
      this.resetChatConversation(cs, { clearWorkdir: true });
    }
    for (const [key, session] of this.sessionStates) {
      if (session.workdir === old && !session.runningTaskIds.size) this.sessionStates.delete(key);
    }
    ensureGitignore(resolvedPath);
    initializeProjectSkills(resolvedPath);
    this.log(`switch workdir: ${old} -> ${resolvedPath}`);
    this.afterSwitchWorkdir(old, resolvedPath);
    return old;
  }

  protected afterSwitchWorkdir(_oldPath: string, _newPath: string) {}

  protected onManagedConfigChange(_config: Record<string, any>, _opts: { initial?: boolean } = {}) {}

  private refreshManagedConfig(config: Record<string, any>, opts: { initial?: boolean } = {}) {
    const nextWorkdir = resolveUserWorkdir({ config });
    if (opts.initial) {
      this.workdir = nextWorkdir;
      ensureGitignore(this.workdir);
      initializeProjectSkills(this.workdir);
    } else if (nextWorkdir !== this.workdir) {
      this.switchWorkdir(nextWorkdir, { persist: false });
    }

    const nextDefaultAgent = normalizeAgent(String(config.defaultAgent || 'codex').trim().toLowerCase() || 'codex');
    if (opts.initial) this.defaultAgent = nextDefaultAgent;
    else if (nextDefaultAgent !== this.defaultAgent) this.setDefaultAgent(nextDefaultAgent);

    for (const agent of ['claude', 'codex', 'gemini'] as Agent[]) {
      const nextModel = resolveAgentModel(config, agent);
      if (nextModel && this.modelForAgent(agent) !== nextModel) {
        if (opts.initial) this.agentConfigs[agent].model = nextModel;
        else this.setModelForAgent(agent, nextModel);
      }

      const nextEffort = resolveAgentEffort(config, agent);
      if (nextEffort && agent !== 'gemini' && this.effortForAgent(agent) !== nextEffort) {
        if (opts.initial) this.agentConfigs[agent].reasoningEffort = nextEffort;
        else this.setEffortForAgent(agent, nextEffort);
      }
    }

    if (!opts.initial) this.onManagedConfigChange(config, opts);
  }

  async runStream(
    prompt: string, cs: Pick<SessionRuntime, 'key' | 'workdir' | 'agent' | 'sessionId' | 'workspacePath' | 'codexCumulative' | 'modelId' | 'thinkingEffort'> | ChatState, attachments: string[],
    onText: (text: string, thinking: string, activity?: string, meta?: StreamPreviewMeta, plan?: StreamPreviewPlan | null) => void,
    systemPrompt?: string,
    mcpSendFile?: import('../agent/mcp/bridge.js').McpSendFileCallback,
    abortSignal?: AbortSignal,
    onCodexInteractionRequest?: (request: CodexInteractionRequest) => Promise<Record<string, any> | null>,
    onSteerReady?: (steer: (prompt: string, attachments?: string[]) => Promise<boolean>) => void,
    onCodexTurnReady?: (control: CodexTurnControl) => void,
  ): Promise<StreamResult> {
    const resolvedModel = cs.modelId || this.modelForAgent(cs.agent);
    const agentConfig = this.agentConfigs[cs.agent] || {};
    const resolvedThinkingEffort = ('thinkingEffort' in cs && typeof cs.thinkingEffort === 'string' && cs.thinkingEffort.trim())
      ? cs.thinkingEffort.trim().toLowerCase()
      : (agentConfig.reasoningEffort || 'high');
    const extraArgs: string[] = agentConfig.extraArgs || [];
    const browserEnabled = resolveGuiIntegrationConfig(getActiveUserConfig()).browserEnabled;
    const sessionWorkdir = 'workdir' in cs && typeof cs.workdir === 'string' && cs.workdir
      ? path.resolve(cs.workdir)
      : this.workdir;
    this.debug(`[runStream] agent=${cs.agent} session=${cs.sessionId || '(new)'} workdir=${sessionWorkdir} timeout=${this.runTimeout}s attachments=${attachments.length}`);
    this.debug(`[runStream] ${cs.agent} config: model=${resolvedModel} extraArgs=[${extraArgs.join(' ')}]`);
    const isFirstTurnOfSession = !cs.sessionId || isPendingSessionId(cs.sessionId);
    const mcpSystemPrompt = mcpSendFile
      ? appendExtraPrompt(buildMcpDeliveryPrompt(), buildBrowserAutomationPrompt(browserEnabled))
      : '';
    const effectiveSystemPrompt = isFirstTurnOfSession
      ? appendExtraPrompt(systemPrompt, mcpSystemPrompt)
      : undefined;
    const syncNativeSessionId = (nativeSessionId: string) => {
      const resolvedSessionId = nativeSessionId.trim();
      if (!resolvedSessionId) return;
      if ('key' in cs && typeof cs.key === 'string') {
        const runtime = this.getSessionRuntimeByKey(cs.key, { allowAnyWorkdir: true });
        if (runtime) {
          this.promoteSessionRuntime(runtime, resolvedSessionId);
          return;
        }
      }
      cs.sessionId = resolvedSessionId;
    };
    const opts: StreamOpts = {
      agent: cs.agent, prompt, workdir: sessionWorkdir, timeout: this.runTimeout,
      sessionId: cs.sessionId, model: null,
      thinkingEffort: resolvedThinkingEffort, onText,
      onSessionId: syncNativeSessionId,
      attachments: attachments.length ? attachments : undefined,
      // codex-specific
      codexModel: cs.agent === 'codex' ? resolvedModel : this.codexModel,
      codexFullAccess: this.codexFullAccess,
      codexDeveloperInstructions: effectiveSystemPrompt || undefined,
      codexExtraArgs: this.codexExtraArgs.length ? this.codexExtraArgs : undefined,
      codexPrevCumulative: cs.codexCumulative,
      // claude-specific
      claudeModel: cs.agent === 'claude' ? resolvedModel : this.claudeModel,
      claudePermissionMode: this.claudePermissionMode,
      claudeAppendSystemPrompt: effectiveSystemPrompt || undefined,
      claudeExtraArgs: this.claudeExtraArgs.length ? this.claudeExtraArgs : undefined,
      // gemini-specific
      geminiModel: cs.agent === 'gemini' ? resolvedModel : (this.agentConfigs.gemini?.model || ''),
      geminiApprovalMode: this.geminiApprovalMode,
      geminiSandbox: this.geminiSandbox,
      geminiSystemInstruction: effectiveSystemPrompt || undefined,
      geminiExtraArgs: this.geminiExtraArgs.length ? this.geminiExtraArgs : undefined,
      // MCP bridge
      mcpSendFile,
      abortSignal,
      onCodexInteractionRequest,
      onSteerReady,
      onCodexTurnReady,
    };
    const result = await doStream(opts);
    this.stats.totalTurns++;
    if (result.inputTokens) this.stats.totalInputTokens += result.inputTokens;
    if (result.outputTokens) this.stats.totalOutputTokens += result.outputTokens;
    if (result.cachedInputTokens) this.stats.totalCachedTokens += result.cachedInputTokens;
    if (result.codexCumulative) cs.codexCumulative = result.codexCumulative;
    if (result.sessionId) syncNativeSessionId(result.sessionId);
    if (result.workspacePath) cs.workspacePath = result.workspacePath;
    if (result.model) cs.modelId = result.model;
    if ('key' in cs && typeof cs.key === 'string') {
      const runtime = this.getSessionRuntimeByKey(cs.key, { allowAnyWorkdir: true });
      if (runtime) this.syncSelectedChats(runtime);
    }
    this.debug(`[runStream] completed turn=${this.stats.totalTurns} cumulative: in=${fmtTokens(this.stats.totalInputTokens)} out=${fmtTokens(this.stats.totalOutputTokens)} cached=${fmtTokens(this.stats.totalCachedTokens)}`);
    return result;
  }

  startKeepAlive() {
    if (process.platform === 'darwin') {
      if (this.keepAliveProc || this.keepAlivePulseTimer) return;
      const bin = whichSync('caffeinate');
      if (bin) {
        this.keepAliveProc = spawn('caffeinate', ['-dis'], { stdio: 'ignore', detached: true });
        this.keepAliveProc.unref();
        this.log(`keep-alive: caffeinate (PID ${this.keepAliveProc.pid})`);
        const pulseUserActivity = () => {
          const pulse = spawn('caffeinate', ['-u', '-t', String(MACOS_USER_ACTIVITY_PULSE_TIMEOUT_S)], {
            stdio: 'ignore',
            detached: true,
          });
          pulse.unref();
        };
        pulseUserActivity();
        this.keepAlivePulseTimer = setInterval(pulseUserActivity, MACOS_USER_ACTIVITY_PULSE_INTERVAL_MS);
        this.keepAlivePulseTimer.unref?.();
        this.log(`keep-alive: macOS user activity pulse every ${MACOS_USER_ACTIVITY_PULSE_INTERVAL_MS / 1000}s`);
      }
    } else if (process.platform === 'linux') {
      if (this.keepAliveProc) return;
      const bin = whichSync('systemd-inhibit');
      if (bin) {
        this.keepAliveProc = spawn('systemd-inhibit', [
          '--what=idle', '--who=pikiclaw', '--why=AI coding agent running', 'sleep', 'infinity',
        ], { stdio: 'ignore', detached: true });
        this.keepAliveProc.unref();
        this.log(`keep-alive: systemd-inhibit (PID ${this.keepAliveProc.pid})`);
      }
    }
  }

  stopKeepAlive() {
    if (this.keepAlivePulseTimer) {
      clearInterval(this.keepAlivePulseTimer);
      this.keepAlivePulseTimer = null;
    }
    if (this.keepAliveProc) {
      terminateProcessTree(this.keepAliveProc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 2000 });
      this.keepAliveProc = null;
    }
  }
}
