/**
 * driver-codex.ts — Codex CLI agent driver.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { registerDriver, type AgentDriver } from './agent-driver.js';
import {
  type AgentInfo, type StreamOpts, type StreamResult,
  type StreamPreviewMeta, type StreamPreviewPlan, type StreamPreviewPlanStep,
  type CodexCumulativeUsage,
  type SessionListResult, type SessionTailOpts, type SessionTailResult,
  type ModelListOpts, type ModelListResult, type ModelInfo,
  type UsageOpts, type UsageResult, type UsageWindowInfo,
  // shared helpers
  agentLog, detectAgentBin,
  buildStreamPreviewMeta, pushRecentActivity, normalizeActivityLine,
  firstNonEmptyLine, shortValue, numberOrNull,
  IMAGE_EXTS,
  listCodeclawSessions, findCodeclawSessionByLocalId,
  stripInjectedPrompts, computeContext,
  roundPercent, toIsoFromEpochSeconds, labelFromWindowMinutes,
  usageWindowFromRateLimit, parseJsonTail, emptyUsage,
  Q,
} from './code-agent.js';

// ---------------------------------------------------------------------------
// App-server JSON-RPC client
// ---------------------------------------------------------------------------

const CODEX_APPSERVER_SPAWN_TIMEOUT_MS = 15_000;

type RpcCallback = (msg: any) => void;
type NotificationHandler = (method: string, params: any) => void;

export class CodexAppServer {
  private proc: ReturnType<typeof spawn> | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, RpcCallback>();
  private notificationHandlers = new Set<NotificationHandler>();
  private ready = false;
  private startPromise: Promise<boolean> | null = null;
  private configOverrides: string[] = [];

  async ensureRunning(extraConfig?: string[]): Promise<boolean> {
    if (this.ready && this.proc && !this.proc.killed) return true;
    if (this.startPromise) return this.startPromise;
    this.configOverrides = extraConfig ?? [];
    this.startPromise = this._start();
    const ok = await this.startPromise;
    this.startPromise = null;
    return ok;
  }

  private _start(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.kill(); resolve(false); }, CODEX_APPSERVER_SPAWN_TIMEOUT_MS);
      const args = ['app-server'];
      for (const c of this.configOverrides) args.push('-c', c);
      agentLog(`[codex-rpc] spawning: codex ${args.join(' ')}`);
      const proc = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      this.buf = '';
      this.nextId = 1;
      this.pending.clear();
      this.ready = false;

      proc.stderr?.on('data', (c: Buffer) => { agentLog(`[codex-rpc][stderr] ${c.toString().trim().slice(0, 200)}`); });
      proc.stdout.on('data', (chunk: Buffer) => {
        this.buf += chunk.toString('utf-8');
        const lines = this.buf.split('\n');
        this.buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id != null) {
            const cb = this.pending.get(msg.id);
            if (cb) { this.pending.delete(msg.id); cb(msg); }
          }
          if (msg.method && msg.id == null) {
            for (const handler of [...this.notificationHandlers]) handler(msg.method, msg.params ?? {});
          }
        }
      });

      proc.on('error', () => { clearTimeout(timer); this.ready = false; resolve(false); });
      proc.on('close', () => { this.ready = false; this.proc = null; });

      this.call('initialize', { clientInfo: { name: 'codeclaw', version: '0.2.0' } })
        .then(resp => {
          clearTimeout(timer);
          if (resp.error) { agentLog(`[codex-rpc] init error: ${resp.error.message}`); resolve(false); return; }
          this.ready = true;
          agentLog(`[codex-rpc] initialized`);
          resolve(true);
        })
        .catch(() => { clearTimeout(timer); resolve(false); });
    });
  }

  call(method: string, params?: any): Promise<any> {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed) { resolve({ error: { message: 'not connected' } }); return; }
      const id = this.nextId++;
      this.pending.set(id, resolve);
      const msg: any = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      try { this.proc.stdin!.write(JSON.stringify(msg) + '\n'); } catch { resolve({ error: { message: 'write failed' } }); }
    });
  }

  notify(method: string, params?: any): void {
    if (!this.proc || this.proc.killed) return;
    const msg: any = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    try { this.proc.stdin!.write(JSON.stringify(msg) + '\n'); } catch {}
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => { this.notificationHandlers.delete(handler); };
  }

  offNotification(handler?: NotificationHandler): void {
    if (!handler) { this.notificationHandlers.clear(); return; }
    this.notificationHandlers.delete(handler);
  }

  kill(): void {
    try { this.proc?.kill(); } catch {}
    this.proc = null;
    this.ready = false;
    this.pending.clear();
    this.notificationHandlers.clear();
  }

  get isRunning(): boolean { return this.ready && !!this.proc && !this.proc.killed; }
}

/** Singleton app-server for shared operations (sessions, models, usage). */
let _sharedServer: CodexAppServer | null = null;
function getSharedServer(): CodexAppServer {
  if (!_sharedServer) _sharedServer = new CodexAppServer();
  return _sharedServer;
}

