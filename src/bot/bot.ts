import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { getActiveUserConfig, loadWorkspaces, onUserConfigChange, resolveUserWorkdir, setUserWorkdir, updateUserConfig } from '../core/config/user-config.js';
import {
  doStream, ensureManagedSession, findManagedThreadSession, getSessionStoredConfig, getUsage, initializeProjectSkills, listAgents, resolveAgentModels, resolveDefaultAgent, listSkills, stageSessionFiles,
  reconcileOrphanedRunningSessions, getAgentBoundModelId, setAgentBoundModelId, collapseSkillPrompt,
  readGoal, accountTurn, shouldContinueAfterTurn, renderContinuationPrompt, renderBudgetLimitPrompt,
  bumpContinuationCount, pauseGoal, resumeGoal, setGoal as setGoalState, clearGoal as clearGoalState,
  setCodexGoal, getCodexGoal, clearCodexGoal, pauseCodexGoal, resumeCodexGoal,
  getClaudeNativeGoal, buildClaudeSetGoalPrompt, buildClaudeClearGoalPrompt,
  deliverArtifact, attachmentUrl, attachAgentImage, rewriteAttachmentBlocksForTransport,
  type Agent, type CodexCumulativeUsage, type StreamOpts, type StreamResult, type StreamPreviewMeta, type StreamPreviewPlan, type StreamSubAgent, type SessionInfo, type UsageResult,
  type AgentInteraction, type CodexTurnControl,
  type ModelInfo, type ModelListResult, type TailMessage, type SessionTailResult,
  type SkillInfo, type SkillListResult, type AgentDetectOptions, isPendingSessionId,
  type SessionClassification, type SessionMessagesOpts, type SessionMessagesResult,
  type ThreadGoal, type GoalStatus, type CodexThreadGoal, type ClaudeNativeGoal,
  type HandoverRef, type MessageBlock,
} from '../agent/index.js';
import { compactForHandover, describeHandoverRef } from '../agent/handover.js';
import { getActiveProfileId, getActiveProfile, setActiveProfile, getProfile } from '../model/index.js';
import {
  querySessions, querySessionTail, updateSession,
  type SessionQueryResult,
} from './session-hub.js';
import { getDriver, hasDriver, allDriverIds, getDriverCapabilities } from '../agent/driver.js';
import { resolveGuiIntegrationConfig, type McpSendFileCallback, type McpSendFileResult } from '../agent/mcp/bridge.js';
import { composeSessionToolPrompt } from '../agent/mcp/capabilities.js';
import { terminateProcessTree } from '../core/process-control.js';
import { appendTurnAudit } from '../core/turn-audit.js';
import { recordDeliveredTurn } from '../agent/turn-snapshot.js';
import { expandTilde } from '../core/platform.js';
import { VERSION } from '../core/version.js';
import {
  type HumanLoopPromptState, type HumanLoopQuestion, type ResolvedHumanLoopAnswers, type ResolvedHumanLoopStatus,
  buildHumanLoopResponse, createEmptyHumanLoopAnswer, currentHumanLoopQuestion,
  isHumanLoopAwaitingText, setHumanLoopOption, setHumanLoopText, skipHumanLoopQuestion,
  summarizeResolvedHumanLoopAnswers,
} from './human-loop.js';
import { writeScopedLog, type LogLevel } from '../core/logging.js';
import {
  resolveAgentEffort,
  resolveAgentModel,
  resolveClaudeAccessMode,
  splitEffortForAgent,
  DEFAULT_CLAUDE_ACCESS_MODE,
  type ClaudeAccessMode,
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

export { updateSession, type Agent, type CodexCumulativeUsage, type StreamResult, type StreamPreviewMeta, type StreamPreviewPlan, type StreamSubAgent, type SessionInfo, type UsageResult, type AgentInteraction, type ModelInfo, type ModelListResult, type TailMessage, type SessionTailResult, type SkillInfo, type SkillListResult, type SessionClassification, type SessionMessagesOpts, type SessionMessagesResult, type SessionQueryResult };
export { envBool, envString, envInt, shellSplit, whichSync, fmtTokens, fmtUptime, fmtBytes, parseAllowedChatIds, listSubdirs, extractThinkingTail, formatThinkingForDisplay, buildPrompt, ensureGitignore, type ChatId } from '../core/utils.js';
export { getHostBatteryData, getHostCpuUsageData, getHostDisplayName, getHostMemoryUsageData, type HostBatteryData, type HostCpuUsageData, type HostMemoryUsageData } from './host.js';
export { readGitStatus, formatGitStatusLine, type GitStatus } from '../core/git.js';
import { BOT_TIMEOUTS } from '../core/constants.js';
import { queuedIdsToDeferForSteer } from './queue-steer.js';

export const DEFAULT_RUN_TIMEOUT_S = BOT_TIMEOUTS.defaultRunTimeoutS;
const MACOS_USER_ACTIVITY_PULSE_INTERVAL_MS = BOT_TIMEOUTS.macosUserActivityPulseInterval;
const MACOS_USER_ACTIVITY_PULSE_TIMEOUT_S = BOT_TIMEOUTS.macosUserActivityPulseTimeoutS;

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

function buildWorkflowOptInPrompt(): string {
  return [
    '[Multi-agent Workflow]',
    'Workflow orchestration is enabled for this session. For substantial multi-step work — broad research, large refactors or audits, fan-out reviews across many files — you may proactively author and run a Workflow to decompose and parallelise it.',
    'Keep it proportional: do NOT orchestrate trivial or single-file tasks. When a workflow would not add value, just answer directly as a single agent. Workflows can spawn many sub-agents and consume significant tokens, so reserve them for work whose scale genuinely warrants the fan-out.',
  ].join('\n');
}

export interface ChatState {
  agent: Agent;
  sessionId: string | null;
  workspacePath?: string | null;
  codexCumulative?: CodexCumulativeUsage;
  modelId?: string | null;
  activeSessionKey?: string | null;
  activeThreadId?: string | null;
  workdir?: string | null;
  pendingHandoverFrom?: HandoverRef | null;
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
  handoverFrom?: HandoverRef | null;
}

export interface InteractionSnapshot {
  promptId: string;
  kind: 'user-input' | 'permission' | 'confirmation';
  title: string;
  hint?: string | null;
  questions: AgentInteraction['questions'];
  currentIndex?: number;
}

export interface SnapshotArtifact {
  url: string;
  fileName: string;
  fileSize: number;
  mime: string;
  kind: 'photo' | 'document';
  caption?: string;
}

export type StreamEvent =
  | { type: 'start'; taskId: string; agent: string; sessionId: string | null; model: string | null; effort: string | null }
  | { type: 'text'; text: string; thinking: string; activity?: string; plan?: StreamPreviewPlan | null; previewMeta?: StreamPreviewMeta | null }
  | { type: 'artifact'; artifact: SnapshotArtifact }
  | { type: 'done'; taskId: string; sessionId: string | null; error?: string; incomplete?: boolean }
  | { type: 'queued'; taskId: string; position: number }
  | { type: 'cancelled'; taskId: string }
  | { type: 'interaction'; taskId: string; interaction: InteractionSnapshot }
  | { type: 'interaction-resolved'; promptId: string };

export interface StreamSnapshot {
  phase: 'queued' | 'streaming' | 'done';
  taskId: string;
  queuedTaskIds?: string[];
  queuedTasks?: Array<{ taskId: string; prompt: string; attachments?: MessageBlock[] }>;
  question?: string | null;
  questionBlocks?: MessageBlock[];
  incomplete?: boolean;
  text?: string;
  thinking?: string;
  activity?: string;
  plan?: StreamPreviewPlan | null;
  sessionId?: string | null;
  model?: string | null;
  effort?: string | null;
  previewMeta?: StreamPreviewMeta | null;
  error?: string;
  artifacts?: SnapshotArtifact[];
  interactions?: InteractionSnapshot[];
  startedAt?: number;
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
  deferForSteer?: boolean;
}

export interface SessionGoalView {
  source: 'pikiloom' | 'codex' | 'claude';
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  continuationCount: number | null;
}

function normalizeFromPikiloom(goal: ThreadGoal): SessionGoalView {
  return {
    source: 'pikiloom',
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    continuationCount: goal.continuationCount,
  };
}

function normalizeFromCodex(goal: CodexThreadGoal): SessionGoalView {
  return {
    source: 'codex',
    objective: goal.objective,
    status: goal.status === 'budgetLimited' ? 'budget_limited' : goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    continuationCount: null,
  };
}

function normalizeFromClaudeNative(goal: ClaudeNativeGoal): SessionGoalView {
  return {
    source: 'claude',
    objective: goal.condition,
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    continuationCount: null,
  };
}

export interface BeginHumanLoopPromptOpts {
  taskId: string;
  chatId: ChatId;
  title: string;
  detail?: string | null;
  hint?: string | null;
  questions: HumanLoopQuestion[];
  resolveWith: (answers: Record<string, string[]>) => Record<string, any> | null;
  silent?: boolean;
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
  profileId?: string | null;
  thinkingEffort?: string | null;
  workflowEnabled?: boolean;
  sourceMessageId?: number | string;
  chatId?: ChatId;
  handoverFrom?: HandoverRef | null;
  goalContinuation?: { kind: 'continuation' | 'budget_wrapup'; goalId: string };
  forkOf?: { parentSessionId: string; atTurn: number };
  onText?: (
    text: string,
    thinking: string,
    activity?: string,
    meta?: StreamPreviewMeta,
    plan?: StreamPreviewPlan | null,
  ) => void;
}

interface RunStreamExtras {
  forkOf?: { parentSessionId: string; atTurn: number };
  workflowEnabled?: boolean;
  profileId?: string | null;
  onPreparedPrompt?: (prompt: string) => void;
}

export interface SubmittedSessionTask {
  ok: true;
  taskId: string;
  sessionKey: string;
  queued: true;
}

export interface ImTaskPresenterOpts {
  chatId: ChatId;
  taskId: string;
  session: SessionRuntime;
  agent: Agent;
  prompt: string;
  attachments: string[];
}

export interface ImTaskPresenter {
  onText: (
    text: string,
    thinking: string,
    activity?: string,
    meta?: StreamPreviewMeta,
    plan?: StreamPreviewPlan | null,
  ) => void;
  onSuccess: (result: StreamResult) => Promise<void>;
  onFailure: (error: string) => Promise<void>;
  dispose: () => void;
}

export class Bot {
  workdir: string;
  defaultAgent: Agent;
  runTimeout: number;
  allowedChatIds: Set<ChatId>;

  agentConfigs: Record<string, Record<string, any>> = {};

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
  get claudeWorkflowEnabled(): boolean { return this.agentConfigs.claude?.workflowEnabled ?? false; }
  get claudeAccessMode(): ClaudeAccessMode { return this.agentConfigs.claude?.accessMode || DEFAULT_CLAUDE_ACCESS_MODE; }
  get geminiApprovalMode(): string { return this.agentConfigs.gemini?.approvalMode || 'yolo'; }
  get geminiSandbox(): boolean { return this.agentConfigs.gemini?.sandbox ?? false; }
  get geminiExtraArgs(): string[] { return this.agentConfigs.gemini?.extraArgs || []; }

  chats = new Map<ChatId, ChatState>();
  sessionStates = new Map<string, SessionRuntime>();
  activeTasks = new Map<string, RunningTask>();
  startedAt = Date.now();
  connected = false;
  stats = { totalTurns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0 };

  private streamSnapshots = new Map<string, StreamSnapshot>();
  private snapshotCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private promotedSessionKeys = new Map<string, string>();
  private promotedFromAliases = new Map<string, string[]>();

  private resolveSessionKey(sessionKey: string): string {
    let key = sessionKey;
    const seen = new Set<string>();
    while (!seen.has(key)) {
      const next = this.promotedSessionKeys.get(key);
      if (!next || next === key) break;
      seen.add(key);
      key = next;
    }
    return key;
  }

  private forgetPromotion(canonicalKey: string): void {
    const aliases = this.promotedFromAliases.get(canonicalKey);
    if (aliases) for (const alias of aliases) this.promotedSessionKeys.delete(alias);
    this.promotedFromAliases.delete(canonicalKey);
  }

  getStreamSnapshot(sessionKey: string): StreamSnapshot | null {
    const snap = this.streamSnapshots.get(this.resolveSessionKey(sessionKey));
    return snap ? this.enrichSnapshot(snap) : null;
  }

  private taskAttachmentBlocks(task: RunningTask | null | undefined): MessageBlock[] {
    if (!task?.attachments?.length) return [];
    const session = this.getSessionRuntimeByKey(task.sessionKey, { allowAnyWorkdir: true });
    const sessionId = session?.sessionId || task.sessionKey.slice(task.agent.length + 1);
    if (!sessionId) return [];
    const blocks = task.attachments
      .map(imagePath => attachAgentImage({ imagePath, inlineThresholdBytes: 0 }))
      .filter((block): block is MessageBlock => !!block);
    return blocks.length
      ? rewriteAttachmentBlocksForTransport(blocks, { agent: task.agent, sessionId })
      : [];
  }

  private taskPreview(taskId: string): { taskId: string; prompt: string; attachments?: MessageBlock[] } {
    const task = this.activeTasks.get(taskId) || null;
    const raw = task?.prompt || '';
    const attachments = this.taskAttachmentBlocks(task);
    return {
      taskId,
      prompt: collapseSkillPrompt(raw) ?? raw,
      ...(attachments.length ? { attachments } : {}),
    };
  }

  private enrichSnapshot(snap: StreamSnapshot): StreamSnapshot {
    let next = snap;
    const runningTask = next.taskId ? this.activeTasks.get(next.taskId) : null;
    const runningPrompt = runningTask?.prompt || '';
    if (runningPrompt) {
      const questionBlocks = this.taskAttachmentBlocks(runningTask);
      next = {
        ...next,
        question: collapseSkillPrompt(runningPrompt) ?? runningPrompt,
        ...(questionBlocks.length ? { questionBlocks } : {}),
      };
    }
    const queuedIds = [
      ...(next.phase === 'queued' && next.taskId ? [next.taskId] : []),
      ...(next.queuedTaskIds || []),
    ].filter((taskId, index, all) => taskId && all.indexOf(taskId) === index);
    if (queuedIds.length) {
      const queuedTasks = queuedIds.map(taskId => this.taskPreview(taskId));
      next = { ...next, queuedTasks };
    }
    if (next.interactions?.length) {
      const refreshed = next.interactions.map(snapshotEntry => {
        const live = this.humanLoopPrompts.get(snapshotEntry.promptId);
        if (!live) return snapshotEntry;
        return { ...snapshotEntry, currentIndex: live.currentIndex };
      });
      next = { ...next, interactions: refreshed };
    }
    return next;
  }

  private updateTaskPrompt(taskId: string, fallbackKey: string, prompt: string) {
    const task = this.activeTasks.get(taskId);
    const prepared = prompt.trim();
    if (!task || !prepared || task.prompt === prepared) return;
    task.prompt = prepared;

    const key = this.liveSessionKey(taskId, fallbackKey);
    const snap = this.streamSnapshots.get(key);
    if (snap) {
      snap.updatedAt = Date.now();
      this.pushSnapshotToSSE(key, true);
    }
  }

  private _onStreamSnapshot: ((sessionKey: string, snapshot: StreamSnapshot | null) => void) | null = null;
  private streamPushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private streamPushPending = new Map<string, boolean>();

  onStreamSnapshot(cb: (sessionKey: string, snapshot: StreamSnapshot | null) => void): void {
    this._onStreamSnapshot = cb;
  }

  private pushSnapshotToSSE(sessionKey: string, immediate: boolean) {
    if (!this._onStreamSnapshot) return;
    const snap = this.streamSnapshots.get(sessionKey) ?? null;
    const cb = this._onStreamSnapshot;
    const emitAll = () => {
      const enriched = snap ? this.enrichSnapshot(snap) : null;
      cb(sessionKey, enriched);
      const aliases = this.promotedFromAliases.get(sessionKey);
      if (aliases) for (const alias of aliases) cb(alias, enriched ? { ...enriched } : null);
    };
    if (immediate) {
      const timer = this.streamPushTimers.get(sessionKey);
      if (timer) { clearTimeout(timer); this.streamPushTimers.delete(sessionKey); }
      this.streamPushPending.delete(sessionKey);
      emitAll();
    } else {
      this.streamPushPending.set(sessionKey, true);
      if (this.streamPushTimers.has(sessionKey)) return;
      this.streamPushTimers.set(sessionKey, setTimeout(() => {
        this.streamPushTimers.delete(sessionKey);
        if (this.streamPushPending.get(sessionKey)) {
          this.streamPushPending.delete(sessionKey);
          emitAll();
        }
      }, 80));
    }
  }

  emitStream(sessionKey: string, event: StreamEvent) {
    const pending = this.snapshotCleanupTimers.get(sessionKey);
    if (pending) { clearTimeout(pending); this.snapshotCleanupTimers.delete(sessionKey); }

    const now = Date.now();
    switch (event.type) {
      case 'queued': {
        const existing = this.streamSnapshots.get(sessionKey);
        if (existing && existing.phase === 'streaming') {
          const list = existing.queuedTaskIds ? [...existing.queuedTaskIds] : [];
          if (existing.taskId !== event.taskId && !list.includes(event.taskId)) list.push(event.taskId);
          existing.queuedTaskIds = list.length ? list : undefined;
          existing.updatedAt = now;
        } else if (existing && existing.phase === 'done') {
          this.streamSnapshots.set(sessionKey, { phase: 'queued', taskId: event.taskId, updatedAt: now });
        } else if (existing && existing.phase === 'queued') {
          const list = existing.queuedTaskIds ? [...existing.queuedTaskIds] : [];
          if (existing.taskId !== event.taskId && !list.includes(event.taskId)) list.push(event.taskId);
          existing.queuedTaskIds = list.length ? list : undefined;
          existing.updatedAt = now;
        } else {
          this.streamSnapshots.set(sessionKey, { phase: 'queued', taskId: event.taskId, updatedAt: now });
        }
        break;
      }
      case 'start': {
        const prev = this.streamSnapshots.get(sessionKey);
        const remainingQueued = prev?.queuedTaskIds?.filter(id => id !== event.taskId);
        this.streamSnapshots.set(sessionKey, {
          phase: 'streaming', taskId: event.taskId,
          text: '', thinking: '', activity: '', plan: null, sessionId: event.sessionId, updatedAt: now,
          model: event.model, effort: event.effort, previewMeta: null,
          startedAt: now,
          queuedTaskIds: remainingQueued && remainingQueued.length ? remainingQueued : undefined,
        });
        break;
      }
      case 'text': {
        const snap = this.streamSnapshots.get(sessionKey);
        if (snap) {
          snap.text = event.text;
          snap.thinking = event.thinking;
          snap.activity = event.activity;
          snap.plan = event.plan?.steps?.length ? event.plan : null;
          if (event.previewMeta) snap.previewMeta = event.previewMeta;
          snap.updatedAt = now;
        }
        break;
      }
      case 'artifact': {
        const snap = this.streamSnapshots.get(sessionKey);
        if (snap) {
          snap.artifacts = [...(snap.artifacts || []), event.artifact];
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
          incomplete: !!event.incomplete,
          text: prev?.text || '',
          thinking: prev?.thinking || '',
          activity: prev?.activity || '',
          error: event.error,
          plan: prev?.plan ?? null,
          model: prev?.model ?? null,
          effort: prev?.effort ?? null,
          previewMeta: prev?.previewMeta ?? null,
          artifacts: prev?.artifacts,
          startedAt: prev?.startedAt,
          queuedTaskIds: prev?.queuedTaskIds,
          updatedAt: now,
        });
        this.snapshotCleanupTimers.set(sessionKey, setTimeout(() => {
          this.streamSnapshots.delete(sessionKey);
          this.snapshotCleanupTimers.delete(sessionKey);
          this.forgetPromotion(sessionKey);
        }, 30_000));
        break;
      }
      case 'cancelled': {
        const snap = this.streamSnapshots.get(sessionKey);
        if (!snap) break;
        if (snap.queuedTaskIds?.includes(event.taskId)) {
          const next = snap.queuedTaskIds.filter(id => id !== event.taskId);
          snap.queuedTaskIds = next.length ? next : undefined;
          snap.updatedAt = now;
        } else if (snap.taskId === event.taskId) {
          this.streamSnapshots.delete(sessionKey);
          this.forgetPromotion(sessionKey);
        }
        break;
      }
      case 'interaction': {
        const snap = this.streamSnapshots.get(sessionKey);
        if (snap) {
          const list = snap.interactions || [];
          list.push(event.interaction);
          snap.interactions = list;
          snap.updatedAt = now;
        }
        break;
      }
      case 'interaction-resolved': {
        const snap = this.streamSnapshots.get(sessionKey);
        if (snap?.interactions) {
          snap.interactions = snap.interactions.filter(i => i.promptId !== event.promptId);
          if (!snap.interactions.length) delete snap.interactions;
          snap.updatedAt = now;
        }
        break;
      }
    }

    try {
      this.pushSnapshotToSSE(sessionKey, event.type !== 'text');
    } catch {  }
  }

  private liveSessionKey(taskId: string, fallback: string): string {
    return this.activeTasks.get(taskId)?.sessionKey || fallback;
  }

  protected emitStreamQueued(sessionKey: string, taskId: string) {
    this.emitStream(sessionKey, { type: 'queued', taskId, position: this.getQueuePosition(sessionKey, taskId) });
  }

  protected emitStreamStart(
    taskId: string,
    session: Pick<SessionRuntime, 'key' | 'agent' | 'sessionId' | 'workdir' | 'modelId' | 'thinkingEffort'>,
    opts?: { workflowEnabled?: boolean },
  ) {
    const cfg = this.resolveSessionStreamConfig(session, opts);
    const key = this.liveSessionKey(taskId, session.key);
    this.debug(`[stream-lifecycle] start task=${taskId} key=${key} sessionId=${session.sessionId || '(pending)'} model=${cfg.model || '-'}`);
    this.emitStream(key, {
      type: 'start', taskId, agent: session.agent, sessionId: session.sessionId,
      model: cfg.model, effort: cfg.effort,
    });
  }

  protected emitStreamText(
    taskId: string,
    fallbackKey: string,
    text: string,
    thinking: string,
    activity = '',
    meta?: StreamPreviewMeta,
    plan?: StreamPreviewPlan | null,
  ) {
    const key = this.liveSessionKey(taskId, fallbackKey);
    const snap = this.streamSnapshots.get(key);
    this.debug(`[stream-lifecycle] text task=${taskId} key=${key} bytes=${text.length}/${thinking.length} snap=${snap ? snap.phase : 'NONE'}`);
    this.emitStream(key, {
      type: 'text', text, thinking, activity, plan: plan ?? null, previewMeta: meta ?? null,
    });
  }

  protected emitStreamDone(taskId: string, fallbackKey: string, opts: { sessionId: string | null; incomplete: boolean; error?: string }) {
    const key = this.liveSessionKey(taskId, fallbackKey);
    this.debug(`[stream-lifecycle] done task=${taskId} key=${key} sessionId=${opts.sessionId || '(none)'} incomplete=${opts.incomplete}`);
    this.emitStream(key, {
      type: 'done', taskId,
      sessionId: opts.sessionId,
      incomplete: opts.incomplete,
      ...(opts.error ? { error: opts.error } : {}),
    });
  }

  protected emitStreamCancelled(taskId: string, fallbackKey: string) {
    this.emitStream(this.liveSessionKey(taskId, fallbackKey), { type: 'cancelled', taskId });
  }

  private buildArtifactSendFile(
    agent: Agent,
    sessionKey: string | null,
    cs: { sessionId?: string | null },
    inner?: McpSendFileCallback,
  ): McpSendFileCallback {
    return async (filePath, sendOpts) => {
      const result: McpSendFileResult = inner ? await inner(filePath, sendOpts) : { ok: true };
      if (!result.ok) return result;
      try {
        let sid = '';
        if (sessionKey) {
          const rt = this.getSessionRuntimeByKey(sessionKey, { allowAnyWorkdir: true });
          if (rt?.sessionId) sid = rt.sessionId;
        }
        if (!sid && typeof cs.sessionId === 'string') sid = cs.sessionId;
        if (!sid || isPendingSessionId(sid)) return result;

        const kind = sendOpts?.kind === 'photo' ? 'photo' : 'document';
        const taskId = sessionKey
          ? this.streamSnapshots.get(this.resolveSessionKey(sessionKey))?.taskId
          : undefined;
        const record = deliverArtifact(agent, sid, filePath, { kind, caption: sendOpts?.caption, ...(taskId ? { taskId } : {}) });
        if (record && sessionKey) {
          this.emitStream(this.resolveSessionKey(sessionKey), {
            type: 'artifact',
            artifact: {
              url: attachmentUrl(agent, sid, record.path, { downloadName: record.fileName }),
              fileName: record.fileName,
              fileSize: record.fileSize,
              mime: record.fileMime,
              kind: record.kind,
              ...(record.caption ? { caption: record.caption } : {}),
            },
          });
        }
      } catch (e: any) {
        this.warn(`[runStream] artifact record failed: ${e?.message || e}`);
      }
      return result;
    };
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
        workflowEnabled: false,
        accessMode: resolveClaudeAccessMode(config),
        extraArgs: shellSplit(process.env.CLAUDE_EXTRA_ARGS || ''),
      },
      gemini: {
        model: resolveAgentModel(config, 'gemini'),
        approvalMode: envString('GEMINI_APPROVAL_MODE', 'yolo'),
        sandbox: envBool('GEMINI_SANDBOX', false),
        extraArgs: shellSplit(process.env.GEMINI_EXTRA_ARGS || ''),
      },
      hermes: {
        model: resolveAgentModel(config, 'hermes'),
        reasoningEffort: resolveAgentEffort(config, 'hermes') || 'medium',
        extraArgs: shellSplit(process.env.HERMES_EXTRA_ARGS || ''),
      },
    };

    this.defaultAgent = normalizeAgent('codex');
    this.runTimeout = envInt('PIKILOOM_TIMEOUT', DEFAULT_RUN_TIMEOUT_S);
    this.allowedChatIds = parseAllowedChatIds(process.env.PIKILOOM_ALLOWED_IDS || '');
    this.refreshManagedConfig(getActiveUserConfig(), { initial: true });
    this.userConfigUnsubscribe = onUserConfigChange(config => this.refreshManagedConfig(config));
  }

  log(msg: string, level: LogLevel = 'info') {
    writeScopedLog('pikiloom', msg, { level });
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

  chatWorkdir(chatId: ChatId): string {
    return this.chats.get(chatId)?.workdir || this.workdir;
  }

  protected sessionKey(agent: Agent, sessionId: string): string {
    return `${agent}:${sessionId}`;
  }

  protected getSessionRuntimeByKey(sessionKey: string | null | undefined, opts: { allowAnyWorkdir?: boolean } = {}): SessionRuntime | null {
    if (!sessionKey) return null;
    const runtime = this.sessionStates.get(this.resolveSessionKey(sessionKey)) || null;
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
    handoverFrom?: HandoverRef | null;
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
      handoverFrom: session.handoverFrom ?? null,
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
    handoverFrom?: HandoverRef | null;
  }): SessionRuntime {
    const workdir = path.resolve(session.workdir || this.workdir);
    const requestedKey = this.sessionKey(session.agent, session.sessionId);
    const resolvedKey = this.resolveSessionKey(requestedKey);
    const existing = this.sessionStates.get(resolvedKey);
    if (existing) {
      existing.workdir = workdir;
      if (session.workspacePath !== undefined) existing.workspacePath = session.workspacePath ?? null;
      if (session.threadId !== undefined) existing.threadId = session.threadId ?? null;
      if (session.codexCumulative !== undefined) existing.codexCumulative = session.codexCumulative;
      if (session.modelId !== undefined) existing.modelId = session.modelId ?? null;
      if (session.thinkingEffort !== undefined) existing.thinkingEffort = session.thinkingEffort ?? null;
      if (session.handoverFrom !== undefined && !existing.handoverFrom) {
        existing.handoverFrom = session.handoverFrom;
      }
      return existing;
    }

    const runtime: SessionRuntime = {
      key: requestedKey,
      workdir,
      agent: session.agent,
      sessionId: session.sessionId,
      workspacePath: session.workspacePath ?? null,
      threadId: session.threadId ?? null,
      codexCumulative: session.codexCumulative,
      modelId: session.modelId ?? null,
      thinkingEffort: session.thinkingEffort ?? null,
      runningTaskIds: new Set<string>(),
      handoverFrom: session.handoverFrom ?? null,
    };
    this.sessionStates.set(requestedKey, runtime);
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

  protected adoptSession(cs: ChatState, session: Pick<SessionInfo, 'agent' | 'sessionId' | 'workdir' | 'workspacePath' | 'model' | 'title' | 'threadId' | 'thinkingEffort' | 'profileId'>) {
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
      thinkingEffort: session.thinkingEffort ?? null,
      profileId: session.profileId ?? null,
      threadId: session.threadId ?? null,
    });
    const runtime = this.hydrateSessionRuntime({
      agent: session.agent,
      sessionId: session.sessionId,
      workdir: 'workdir' in session ? session.workdir : null,
      workspacePath: managed.workspacePath ?? session.workspacePath ?? null,
      threadId: managed.threadId ?? session.threadId ?? null,
      modelId: session.model ?? managed.model ?? null,
      thinkingEffort: session.thinkingEffort ?? managed.thinkingEffort ?? null,
    });
    if (!runtime) {
      this.applySessionSelection(cs, null);
      return;
    }
    cs.pendingHandoverFrom = null;
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

    this.promotedSessionKeys.set(previousKey, nextKey);
    const aliases = new Set<string>(this.promotedFromAliases.get(nextKey) || []);
    aliases.add(previousKey);
    const ancestorAliases = this.promotedFromAliases.get(previousKey);
    if (ancestorAliases) {
      for (const alias of ancestorAliases) {
        aliases.add(alias);
        this.promotedSessionKeys.set(alias, nextKey);
      }
      this.promotedFromAliases.delete(previousKey);
    }
    this.promotedFromAliases.set(nextKey, [...aliases]);

    const promotedSnap = this.streamSnapshots.get(nextKey);
    if (promotedSnap) promotedSnap.sessionId = resolvedSessionId;

    if (this._onStreamSnapshot && promotedSnap) {
      this._onStreamSnapshot(previousKey, this.enrichSnapshot(promotedSnap));
    }

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
      cs.pendingHandoverFrom = null;
      this.applySessionSelection(cs, resumed);
      return resumed;
    }

    const wd = this.chatWorkdir(chatId);
    const handoverFrom = cs.pendingHandoverFrom ?? null;
    cs.pendingHandoverFrom = null;
    const staged = stageSessionFiles({
      agent: cs.agent,
      workdir: wd,
      files: [],
      sessionId: null,
      title: title || 'New session',
      threadId: cs.activeThreadId ?? null,
      handoverFrom,
    });
    const runtime = this.upsertSessionRuntime({
      agent: cs.agent,
      sessionId: staged.sessionId,
      workspacePath: staged.workspacePath,
      threadId: staged.threadId,
      modelId: this.modelForAgent(cs.agent),
      thinkingEffort: this.effortForAgent(cs.agent),
      handoverFrom: staged.handoverFrom,
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
    for (const taskId of session.runningTaskIds) {
      const task = this.activeTasks.get(taskId);
      if (!task) continue;
      if (!interrupted && task.status === 'running') {
        interrupted = true;
        task.cancelled = true;
        try { task.abort?.(); } catch {}
      }
    }
    return { interrupted, cancelledQueued: 0 };
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

  protected markQueueDeferralsForSteer(targetTaskId: string): void {
    const target = this.activeTasks.get(targetTaskId);
    if (!target) return;
    const snapshot = this.streamSnapshots.get(target.sessionKey);
    const queuedIds = snapshot?.queuedTaskIds || [];
    for (const id of queuedIds) {
      const t = this.activeTasks.get(id);
      if (t) t.deferForSteer = false;
    }
    for (const id of queuedIdsToDeferForSteer(queuedIds, targetTaskId)) {
      const t = this.activeTasks.get(id);
      if (t && t.status === 'queued' && !t.cancelled) t.deferForSteer = true;
    }
  }

  protected async steerTaskByActionId(actionId: string): Promise<{ task: RunningTask | null; interrupted: boolean; steered: boolean }> {
    const taskId = this.taskKeysByActionId.get(String(actionId));
    if (!taskId) return { task: null, interrupted: false, steered: false };
    const task = this.activeTasks.get(taskId) || null;
    if (!task || task.status !== 'queued') return { task, interrupted: false, steered: false };
    this.markQueueDeferralsForSteer(taskId);
    const interrupted = this.interruptRunningTask(task.sessionKey, { freezePreview: true });
    return { task, interrupted, steered: false };
  }

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

  protected queueSessionTask<T>(session: SessionRuntime, task: () => Promise<T>, taskId?: string): Promise<T> {
    const runner = async (): Promise<T> => {
      if (taskId) {
        const t = this.activeTasks.get(taskId);
        if (t?.deferForSteer && !t.cancelled) {
          t.deferForSteer = false;
          void this.queueSessionTask(session, task, taskId);
          return undefined as unknown as T;
        }
      }
      return await task();
    };
    const prev = this.sessionChains.get(session.key) || Promise.resolve();
    const current = prev.catch(() => {}).then(runner);
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
      silent: opts.silent,
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
    this.emitInteractionResolved(prompt.taskId, promptId);
    this.fireInteractionAnswered(prompt, 'answered');
    return prompt;
  }

  protected clearHumanLoopPrompt(promptId: string, error?: Error): HumanLoopPromptState<ChatId> | null {
    const prompt = this.humanLoopPrompts.get(promptId) || null;
    if (!prompt) return null;
    this.humanLoopPrompts.delete(promptId);
    this.removeHumanLoopPromptFromChat(prompt.chatId, promptId);
    if (error) prompt.reject(error);
    this.emitInteractionResolved(prompt.taskId, promptId);
    this.fireInteractionAnswered(prompt, 'cancelled');
    return prompt;
  }

  private fireInteractionAnswered(prompt: HumanLoopPromptState<ChatId>, status: ResolvedHumanLoopStatus) {
    if (prompt.silent) return;
    if ((prompt.chatId as unknown) === 'dashboard') return;
    const summary = summarizeResolvedHumanLoopAnswers(prompt, status);
    void Promise.resolve()
      .then(() => this.onInteractionAnswered(prompt, summary))
      .catch(err => this.warn(`onInteractionAnswered failed: ${err?.message || err}`));
  }

  protected async onInteractionAnswered(
    _prompt: HumanLoopPromptState<ChatId>,
    _summary: ResolvedHumanLoopAnswers,
  ): Promise<void> {
  }

  private emitInteractionResolved(taskId: string, promptId: string) {
    const task = this.activeTasks.get(taskId);
    if (task) this.emitStream(task.sessionKey, { type: 'interaction-resolved', promptId });
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

  protected createInteractionHandler(
    chatId: ChatId,
    taskId: string,
  ): (request: AgentInteraction) => Promise<Record<string, any> | null> {
    return async (request) => {
      const active = this.beginHumanLoopPrompt({
        taskId,
        chatId,
        title: request.title,
        hint: request.hint,
        questions: request.questions,
        resolveWith: request.resolveWith,
      });

      const interactionSnapshot: InteractionSnapshot = {
        promptId: active.prompt.promptId,
        kind: request.kind,
        title: request.title,
        hint: request.hint,
        questions: request.questions,
        currentIndex: active.prompt.currentIndex,
      };
      const task = this.activeTasks.get(taskId);
      if (task) this.emitStream(task.sessionKey, { type: 'interaction', taskId, interaction: interactionSnapshot });

      if ((chatId as unknown) !== 'dashboard') {
        try {
          await this.renderInteractionPrompt(active.prompt, chatId);
        } catch (error: any) {
          this.humanLoopCancel(active.prompt.promptId, error?.message || 'Failed to send prompt.');
          throw error;
        }
      }

      return active.result;
    };
  }

  protected async renderInteractionPrompt(_prompt: HumanLoopPromptState<ChatId>, _chatId: ChatId): Promise<void> {
  }

  interactionSelectOption(promptId: string, optionValue: string, opts?: { requestFreeform?: boolean }) {
    return this.humanLoopSelectOption(promptId, optionValue, opts);
  }

  interactionSubmitText(promptId: string, text: string) {
    const prompt = this.humanLoopPrompt(promptId);
    if (!prompt) return null;
    const question = currentHumanLoopQuestion(prompt);
    if (!question) return null;
    const hasOptions = !!question.options?.length;
    const freeformAllowed = !hasOptions || question.allowFreeform !== false;
    if (!freeformAllowed && !isHumanLoopAwaitingText(prompt)) return null;
    const result = setHumanLoopText(prompt, text);
    if (result.completed) this.resolveHumanLoopPrompt(prompt.promptId);
    return { prompt, ...result };
  }

  interactionSkip(promptId: string) {
    return this.humanLoopSkip(promptId);
  }

  interactionCancel(promptId: string, reason = 'Cancelled from dashboard.') {
    return this.humanLoopCancel(promptId, reason);
  }

  interactionPrompt(promptId: string) {
    return this.humanLoopPrompt(promptId);
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
      ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
      ...(opts.thinkingEffort !== undefined ? { thinkingEffort: opts.thinkingEffort } : {}),
      ...(opts.handoverFrom !== undefined ? { handoverFrom: opts.handoverFrom } : {}),
    });
    const taskId = `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const prompt = opts.prompt.trim();
    const attachments = opts.attachments || [];
    const chatId = opts.chatId ?? 'dashboard';

    this.beginTask({
      taskId,
      chatId,
      agent: session.agent,
      sessionKey: session.key,
      prompt,
      attachments,
      startedAt: Date.now(),
      sourceMessageId: opts.sourceMessageId ?? taskId,
    });
    this.emitStreamQueued(session.key, taskId);

    void this.queueSessionTask(session, async () => {
      const abortController = new AbortController();
      const task = this.markTaskRunning(taskId, () => abortController.abort());
      if (task?.cancelled) {
        this.emitStreamCancelled(taskId, session.key);
        this.finishTask(taskId);
        return;
      }

      this.emitStreamStart(taskId, session, { workflowEnabled: opts.workflowEnabled });

      const presenter = chatId !== 'dashboard'
        ? await this.createImTaskPresenter({
            chatId, taskId, session, agent: session.agent, prompt, attachments,
          }).catch(err => {
            this.warn(`[submitSessionTask] presenter setup failed task=${taskId}: ${err?.message || err}`);
            return null;
          })
        : null;

      try {
        const extras: RunStreamExtras = {
          ...(opts.forkOf ? { forkOf: opts.forkOf } : {}),
          ...(opts.workflowEnabled !== undefined ? { workflowEnabled: opts.workflowEnabled } : {}),
          ...(opts.profileId !== undefined ? { profileId: opts.profileId } : {}),
          onPreparedPrompt: (preparedPrompt) => this.updateTaskPrompt(taskId, session.key, preparedPrompt),
        };

        const result = await this.runStream(
          prompt,
          session,
          attachments,
          (text, thinking, activity, meta, plan) => {
            opts.onText?.(text, thinking, activity, meta, plan);
            presenter?.onText(text, thinking, activity, meta, plan);
            this.emitStreamText(taskId, session.key, text, thinking, activity, meta, plan);
          },
          undefined,
          undefined,
          abortController.signal,
          this.createInteractionHandler(chatId, taskId),
          undefined,
          undefined,
          extras,
        );
        this.emitStreamDone(taskId, session.key, {
          sessionId: result.sessionId || session.sessionId,
          incomplete: !!result.incomplete,
          ...(result.ok ? {} : { error: result.error || result.message }),
        });
        if (presenter) {
          try { await presenter.onSuccess(result); }
          catch (e: any) { this.warn(`[submitSessionTask] presenter onSuccess failed task=${taskId}: ${e?.message || e}`); }
        }
        try {
          this.maybeEnqueueGoalContinuation(session, opts, result);
        } catch (err: any) {
          this.debug(`[goal-continuation] enqueue failed: ${err?.message || err}`);
        }
      } catch (error: any) {
        const errMsg = error?.message || String(error);
        this.emitStreamDone(taskId, session.key, {
          sessionId: session.sessionId,
          incomplete: true,
          error: errMsg,
        });
        if (presenter) {
          try { await presenter.onFailure(errMsg); }
          catch (e: any) { this.warn(`[submitSessionTask] presenter onFailure failed task=${taskId}: ${e?.message || e}`); }
        }
      } finally {
        presenter?.dispose();
        this.finishTask(taskId);
        this.syncSelectedChats(session);
      }
    }, taskId).catch(error => {
      this.finishTask(taskId);
      this.error(`[submitSessionTask] queue failed task=${taskId} error=${error?.message || error}`);
    });

    return { ok: true, taskId, sessionKey: session.key, queued: true };
  }

  protected async createImTaskPresenter(_opts: ImTaskPresenterOpts): Promise<ImTaskPresenter | null> {
    return null;
  }

  private maybeEnqueueGoalContinuation(
    session: SessionRuntime,
    opts: SubmitSessionTaskOpts,
    result: StreamResult,
  ): void {
    if (session.agent === 'codex' || session.agent === 'claude') return;
    const sessionId = (result.sessionId || session.sessionId || '').trim();
    if (!sessionId || isPendingSessionId(sessionId)) return;
    const workdir = session.workdir;
    const agent = session.agent;
    const goalBefore = readGoal(workdir, agent, sessionId);
    if (!goalBefore) return;

    if (!result.ok || result.incomplete) {
      if (opts.goalContinuation && goalBefore.status === 'active') {
        pauseGoal(workdir, agent, sessionId);
        this.debug(`[goal-continuation] paused goal=${goalBefore.goalId} after failed continuation`);
      }
      return;
    }
    if (goalBefore.status !== 'active') return;

    const usedTokens = Math.max(0, (result.inputTokens || 0) + (result.outputTokens || 0));
    const seconds = Math.max(0, Math.floor(result.elapsedS || 0));
    const { goal, budgetJustCrossed } = accountTurn(workdir, agent, sessionId, {
      tokens: usedTokens,
      seconds,
    });
    if (!goal) return;

    if (budgetJustCrossed) {
      const prompt = renderBudgetLimitPrompt(goal);
      this.debug(`[goal-continuation] budget exhausted goal=${goal.goalId} — enqueue wrap-up turn`);
      this.submitSessionTask({
        agent,
        sessionId,
        workdir,
        prompt,
        chatId: opts.chatId,
        modelId: opts.modelId,
        thinkingEffort: opts.thinkingEffort,
        goalContinuation: { kind: 'budget_wrapup', goalId: goal.goalId },
      });
      return;
    }

    const decision = shouldContinueAfterTurn(goal);
    if (!decision.shouldContinue) {
      this.debug(`[goal-continuation] stop goal=${goal.goalId} reason=${decision.reason}`);
      return;
    }

    const updated = bumpContinuationCount(workdir, agent, sessionId);
    if (!updated) return;
    const prompt = renderContinuationPrompt(updated);
    this.debug(`[goal-continuation] continue goal=${updated.goalId} count=${updated.continuationCount} tokens=${updated.tokensUsed}/${updated.tokenBudget ?? '∞'}`);
    this.submitSessionTask({
      agent,
      sessionId,
      workdir,
      prompt,
      chatId: opts.chatId,
      modelId: opts.modelId,
      thinkingEffort: opts.thinkingEffort,
      goalContinuation: { kind: 'continuation', goalId: updated.goalId },
    });
  }

  async getSessionGoal(workdir: string, agent: Agent, sessionId: string): Promise<SessionGoalView | null> {
    if (agent === 'codex') {
      if (!sessionId || isPendingSessionId(sessionId)) return null;
      const goal = await getCodexGoal(sessionId);
      return goal ? normalizeFromCodex(goal) : null;
    }
    if (agent === 'claude') {
      if (!sessionId || isPendingSessionId(sessionId)) return null;
      const goal = getClaudeNativeGoal(workdir, sessionId);
      return goal ? normalizeFromClaudeNative(goal) : null;
    }
    const goal = readGoal(workdir, agent, sessionId);
    return goal ? normalizeFromPikiloom(goal) : null;
  }

  async setSessionGoal(
    workdir: string,
    agent: Agent,
    sessionId: string,
    opts: { objective: string; tokenBudget?: number | null; chatId?: ChatId; modelId?: string | null; thinkingEffort?: string | null },
  ): Promise<SessionGoalView> {
    if (agent === 'codex') {
      if (!sessionId || isPendingSessionId(sessionId)) {
        throw new Error('codex session must exist before /goal — send a first message to create the thread');
      }
      const resp = await setCodexGoal({
        threadId: sessionId,
        objective: opts.objective,
        status: 'active',
        tokenBudget: opts.tokenBudget ?? null,
      });
      if (!resp.ok) throw new Error(resp.error);
      const goal = resp.goal ?? (await getCodexGoal(sessionId));
      if (!goal) throw new Error('codex did not return a goal snapshot');
      return normalizeFromCodex(goal);
    }
    if (agent === 'claude') {
      if (!sessionId || isPendingSessionId(sessionId)) {
        throw new Error('claude session must exist before /goal — send a first message to create the transcript');
      }
      const objective = opts.objective.trim();
      if (!objective) throw new Error('objective must be non-empty');
      this.submitSessionTask({
        agent,
        sessionId,
        workdir,
        prompt: buildClaudeSetGoalPrompt(objective),
        chatId: opts.chatId,
        modelId: opts.modelId,
        thinkingEffort: opts.thinkingEffort,
      });
      return normalizeFromClaudeNative({
        condition: objective,
        status: 'active',
        met: false,
        updatedAtMs: Date.now(),
      });
    }
    const goal = setGoalState(workdir, agent, sessionId, {
      objective: opts.objective,
      tokenBudget: opts.tokenBudget ?? null,
    });
    if (!isPendingSessionId(sessionId)) {
      const prompt = renderContinuationPrompt(goal);
      this.submitSessionTask({
        agent,
        sessionId,
        workdir,
        prompt,
        chatId: opts.chatId,
        modelId: opts.modelId,
        thinkingEffort: opts.thinkingEffort,
        goalContinuation: { kind: 'continuation', goalId: goal.goalId },
      });
    }
    return normalizeFromPikiloom(goal);
  }

  async pauseSessionGoal(workdir: string, agent: Agent, sessionId: string): Promise<SessionGoalView | null> {
    if (agent === 'codex') {
      if (!sessionId || isPendingSessionId(sessionId)) return null;
      const resp = await pauseCodexGoal(sessionId);
      if (!resp.ok) throw new Error(resp.error);
      const goal = resp.goal ?? (await getCodexGoal(sessionId));
      return goal ? normalizeFromCodex(goal) : null;
    }
    if (agent === 'claude') {
      throw new Error('Claude native /goal does not support pause/resume — only `/goal clear`. Re-issue `/goal <objective>` to start fresh.');
    }
    const goal = pauseGoal(workdir, agent, sessionId);
    return goal ? normalizeFromPikiloom(goal) : null;
  }

  async resumeSessionGoal(
    workdir: string,
    agent: Agent,
    sessionId: string,
    opts: { chatId?: ChatId; modelId?: string | null; thinkingEffort?: string | null } = {},
  ): Promise<SessionGoalView | null> {
    if (agent === 'codex') {
      if (!sessionId || isPendingSessionId(sessionId)) return null;
      const resp = await resumeCodexGoal(sessionId);
      if (!resp.ok) throw new Error(resp.error);
      const goal = resp.goal ?? (await getCodexGoal(sessionId));
      return goal ? normalizeFromCodex(goal) : null;
    }
    if (agent === 'claude') {
      throw new Error('Claude native /goal does not support pause/resume — re-issue `/goal <objective>` to start fresh.');
    }
    const goal = resumeGoal(workdir, agent, sessionId);
    if (!goal || goal.status !== 'active') return goal ? normalizeFromPikiloom(goal) : null;
    if (!isPendingSessionId(sessionId)) {
      const prompt = renderContinuationPrompt(goal);
      this.submitSessionTask({
        agent,
        sessionId,
        workdir,
        prompt,
        chatId: opts.chatId,
        modelId: opts.modelId,
        thinkingEffort: opts.thinkingEffort,
        goalContinuation: { kind: 'continuation', goalId: goal.goalId },
      });
    }
    return normalizeFromPikiloom(goal);
  }

  async clearSessionGoal(workdir: string, agent: Agent, sessionId: string, opts: { chatId?: ChatId; modelId?: string | null; thinkingEffort?: string | null } = {}): Promise<void> {
    if (agent === 'codex') {
      if (!sessionId || isPendingSessionId(sessionId)) return;
      const resp = await clearCodexGoal(sessionId);
      if (!resp.ok) throw new Error(resp.error);
      return;
    }
    if (agent === 'claude') {
      if (!sessionId || isPendingSessionId(sessionId)) return;
      const existing = getClaudeNativeGoal(workdir, sessionId);
      if (!existing) return;
      this.submitSessionTask({
        agent,
        sessionId,
        workdir,
        prompt: buildClaudeClearGoalPrompt(),
        chatId: opts.chatId,
        modelId: opts.modelId,
        thinkingEffort: opts.thinkingEffort,
      });
      return;
    }
    clearGoalState(workdir, agent, sessionId);
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
    this.markQueueDeferralsForSteer(taskId);
    const interrupted = this.interruptRunningTask(task.sessionKey, { freezePreview: true });
    return { task, interrupted, steered: interrupted || !!task };
  }

  stopAllSessionTasks(sessionKey: string | null | undefined): { interrupted: boolean; cancelledQueued: number } {
    return this.stopTasksForSession(sessionKey);
  }

  resetConversationForChat(chatId: ChatId): void {
    const cs = this.chat(chatId);
    this.resetChatConversation(cs);
  }

  adoptExistingSessionForChat(
    chatId: ChatId,
    session: Pick<SessionInfo, 'agent' | 'sessionId' | 'workdir' | 'workspacePath' | 'model' | 'title' | 'threadId' | 'thinkingEffort' | 'profileId'>,
  ): SessionRuntime | null {
    const cs = this.chat(chatId);
    this.adoptSession(cs, session);
    return this.getSelectedSession(cs);
  }

  resumeSessionForChat(
    chatId: ChatId,
    session: Pick<SessionInfo, 'agent' | 'sessionId' | 'workdir' | 'workspacePath' | 'model' | 'title' | 'threadId' | 'thinkingEffort' | 'profileId'>,
  ): SessionRuntime | null {
    const runtime = this.adoptExistingSessionForChat(chatId, session);
    if (session.model) {
      this.switchModelForChat(chatId, session.model, session.profileId ?? null);
    } else if (session.profileId !== undefined) {
      this.switchModelForChat(chatId, this.modelForAgent(session.agent), null);
    }
    if (session.thinkingEffort) {
      this.switchEffortForChat(chatId, session.thinkingEffort);
    }
    return runtime;
  }

  switchAgentForChat(chatId: ChatId, agent: Agent): boolean {
    const cs = this.chat(chatId);
    if (cs.agent === agent) return false;
    const prevAgent = cs.agent;
    const prevSessionId = cs.sessionId && !isPendingSessionId(cs.sessionId) ? cs.sessionId : null;
    cs.agent = agent;

    const resumed = this.findThreadSessionRuntime(chatId, cs.activeThreadId, agent);
    if (resumed) {
      cs.pendingHandoverFrom = null;
      this.applySessionSelection(cs, resumed);
      this.log(`agent switched to ${agent} chat=${chatId} resumed=${resumed.sessionId}`);
      return true;
    }
    if (prevSessionId) {
      cs.pendingHandoverFrom = { agent: prevAgent, sessionId: prevSessionId };
    }
    this.resetChatConversation(cs, { clearThread: false });
    this.log(
      `agent switched to ${agent} chat=${chatId} handoverFrom=${describeHandoverRef(cs.pendingHandoverFrom)}`,
    );
    return true;
  }

  switchModelForChat(chatId: ChatId, modelId: string, profileId?: string | null) {
    const cs = this.chat(chatId);
    if (profileId !== undefined) {
      setActiveProfile(cs.agent, profileId || null);
    }
    this.setModelForAgent(cs.agent, modelId);
    cs.modelId = modelId;
    const session = this.getSelectedSession(cs);
    if (session) session.modelId = modelId;
    this.persistAgentPreference(cs.agent, 'model', modelId);
    const profileTag = profileId === undefined
      ? ''
      : profileId
        ? ` profile=${profileId}`
        : ' profile=(cleared)';
    this.log(`model switched to ${modelId} for ${cs.agent} chat=${chatId} session=${cs.activeSessionKey || '(none)'}${profileTag}`);
  }

  activeProfileIdForAgent(agent: Agent): string | null {
    return getActiveProfileId(agent);
  }

  switchEffortForChat(chatId: ChatId, effort: string) {
    const cs = this.chat(chatId);
    const { effort: realEffort, workflow } = splitEffortForAgent(cs.agent, effort);

    this.setEffortForAgent(cs.agent, realEffort);
    const session = this.getSelectedSession(cs);
    if (session) session.thinkingEffort = realEffort;
    this.persistAgentPreference(cs.agent, 'effort', realEffort);

    if (getDriverCapabilities(cs.agent).workflow) {
      this.setWorkflowEnabledForAgent(cs.agent, workflow);
      this.persistAgentPreference(cs.agent, 'workflow', workflow ? '1' : '0');
    }
    this.log(`effort switched to ${effort} (effort=${realEffort}, workflow=${workflow}) for ${cs.agent} chat=${chatId}`);
  }

  effortSelectionForAgent(agent: Agent): string | null {
    const effort = this.effortForAgent(agent);
    if (!effort) return null;
    if (getDriverCapabilities(agent).workflow && this.workflowEnabledForAgent(agent)) return 'ultra';
    return effort;
  }

  switchPermissionModeForChat(chatId: ChatId, mode: string) {
    const cs = this.chat(chatId);
    if (cs.agent === 'claude') {
      this.agentConfigs.claude.permissionMode = mode;
      this.resetChatConversation(cs);
      this.log(`permission mode switched to ${mode} for claude chat=${chatId}`);
    }
  }

  switchWorkflowForChat(chatId: ChatId, enabled: boolean) {
    const cs = this.chat(chatId);
    if (!getDriverCapabilities(cs.agent).workflow) {
      this.log(`workflow toggle ignored: ${cs.agent} does not support orchestration`);
      return;
    }
    this.setWorkflowEnabledForAgent(cs.agent, enabled);
    this.persistAgentPreference(cs.agent, 'workflow', enabled ? '1' : '0');
    this.log(`workflow ${enabled ? 'enabled' : 'disabled'} for ${cs.agent} chat=${chatId}`);
  }

  modelForAgent(agent: Agent): string {
    const profile = getActiveProfile(agent);
    if (profile?.modelId) return profile.modelId;
    if (agent === 'hermes') {
      const bound = getAgentBoundModelId('hermes');
      if (bound) return bound;
    }
    return this.agentConfigs[agent]?.model || '';
  }

  resolveSessionStreamConfig(
    cs: Pick<SessionRuntime, 'agent' | 'sessionId' | 'workdir' | 'modelId' | 'thinkingEffort'>,
    opts?: { workflowEnabled?: boolean },
  ): { model: string | null; effort: string | null } {
    const agentConfig = this.agentConfigs[cs.agent] || {};
    const sessionWorkdir = cs.workdir || this.workdir;
    const storedConfig = cs.sessionId && !isPendingSessionId(cs.sessionId)
      ? getSessionStoredConfig(sessionWorkdir, cs.agent, cs.sessionId)
      : null;
    const model = (cs.modelId && cs.modelId.trim())
      || (storedConfig?.model || '')
      || this.modelForAgent(cs.agent)
      || null;
    const effortRaw = (cs.thinkingEffort && cs.thinkingEffort.trim().toLowerCase())
      || (storedConfig?.thinkingEffort || '')
      || agentConfig.reasoningEffort
      || 'high';
    const effort = cs.agent === 'gemini' ? null : (effortRaw || null);
    const workflowOn = opts?.workflowEnabled ?? this.workflowEnabledForAgent(cs.agent);
    const displayEffort = effort && getDriverCapabilities(cs.agent).workflow && workflowOn
      ? 'ultra'
      : effort;
    return { model: model || null, effort: displayEffort };
  }

  fetchSessions(agent: Agent | undefined, workdir?: string): Promise<SessionQueryResult> {
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
    return resolveAgentModels(agent, { workdir: wd, currentModel: this.modelForAgent(agent) });
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
    return this.agentConfigs[agent]?.reasoningEffort || 'high';
  }

  setEffortForAgent(agent: Agent, effort: string) {
    const config = this.agentConfigs[agent];
    if (config) config.reasoningEffort = effort;
    this.log(`effort for ${agent} changed to ${effort}`);
  }

  workflowEnabledForAgent(agent: Agent): boolean {
    return this.agentConfigs[agent]?.workflowEnabled ?? false;
  }

  setWorkflowEnabledForAgent(agent: Agent, enabled: boolean) {
    const config = this.agentConfigs[agent];
    if (config) config.workflowEnabled = enabled;
    this.log(`workflow for ${agent} changed to ${enabled}`);
  }

  setClaudeAccessMode(mode: ClaudeAccessMode) {
    const config = this.agentConfigs.claude;
    if (config) config.accessMode = mode;
    this.log(`claude access mode changed to ${mode}`);
  }

  private persistAgentPreference(agent: Agent, kind: 'model' | 'effort' | 'workflow', value: string) {
    try {
      if (kind === 'model' && agent === 'hermes' && setAgentBoundModelId('hermes', value)) return;

      if (kind === 'workflow') {
        if (agent === 'claude') updateUserConfig({ claudeWorkflowEnabled: value === '1' });
        return;
      }

      const patch: Record<string, string> = {};
      if (kind === 'model') {
        if (agent === 'claude') patch.claudeModel = value;
        else if (agent === 'codex') patch.codexModel = value;
        else if (agent === 'gemini') patch.geminiModel = value;
        else if (agent === 'hermes') patch.hermesModel = value;
      } else {
        if (agent === 'claude') patch.claudeReasoningEffort = value;
        else if (agent === 'codex') patch.codexReasoningEffort = value;
        else if (agent === 'gemini') patch.geminiReasoningEffort = value;
        else if (agent === 'hermes') patch.hermesReasoningEffort = value;
      }
      if (Object.keys(patch).length) updateUserConfig(patch);
    } catch (e: any) {
      this.warn(`persistAgentPreference failed: ${e?.message || e}`);
    }
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
    const resolvedPath = path.resolve(expandTilde(newPath));
    if (opts.persist !== false) {
      setUserWorkdir(resolvedPath, { notify: false });
    } else {
      process.env.PIKILOOM_WORKDIR = resolvedPath;
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

  public run(): Promise<void> {
    throw new Error('Bot.run() must be implemented by a channel subclass');
  }

  public requestStop(): void {
    this.userConfigUnsubscribe?.();
    this.userConfigUnsubscribe = null;
  }

  private reconcileStaleRunningSessions() {
    const seen = new Set<string>();
    const candidates: string[] = [this.workdir];
    try {
      for (const ws of loadWorkspaces()) candidates.push(ws.path);
    } catch {}
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      try { reconcileOrphanedRunningSessions(resolved); } catch {}
    }
  }

  private refreshManagedConfig(config: Record<string, any>, opts: { initial?: boolean } = {}) {
    const nextWorkdir = resolveUserWorkdir({ config });
    if (opts.initial) {
      this.workdir = nextWorkdir;
      ensureGitignore(this.workdir);
      initializeProjectSkills(this.workdir);
      this.reconcileStaleRunningSessions();
    } else if (nextWorkdir !== this.workdir) {
      this.switchWorkdir(nextWorkdir, { persist: false });
    }

    const nextDefaultAgent = resolveDefaultAgent(config.defaultAgent || 'codex', listAgents().agents);
    if (opts.initial) this.defaultAgent = nextDefaultAgent;
    else if (nextDefaultAgent !== this.defaultAgent) this.setDefaultAgent(nextDefaultAgent);

    for (const agent of ['claude', 'codex', 'gemini', 'hermes'] as Agent[]) {
      const nextModel = resolveAgentModel(config, agent);
      if (nextModel && this.modelForAgent(agent) !== nextModel) {
        if (opts.initial) this.agentConfigs[agent].model = nextModel;
        else this.setModelForAgent(agent, nextModel);
      }

      const nextEffort = resolveAgentEffort(config, agent);
      if (nextEffort && this.effortForAgent(agent) !== nextEffort) {
        if (opts.initial) this.agentConfigs[agent].reasoningEffort = nextEffort;
        else this.setEffortForAgent(agent, nextEffort);
      }
      if (agent === 'claude') {
        const nextAccessMode = resolveClaudeAccessMode(config);
        if (this.claudeAccessMode !== nextAccessMode) {
          if (opts.initial) this.agentConfigs.claude.accessMode = nextAccessMode;
          else this.setClaudeAccessMode(nextAccessMode);
        }
      }
    }

    if (!opts.initial) this.onManagedConfigChange(config, opts);
  }

  async runStream(
    prompt: string, cs: Pick<SessionRuntime, 'key' | 'workdir' | 'agent' | 'sessionId' | 'workspacePath' | 'codexCumulative' | 'modelId' | 'thinkingEffort' | 'threadId' | 'handoverFrom'> | ChatState, attachments: string[],
    onText: (text: string, thinking: string, activity?: string, meta?: StreamPreviewMeta, plan?: StreamPreviewPlan | null) => void,
    systemPrompt?: string,
    mcpSendFile?: import('../agent/mcp/bridge.js').McpSendFileCallback,
    abortSignal?: AbortSignal,
    onInteraction?: (request: AgentInteraction) => Promise<Record<string, any> | null>,
    onSteerReady?: (steer: (prompt: string, attachments?: string[]) => Promise<boolean>) => void,
    onCodexTurnReady?: (control: CodexTurnControl) => void,
    extras?: RunStreamExtras,
  ): Promise<StreamResult> {
    const agentConfig = this.agentConfigs[cs.agent] || {};
    const sessionWorkdirForConfig = 'workdir' in cs && typeof cs.workdir === 'string' && cs.workdir ? cs.workdir : this.workdir;
    const storedConfig = cs.sessionId && !isPendingSessionId(cs.sessionId)
      ? getSessionStoredConfig(sessionWorkdirForConfig, cs.agent, cs.sessionId)
      : null;
    const resolvedModel = cs.modelId || storedConfig?.model || this.modelForAgent(cs.agent);
    const resolvedThinkingEffort = ('thinkingEffort' in cs && typeof cs.thinkingEffort === 'string' && cs.thinkingEffort.trim())
      ? cs.thinkingEffort.trim().toLowerCase()
      : (storedConfig?.thinkingEffort || agentConfig.reasoningEffort || 'high');
    const extraArgs: string[] = agentConfig.extraArgs || [];
    const browserEnabled = resolveGuiIntegrationConfig(getActiveUserConfig()).browserEnabled;
    const sessionWorkdir = 'workdir' in cs && typeof cs.workdir === 'string' && cs.workdir
      ? path.resolve(cs.workdir)
      : this.workdir;
    this.debug(`[runStream] agent=${cs.agent} session=${cs.sessionId || '(new)'} workdir=${sessionWorkdir} timeout=${this.runTimeout}s attachments=${attachments.length}`);
    this.debug(`[runStream] ${cs.agent} config: model=${resolvedModel} extraArgs=[${extraArgs.join(' ')}]`);
    const isFirstTurnOfSession = !cs.sessionId || isPendingSessionId(cs.sessionId);

    const handoverFrom = ('handoverFrom' in cs && cs.handoverFrom) ? cs.handoverFrom : null;
    if (isFirstTurnOfSession && handoverFrom) {
      try {
        const result = await compactForHandover({
          fromAgent: handoverFrom.agent,
          fromSessionId: handoverFrom.sessionId,
          workdir: sessionWorkdir,
          toAgent: cs.agent,
          toModel: resolvedModel,
        });
        if (result.ok && result.seed) {
          prompt = result.seed + '\n\n' + prompt;
          extras?.onPreparedPrompt?.(prompt);
          this.debug(
            `[runStream] handover ${describeHandoverRef(handoverFrom)} → ${cs.agent} `
            + `mode=${result.mode} msgs=${result.messagesIncluded}/${result.messagesTotal} `
            + `turnsTotal=${result.turnsTotal} chars=${result.charsIncluded}/${result.budgetChars}`,
          );
        } else {
          this.warn(
            `[runStream] handover ${describeHandoverRef(handoverFrom)} → ${cs.agent} `
            + `failed (${result.error || 'unknown'}); proceeding without prior context`,
          );
        }
      } catch (e: any) {
        this.warn(`[runStream] handover threw: ${e?.message || e}; proceeding without prior context`);
      }
    }
    const workflowEnabled = cs.agent === 'claude' && (extras?.workflowEnabled ?? this.claudeWorkflowEnabled);

    const deliverySessionKey = ('key' in cs && typeof cs.key === 'string') ? cs.key : null;
    const wrappedSendFile = this.buildArtifactSendFile(cs.agent, deliverySessionKey, cs, mcpSendFile);

    // Session tool capabilities (im_send_file / im_ask_user) bundle their usage prompt with
    // the tool itself — see agent/mcp/capabilities.ts. Browser/workflow remain session policy.
    const mcpSystemPrompt = appendExtraPrompt(
      appendExtraPrompt(
        composeSessionToolPrompt({ agent: cs.agent, onInteraction: !!onInteraction }),
        buildBrowserAutomationPrompt(browserEnabled),
      ),
      workflowEnabled ? buildWorkflowOptInPrompt() : '',
    );
    const effectiveSystemPrompt = isFirstTurnOfSession
      ? appendExtraPrompt(systemPrompt, mcpSystemPrompt)
      : (mcpSystemPrompt || undefined);
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
      profileId: extras?.profileId,
      thinkingEffort: resolvedThinkingEffort, onText,
      onSessionId: syncNativeSessionId,
      attachments: attachments.length ? attachments : undefined,
      codexModel: cs.agent === 'codex' ? resolvedModel : this.codexModel,
      codexFullAccess: this.codexFullAccess,
      codexDeveloperInstructions: effectiveSystemPrompt || undefined,
      codexExtraArgs: this.codexExtraArgs.length ? this.codexExtraArgs : undefined,
      codexPrevCumulative: cs.codexCumulative,
      claudeModel: cs.agent === 'claude' ? resolvedModel : this.claudeModel,
      claudePermissionMode: this.claudePermissionMode,
      claudeWorkflowEnabled: workflowEnabled,
      claudeAccessMode: cs.agent === 'claude' ? this.claudeAccessMode : undefined,
      claudeAppendSystemPrompt: effectiveSystemPrompt || undefined,
      claudeExtraArgs: this.claudeExtraArgs.length ? this.claudeExtraArgs : undefined,
      geminiModel: cs.agent === 'gemini' ? resolvedModel : (this.agentConfigs.gemini?.model || ''),
      geminiApprovalMode: this.geminiApprovalMode,
      geminiSandbox: this.geminiSandbox,
      geminiSystemInstruction: effectiveSystemPrompt || undefined,
      geminiExtraArgs: this.geminiExtraArgs.length ? this.geminiExtraArgs : undefined,
      hermesModel: cs.agent === 'hermes' && resolvedModel ? resolvedModel : undefined,
      mcpSendFile: wrappedSendFile,
      abortSignal,
      onInteraction,
      onSteerReady,
      onCodexTurnReady,
      forkOf: extras?.forkOf,
    };
    let result: StreamResult;
    try {
      result = await doStream(opts);
    } catch (e: any) {
      appendTurnAudit({
        agent: cs.agent, sessionId: cs.sessionId || null, ok: false, stopReason: 'exception',
        incomplete: true, error: String(e?.message || e).slice(0, 500), promptPreview: prompt.slice(0, 120),
      });
      throw e;
    }
    appendTurnAudit({
      agent: cs.agent, sessionId: result.sessionId || cs.sessionId || null,
      ok: result.ok, stopReason: result.stopReason ?? null, incomplete: !!result.incomplete,
      error: result.error ? String(result.error).slice(0, 500) : null,
      elapsedS: result.elapsedS, model: result.model ?? resolvedModel, promptPreview: prompt.slice(0, 120),
    });
    // Durable copy of what we just delivered, so the history render can restore it if the CLI's
    // jsonl later loses this turn to a flush race or an in-place resume rewrite (the swallow).
    // claude-only: it is the driver whose renderer knows how to merge these at a tombstone.
    if (cs.agent === 'claude') {
      recordDeliveredTurn({
        sessionId: result.sessionId || cs.sessionId || null,
        prompt, message: result.message, model: result.model ?? resolvedModel ?? null,
        ok: result.ok, stopReason: result.stopReason ?? null,
      });
    }
    if (cs.agent === 'claude' && workflowEnabled && result.thinkingEffort) {
      result.thinkingEffort = 'ultra';
    }
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
          '--what=idle', '--who=pikiloom', '--why=AI coding agent running', 'sleep', 'infinity',
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