export function shutdownCodexServer(): void {
  _sharedServer?.kill();
  _sharedServer = null;
}

// ---------------------------------------------------------------------------
// Effort mapping
// ---------------------------------------------------------------------------

const EFFORT_MAP: Record<string, string> = {
  low: 'low', medium: 'medium', high: 'high', min: 'minimal', max: 'xhigh',
};
function mapEffort(effort: string): string { return EFFORT_MAP[effort] ?? effort; }

// ---------------------------------------------------------------------------
// Tool call helpers
// ---------------------------------------------------------------------------

interface CodexActiveToolCall { kind: string; summary: string; }

function isCodexToolCallItem(item: any): boolean {
  return item?.type === 'dynamicToolCall' || item?.type === 'mcpToolCall' || item?.type === 'collabAgentToolCall';
}

function codexToolKind(name: unknown): string {
  const raw = typeof name === 'string' ? name.trim() : '';
  if (!raw) return 'tool';
  const parts = raw.split('.');
  return parts[parts.length - 1] || raw;
}

function compactPathTarget(value: unknown, max = 80): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const compact = parts.length >= 2 ? parts.slice(-2).join('/') : normalized;
  if (compact.length <= max) return compact;
  return `...${compact.slice(-(max - 3))}`;
}

function summarizeCodexToolCall(item: any): CodexActiveToolCall | null {
  const kind = codexToolKind(item?.tool);
  switch (kind) {
    case 'apply_patch': return { kind, summary: 'Edit files' };
    case 'exec_command': return { kind, summary: 'Run shell command' };
    case 'update_plan': return { kind, summary: 'Update plan' };
    case 'request_user_input': return { kind, summary: 'Request user input' };
    case 'view_image': return { kind, summary: 'Inspect image' };
    case 'parallel': return { kind, summary: 'Run multiple tools' };
    default: {
      const label = shortValue(kind.replace(/_/g, ' '), 80);
      return label ? { kind, summary: `Use ${label}` } : null;
    }
  }
}

function summarizeCodexFileChange(item: any): string {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes.map((c: any) => compactPathTarget(c?.path, 90)).filter(Boolean);
  if (paths.length === 1) return `Updated ${paths[0]}`;
  if (paths.length > 1) return `Updated ${paths.length} files`;
  return 'Updated files';
}

function isCodexToolCallFailure(item: any): boolean {
  if (!item || !isCodexToolCallItem(item)) return false;
  return item.success === false || !!item.error || item.status === 'failed' || item.status === 'error';
}

function buildCodexActivityPreview(s: {
  recentNarrative: string[]; recentFailures: string[];
  commentaryByItem: Map<string, string>;
  activeCommands: Map<string, string>;
  activeToolCalls: Map<string, CodexActiveToolCall>;
  completedCommands: number;
}): string {
  const lines = [...s.recentNarrative];
  for (const text of s.commentaryByItem.values()) {
    const cleaned = normalizeActivityLine(text);
    if (cleaned && lines[lines.length - 1] !== cleaned) lines.push(cleaned);
  }
  for (const failure of s.recentFailures) {
    if (lines[lines.length - 1] !== failure) lines.push(failure);
  }
  if (s.completedCommands > 0) lines.push(s.completedCommands === 1 ? 'Executed 1 command.' : `Executed ${s.completedCommands} commands.`);
  if (s.activeCommands.size > 0) lines.push(s.activeCommands.size === 1 ? 'Running 1 command...' : `Running ${s.activeCommands.size} commands...`);
  for (const tool of s.activeToolCalls.values()) {
    const running = tool.summary.endsWith('...') ? tool.summary : `${tool.summary}...`;
    if (lines[lines.length - 1] !== running) lines.push(running);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

function buildCodexCumulativeUsage(raw: any): CodexCumulativeUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = numberOrNull(raw.inputTokens, raw.input_tokens);
  const output = numberOrNull(raw.outputTokens, raw.output_tokens);
  const cached = numberOrNull(raw.cachedInputTokens, raw.cached_input_tokens);
  if (input == null && output == null && cached == null) return null;
  return { input: input ?? 0, output: output ?? 0, cached: cached ?? 0 };
}

function applyCodexTokenUsage(
  s: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; cacheCreationInputTokens: number | null; contextWindow: number | null; codexCumulative: CodexCumulativeUsage | null },
  rawUsage: any, prev?: CodexCumulativeUsage,
) {
  if (!rawUsage || typeof rawUsage !== 'object') return;
  const last = rawUsage.last;
  const lastInput = numberOrNull(last?.inputTokens, last?.input_tokens);
  const lastOutput = numberOrNull(last?.outputTokens, last?.output_tokens);
  const lastCached = numberOrNull(last?.cachedInputTokens, last?.cached_input_tokens);
  const lastCacheCreation = numberOrNull(last?.cacheCreationInputTokens, last?.cache_creation_input_tokens);
  if (lastInput != null) s.inputTokens = lastInput;
  if (lastOutput != null) s.outputTokens = lastOutput;
  if (lastCached != null) s.cachedInputTokens = lastCached;
  if (lastCacheCreation != null) s.cacheCreationInputTokens = lastCacheCreation;

  const total = buildCodexCumulativeUsage(rawUsage.total ?? rawUsage);
  if (total) {
    s.codexCumulative = total;
    if (lastInput == null) s.inputTokens = prev ? Math.max(0, total.input - prev.input) : total.input;
    if (lastOutput == null) s.outputTokens = prev ? Math.max(0, total.output - prev.output) : total.output;
    if (lastCached == null) s.cachedInputTokens = prev ? Math.max(0, total.cached - prev.cached) : total.cached;
  }
  const contextWindow = numberOrNull(rawUsage.modelContextWindow, rawUsage.model_context_window);
  if (contextWindow != null && contextWindow > 0) s.contextWindow = contextWindow;
}

// ---------------------------------------------------------------------------
// Turn input
// ---------------------------------------------------------------------------

export function buildCodexTurnInput(prompt: string, attachments: string[]): any[] {
  const input: any[] = [];
  for (const filePath of attachments) {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      input.push({ type: 'localImage', path: filePath });
      continue;
    }
    input.push({ type: 'text', text: `[Attached file: ${filePath}]` });
  }
  input.push({ type: 'text', text: prompt });
  return input;
}

// ---------------------------------------------------------------------------
// Stream via app-server
// ---------------------------------------------------------------------------

export async function doCodexStream(opts: StreamOpts): Promise<StreamResult> {
  const start = Date.now();
  const srv = new CodexAppServer();
  let timedOut = false;
  let unsubscribeNotifications = () => {};

  try {
    const config: string[] = [];
    if (opts.codexExtraArgs?.length) {
      for (let i = 0; i < opts.codexExtraArgs.length; i++) {
        if (opts.codexExtraArgs[i] === '-c' && opts.codexExtraArgs[i + 1]) config.push(opts.codexExtraArgs[++i]);
      }
    }

    if (!(await srv.ensureRunning(config))) {
      return {
        ok: false, message: 'Failed to start codex app-server.', thinking: null,
        localSessionId: opts.localSessionId ?? null, sessionId: opts.sessionId, workspacePath: null,
        model: opts.model, thinkingEffort: opts.thinkingEffort,
        elapsedS: (Date.now() - start) / 1000, inputTokens: null, outputTokens: null,
        cachedInputTokens: null, cacheCreationInputTokens: null, contextWindow: null,
        contextUsedTokens: null, contextPercent: null, error: 'Failed to start codex app-server.',
        codexCumulative: null, stopReason: null, incomplete: true, activity: null, artifacts: [],
      };
    }

    const s = {
      sessionId: opts.sessionId as string | null,
      text: '', thinking: '', activity: '', msgs: [] as string[], thinkParts: [] as string[],
      model: opts.model as string | null, thinkingEffort: opts.thinkingEffort,
      inputTokens: null as number | null, outputTokens: null as number | null,
      cachedInputTokens: null as number | null, cacheCreationInputTokens: null as number | null,
      contextWindow: null as number | null, codexCumulative: null as CodexCumulativeUsage | null,
      turnId: null as string | null, turnStatus: null as string | null, turnError: null as string | null,
      messagePhases: new Map<string, string>(),
      commentaryByItem: new Map<string, string>(),
      activeCommands: new Map<string, string>(),
      activeToolCalls: new Map<string, CodexActiveToolCall>(),
      recentNarrative: [] as string[], recentFailures: [] as string[],
      completedCommands: 0,
      plan: null as StreamPreviewPlan | null,
    };

    // thread/start or thread/resume
    let threadResp: any;
    const threadParams = {
      cwd: opts.workdir,
      model: opts.codexModel || null,
      approvalPolicy: opts.codexFullAccess ? 'never' : undefined,
      sandbox: opts.codexFullAccess ? 'danger-full-access' : undefined,
      developerInstructions: opts.codexDeveloperInstructions || undefined,
    };
    if (opts.sessionId) {
      agentLog(`[codex-rpc] thread/resume id=${opts.sessionId}`);
      threadResp = await srv.call('thread/resume', { threadId: opts.sessionId, ...threadParams });
    } else {
      agentLog(`[codex-rpc] thread/start cwd=${opts.workdir} model=${opts.codexModel || '(default)'}`);
      threadResp = await srv.call('thread/start', threadParams);
    }

    if (threadResp.error) {
      const errMsg = threadResp.error.message || 'thread/start failed';
      agentLog(`[codex-rpc] thread error: ${errMsg}`);
      return {
        ok: false, message: errMsg, thinking: null,
        localSessionId: opts.localSessionId ?? null, sessionId: opts.sessionId, workspacePath: null,
        model: opts.model, thinkingEffort: opts.thinkingEffort,
        elapsedS: (Date.now() - start) / 1000, inputTokens: null, outputTokens: null,
        cachedInputTokens: null, cacheCreationInputTokens: null, contextWindow: null,
        contextUsedTokens: null, contextPercent: null, error: errMsg,
        codexCumulative: null, stopReason: null, incomplete: true, activity: null, artifacts: [],
      };
    }

    const threadResult = threadResp.result;
    s.sessionId = threadResult.thread?.id ?? s.sessionId;
    s.model = threadResult.model ?? s.model;
    agentLog(`[codex-rpc] thread ready: id=${s.sessionId} model=${s.model}`);

    // turn/start
    const input = buildCodexTurnInput(opts.prompt, opts.attachments || []);

    const turnDone = new Promise<void>((resolve) => {
      const deadline = start + opts.timeout * 1000;
      const hardTimer = setTimeout(() => {
        timedOut = true;
        agentLog(`[codex-rpc] timeout: interrupting turn`);
        if (s.turnId && s.sessionId) srv.call('turn/interrupt', { threadId: s.sessionId, turnId: s.turnId }).catch(() => {});
        resolve();
      }, opts.timeout * 1000 + 5_000);

      const emit = () => {
        s.activity = buildCodexActivityPreview(s);
        opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), s.plan);
      };

      const handleNotification = (method: string, params: any) => {
        if (Date.now() > deadline) return;

        if (method === 'item/started' && params.threadId === s.sessionId) {
          const item = params.item || {};
          if (item.type === 'agentMessage' && item.id) {
            const phase = item.phase || 'final_answer';
            s.messagePhases.set(item.id, phase);
            if (phase !== 'final_answer') { s.commentaryByItem.set(item.id, item.text || ''); emit(); }
          }
          if (item.type === 'commandExecution' && item.id && item.command) { s.activeCommands.set(item.id, item.command); emit(); }
          if (item.id && isCodexToolCallItem(item)) {
            const toolCall = summarizeCodexToolCall(item);
            if (toolCall) { s.activeToolCalls.set(item.id, toolCall); emit(); }
          }
        }

        if (method === 'item/agentMessage/delta' && params.threadId === s.sessionId) {
          const delta = params.delta || '';
          const phase = params.itemId ? (s.messagePhases.get(params.itemId) || 'final_answer') : 'final_answer';
          if (phase === 'final_answer') s.text += delta;
          else if (params.itemId) {
            const prev = s.commentaryByItem.get(params.itemId) || '';
            s.commentaryByItem.set(params.itemId, prev + delta);
          }
          emit();
        }

        if ((method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') && params.threadId === s.sessionId) {
          s.thinking += params.delta || '';
          emit();
        }

        if (method === 'item/completed' && params.threadId === s.sessionId) {
          const item = params.item || {};
          if (item.type === 'agentMessage' && item.id) {
            const phase = item.phase || s.messagePhases.get(item.id) || 'final_answer';
            if (phase === 'final_answer') { if (item.text?.trim()) s.msgs.push(item.text.trim()); }
            else {
              const commentary = item.text?.trim() || s.commentaryByItem.get(item.id)?.trim() || '';
              if (commentary) pushRecentActivity(s.recentNarrative, commentary);
              s.commentaryByItem.delete(item.id);
              emit();
            }
            s.messagePhases.delete(item.id);
          }
          if (item.type === 'reasoning') {
            const parts = [...(item.summary || []), ...(item.content || [])];
            const text = parts.join('\n').trim();
            if (text) { s.thinkParts.push(text); emit(); }
          }
          if (item.type === 'commandExecution' && item.id) {
            const cmd = item.command || s.activeCommands.get(item.id) || '';
            s.activeCommands.delete(item.id);
            if (cmd) {
              const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
              if (exitCode != null && exitCode !== 0) pushRecentActivity(s.recentFailures, `Command failed (${exitCode}): ${cmd}`, 4);
              else s.completedCommands++;
            }
            emit();
          }
          if (item.id && isCodexToolCallItem(item)) {
            const toolCall = s.activeToolCalls.get(item.id) || summarizeCodexToolCall(item);
            s.activeToolCalls.delete(item.id);
            if (toolCall) {
              if (isCodexToolCallFailure(item)) pushRecentActivity(s.recentFailures, `${toolCall.summary} failed`, 4);
              else if (toolCall.kind !== 'apply_patch') pushRecentActivity(s.recentNarrative, `${toolCall.summary} done`);
            }
            emit();
          }
          if (item.type === 'fileChange') { pushRecentActivity(s.recentNarrative, summarizeCodexFileChange(item)); emit(); }
        }

        if (method === 'thread/tokenUsage/updated' && params.threadId === s.sessionId) {
          applyCodexTokenUsage(s, params.tokenUsage, opts.codexPrevCumulative);
          emit();
        }

        if (method === 'turn/plan/updated' && params.threadId === s.sessionId) {
          const rawPlan = Array.isArray(params.plan) ? params.plan : [];
          s.plan = {
            explanation: typeof params.explanation === 'string' ? params.explanation : null,
            steps: rawPlan
              .map((entry: any) => ({
                step: typeof entry?.step === 'string' ? entry.step : '',
                status: entry?.status === 'completed' || entry?.status === 'pending' || entry?.status === 'inProgress' ? entry.status : 'pending',
              }))
              .filter((entry: StreamPreviewPlanStep) => entry.step.trim()),
          };
          emit();
        }

        if (method === 'turn/completed' && params.threadId === s.sessionId) {
          const turn = params.turn || {};
          applyCodexTokenUsage(s, params.tokenUsage || turn.tokenUsage || turn.usage, opts.codexPrevCumulative);
          s.turnStatus = turn.status ?? null;
          if (turn.error) s.turnError = turn.error.message || turn.error.code || JSON.stringify(turn.error);
          s.turnId = turn.id ?? s.turnId;
          clearTimeout(hardTimer);
          resolve();
        }

        if (method === 'turn/started' && params.threadId === s.sessionId) s.turnId = params.turn?.id ?? null;
        if (method === 'model/rerouted' && params.threadId === s.sessionId) s.model = params.model ?? s.model;
      };
      unsubscribeNotifications = srv.onNotification(handleNotification);
    });

    agentLog(`[codex-rpc] turn/start prompt="${opts.prompt.slice(0, 120)}" effort=${mapEffort(opts.thinkingEffort)}`);
    const turnResp = await srv.call('turn/start', {
      threadId: s.sessionId, input,
      model: opts.codexModel || undefined,
      effort: mapEffort(opts.thinkingEffort),
    });

    if (turnResp.error) {
      unsubscribeNotifications();
      const errMsg = turnResp.error.message || 'turn/start failed';
      agentLog(`[codex-rpc] turn/start error: ${errMsg}`);
      return {
        ok: false, message: errMsg, thinking: null,
        localSessionId: opts.localSessionId ?? null, sessionId: s.sessionId, workspacePath: null,
        model: s.model, thinkingEffort: s.thinkingEffort,
        elapsedS: (Date.now() - start) / 1000, inputTokens: null, outputTokens: null,
        cachedInputTokens: null, cacheCreationInputTokens: null, contextWindow: null,
        contextUsedTokens: null, contextPercent: null, error: errMsg,
        codexCumulative: null, stopReason: null, incomplete: true, activity: null, artifacts: [],
      };
    }
    s.turnId = turnResp.result?.turn?.id ?? null;

    await turnDone;
    unsubscribeNotifications();

    if (!s.text.trim() && s.msgs.length) s.text = s.msgs.join('\n\n');
    if (!s.thinking.trim() && s.thinkParts.length) s.thinking = s.thinkParts.join('\n\n');

    const ok = s.turnStatus === 'completed' && !timedOut;
    const error = s.turnError
      || (timedOut ? `Timed out after ${opts.timeout}s waiting for turn completion.` : null)
      || (!ok ? `Turn ${s.turnStatus || 'unknown'}.` : null);
    const stopReason = timedOut ? 'timeout' : (s.turnStatus === 'interrupted' ? 'interrupted' : null);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    agentLog(`[codex-rpc] result: ok=${ok} elapsed=${elapsed}s text=${s.text.length}chars session=${s.sessionId} status=${s.turnStatus}`);

    return {
      ok, localSessionId: opts.localSessionId ?? null, sessionId: s.sessionId,
      workspacePath: null, model: s.model, thinkingEffort: s.thinkingEffort,
      message: s.text.trim() || error || '(no textual response)',
      thinking: s.thinking.trim() || null,
      elapsedS: (Date.now() - start) / 1000,
      inputTokens: s.inputTokens, outputTokens: s.outputTokens,
      cachedInputTokens: s.cachedInputTokens, cacheCreationInputTokens: s.cacheCreationInputTokens,
      contextWindow: s.contextWindow, ...computeContext(s),
      codexCumulative: s.codexCumulative, error, stopReason, incomplete: !ok,
      activity: s.activity.trim() || null, artifacts: [],
    };
  } finally {
    unsubscribeNotifications();
    srv.kill();
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function getCodexSessions(workdir: string, limit?: number): SessionListResult {
  const sessions = listCodeclawSessions(workdir, 'codex', limit).map(record => ({
    sessionId: record.engineSessionId,
    localSessionId: record.localSessionId,
    engineSessionId: record.engineSessionId,
    agent: 'codex' as const,
    workdir: record.workdir,
    workspacePath: record.workspacePath,
    model: record.model,
    createdAt: record.createdAt,
    title: record.title,
    running: Date.now() - Date.parse(record.updatedAt) < 10_000,
  }));
  return { ok: true, sessions, error: null };
}

async function getCodexSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
  const limit = opts.limit ?? 4;
  const srv = getSharedServer();
  if (!(await srv.ensureRunning())) return { ok: false, messages: [], error: 'Failed to start codex app-server.' };

  const resp = await srv.call('thread/read', { threadId: opts.sessionId, includeTurns: true });
  if (resp.error) return { ok: false, messages: [], error: resp.error.message || 'thread/read failed' };
  const thread = resp.result?.thread;
  if (!thread) return { ok: false, messages: [], error: 'No thread data returned' };

  const allMsgs: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const turn of (thread.turns ?? [])) {
    for (const item of (turn.items ?? [])) {
      if (item.type === 'userMessage') {
        const parts: string[] = [];
        for (const c of (item.content ?? [])) { if (c.type === 'text' && c.text) parts.push(c.text); }
        if (parts.length) allMsgs.push({ role: 'user', text: stripInjectedPrompts(parts.join('\n')) });
      } else if (item.type === 'agentMessage') {
        if (item.text) allMsgs.push({ role: 'assistant', text: item.text });
      }
    }
  }
  return { ok: true, messages: allMsgs.slice(-limit), error: null };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function pushModel(models: ModelInfo[], seen: Set<string>, id: string, alias: string | null) {
  const cleanId = id.trim();
  if (!cleanId || seen.has(cleanId)) return;
  seen.add(cleanId);
  models.push({ id: cleanId, alias: alias?.trim() || null });
}

async function discoverCodexModels(opts: ModelListOpts): Promise<ModelListResult> {
  const srv = getSharedServer();
  if (!(await srv.ensureRunning())) return { agent: 'codex', models: [], sources: [], note: 'Failed to start codex app-server.' };

  const resp = await srv.call('model/list', { includeHidden: false });
  if (resp.error) return { agent: 'codex', models: [], sources: [], note: resp.error.message || 'model/list failed' };

  const data: any[] = resp.result?.data ?? [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  if (opts.currentModel?.trim()) pushModel(models, seen, opts.currentModel.trim(), null);
  for (const entry of data) {
    const id = entry.model || entry.id;
    if (!id || seen.has(id)) continue;
    pushModel(models, seen, id, entry.displayName && entry.displayName !== id ? entry.displayName : null);
  }

  return { agent: 'codex', models, sources: ['app-server model/list'], note: null };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function getCodexStateDbPath(home: string): string | null {
  const root = path.join(home, '.codex');
  if (!fs.existsSync(root)) return null;
  try {
    const files = fs.readdirSync(root)
      .filter(name => /^state.*\.sqlite$/i.test(name))
      .map(name => ({ name, full: path.join(root, name), mtime: fs.statSync(path.join(root, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.full || null;
  } catch { return null; }
}

function codexUsageFromRateLimits(rateLimits: any, capturedAt: string | null, source: string): UsageResult | null {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const windows = [
    usageWindowFromRateLimit('Primary', rateLimits.primary),
    usageWindowFromRateLimit('Secondary', rateLimits.secondary),
  ].filter((v): v is UsageWindowInfo => !!v);
  if (!windows.length) return null;
  let status: string | null = null;
  if (rateLimits.limit_reached === true) status = 'limit_reached';
  else if (rateLimits.allowed === true) status = 'allowed';
  return { ok: true, agent: 'codex', source, capturedAt, status, windows, error: null };
}

function getCodexUsageFromStateDb(home: string): UsageResult | null {
  const dbPath = getCodexStateDbPath(home);
  if (!dbPath) return null;
  try {
    const query = "SELECT ts || '|' || message FROM logs WHERE message LIKE '%codex.rate_limits%' ORDER BY ts DESC LIMIT 1;";
    const out = execSync(`sqlite3 -noheader ${Q(dbPath)} ${Q(query)}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    if (!out) return null;
    const sep = out.indexOf('|');
    const rawTs = sep >= 0 ? out.slice(0, sep) : '';
    const rawMessage = sep >= 0 ? out.slice(sep + 1) : out;
    const payload = parseJsonTail(rawMessage);
    const capturedAt = toIsoFromEpochSeconds(rawTs);
    return codexUsageFromRateLimits(payload?.rate_limits, capturedAt, 'state-db');
  } catch { return null; }
}

function getCodexUsageFromSessions(home: string): UsageResult | null {
  const sessionsRoot = path.join(home, '.codex', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  const all: { path: string; mtime: number }[] = [];
  try {
    for (const year of fs.readdirSync(sessionsRoot)) {
      const yp = path.join(sessionsRoot, year);
      if (!fs.statSync(yp).isDirectory()) continue;
      for (const month of fs.readdirSync(yp)) {
        const mp = path.join(yp, month);
        if (!fs.statSync(mp).isDirectory()) continue;
        for (const day of fs.readdirSync(mp)) {
          const dp = path.join(mp, day);
          if (!fs.statSync(dp).isDirectory()) continue;
          for (const f of fs.readdirSync(dp)) {
            if (!f.endsWith('.jsonl')) continue;
            all.push({ path: path.join(dp, f), mtime: fs.statSync(path.join(dp, f)).mtimeMs });
          }
        }
      }
    }
  } catch { return null; }

  all.sort((a, b) => b.mtime - a.mtime);
  for (const entry of all.slice(0, 30)) {
    try {
      const lines = fs.readFileSync(entry.path, 'utf-8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
        const raw = lines[i];
        if (!raw || raw[0] !== '{' || !raw.includes('rate_limits')) continue;
        let ev: any;
        try { ev = JSON.parse(raw); } catch { continue; }
        const result = codexUsageFromRateLimits(ev?.payload?.rate_limits, typeof ev?.timestamp === 'string' ? ev.timestamp : null, 'session-history');
        if (result) return result;
      }
    } catch {}
  }
  return null;
}

function parseRateLimitWindow(label: string, rl: any): UsageWindowInfo | null {
  if (!rl || typeof rl !== 'object') return null;
  const usedPercent = roundPercent(rl.usedPercent);
  return {
    label: labelFromWindowMinutes(rl.windowDurationMins, label),
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, Math.round((100 - usedPercent) * 10) / 10),
    resetAt: toIsoFromEpochSeconds(rl.resetsAt),
    resetAfterSeconds: rl.resetsAt ? Math.max(0, Math.round(rl.resetsAt - Date.now() / 1000)) : null,
    status: null,
  };
}

export async function getCodexUsageLive(): Promise<UsageResult> {
  const home = process.env.HOME || '';
  const srv = getSharedServer();
  if (!(await srv.ensureRunning())) {
    return getCodexUsageFromStateDb(home) || emptyUsage('codex', 'Failed to start codex app-server.');
  }

  const resp = await srv.call('account/rateLimits/read');
  if (resp.error) return getCodexUsageFromStateDb(home) || emptyUsage('codex', resp.error.message || 'account/rateLimits/read failed');

  const rl = resp.result?.rateLimits;
  if (!rl) return getCodexUsageFromStateDb(home) || emptyUsage('codex', 'No rate limits in response.');

  const capturedAt = new Date().toISOString();
  const windows: UsageWindowInfo[] = [];
  const w1 = parseRateLimitWindow('Primary', rl.primary);
  if (w1) windows.push(w1);
  const w2 = parseRateLimitWindow('Secondary', rl.secondary);
  if (w2) windows.push(w2);

  return {
    ok: windows.length > 0, agent: 'codex', source: 'app-server-live', capturedAt, status: null,
    windows, error: windows.length > 0 ? null : 'No rate limit windows.',
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

class CodexDriver implements AgentDriver {
  readonly id = 'codex';
  readonly cmd = 'codex';
  readonly thinkLabel = 'Reasoning';

  detect(): AgentInfo { return detectAgentBin('codex', 'codex'); }

  async doStream(opts: StreamOpts): Promise<StreamResult> { return doCodexStream(opts); }

  async getSessions(workdir: string, limit?: number): Promise<SessionListResult> {
    return getCodexSessions(workdir, limit);
  }

  async getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
    const managed = findCodeclawSessionByLocalId(opts.workdir, 'codex', opts.sessionId);
    if (managed) {
      if (!managed.engineSessionId) return { ok: true, messages: [], error: null };
      return getCodexSessionTail({ ...opts, sessionId: managed.engineSessionId });
    }
    return getCodexSessionTail(opts);
  }

  async listModels(opts: ModelListOpts): Promise<ModelListResult> { return discoverCodexModels(opts); }

  getUsage(opts: UsageOpts): UsageResult {
    const home = process.env.HOME || '';
    if (!home) return emptyUsage('codex', 'HOME is not set.');
    return getCodexUsageFromStateDb(home)
      || getCodexUsageFromSessions(home)
      || emptyUsage('codex', 'No recent Codex usage data found.');
  }

  async getUsageLive(opts: UsageOpts): Promise<UsageResult> { return getCodexUsageLive(); }

  shutdown() { shutdownCodexServer(); }
}

registerDriver(new CodexDriver());
