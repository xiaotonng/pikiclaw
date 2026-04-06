/**
 * Codex CLI driver: HTTP server management, streaming, human-in-the-loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { registerDriver, type AgentDriver } from '../driver.js';
import { terminateProcessTree } from '../../core/process-control.js';
import {
  type StreamOpts, type StreamResult,
  type StreamPreviewMeta, type StreamPreviewPlan, type StreamPreviewPlanStep,
  type CodexCumulativeUsage, type CodexInteractionRequest,
  type SessionListResult, type SessionInfo, type SessionTailOpts, type SessionTailResult,
  type SessionMessagesOpts, type SessionMessagesResult,
  type TailMessage, type RichMessage, type MessageBlock,
  mimeForExt,
  type ModelListOpts, type ModelListResult, type ModelInfo,
  type UsageOpts, type UsageResult, type UsageWindowInfo,
  // shared helpers
  agentLog, agentWarn,
  buildStreamPreviewMeta, pushRecentActivity, normalizeActivityLine,
  firstNonEmptyLine, shortValue, numberOrNull,
  normalizeStreamPreviewPlan,
  IMAGE_EXTS,
  listPikiclawSessions, findPikiclawSession, isPendingSessionId,
  mergeManagedAndNativeSessions,
  stripInjectedPrompts, sanitizeSessionUserPreviewText, computeContext, readTailLines, applyTurnWindow,
  roundPercent, toIsoFromEpochSeconds, labelFromWindowMinutes,
  usageWindowFromRateLimit, parseJsonTail, emptyUsage,
  Q,
} from '../index.js';
import {
  CODEX_APPSERVER_SPAWN_TIMEOUT_MS as _CODEX_APPSERVER_SPAWN_TIMEOUT_MS,
  CODEX_STREAM_HARD_KILL_GRACE_MS,
  SESSION_RUNNING_THRESHOLD_MS,
} from '../../core/constants.js';

// ---------------------------------------------------------------------------
// App-server JSON-RPC client
// ---------------------------------------------------------------------------

const CODEX_APPSERVER_SPAWN_TIMEOUT_MS = _CODEX_APPSERVER_SPAWN_TIMEOUT_MS;

type RpcCallback = (msg: any) => void;
type NotificationHandler = (method: string, params: any) => void;
type RequestHandler = (method: string, params: any, requestId: string) => Promise<any> | any;

export class CodexAppServer {
  private proc: ReturnType<typeof spawn> | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, RpcCallback>();
  private notificationHandlers = new Set<NotificationHandler>();
  private requestHandlers = new Set<RequestHandler>();
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
      const proc = spawn('codex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        detached: process.platform !== 'win32',
      });
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
          if (msg.method && msg.id != null) {
            const handlers = [...this.requestHandlers];
            if (!handlers.length) {
              this.respond(msg.id, {});
              continue;
            }
            const [handler] = handlers;
            Promise.resolve(handler(msg.method, msg.params ?? {}, String(msg.id)))
              .then(result => this.respond(msg.id, result ?? {}))
              .catch(error => {
                agentWarn(`[codex-rpc] request handler error method=${msg.method} error=${error?.message || error}`);
                this.respond(msg.id, {});
              });
            continue;
          }
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
      proc.on('close', () => {
        this.ready = false;
        this.proc = null;
        // Resolve any pending RPC calls so callers don't hang forever
        for (const [id, cb] of this.pending) {
          cb({ error: { message: 'process exited before responding' } });
        }
        this.pending.clear();
      });

      this.call('initialize', { clientInfo: { name: 'pikiclaw', version: '0.2.0' } })
        .then(resp => {
          clearTimeout(timer);
          if (resp.error) { agentWarn(`[codex-rpc] init error: ${resp.error.message}`); resolve(false); return; }
          this.ready = true;
          agentLog(`[codex-rpc] initialized`);
          resolve(true);
        })
        .catch(() => { clearTimeout(timer); resolve(false); });
    });
  }

  call(method: string, params?: any, timeoutMs?: number): Promise<any> {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed) { resolve({ error: { message: 'not connected' } }); return; }
      const id = this.nextId++;
      const wrappedResolve = (result: any) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        resolve(result);
      };
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `RPC call '${method}' timed out after ${timeoutMs}ms` } });
      }, timeoutMs) : null;
      this.pending.set(id, wrappedResolve);
      const msg: any = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      try { this.proc.stdin!.write(JSON.stringify(msg) + '\n'); } catch {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        resolve({ error: { message: 'write failed' } });
      }
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
    terminateProcessTree(this.proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 2000 });
    this.proc = null;
    this.ready = false;
    for (const cb of this.pending.values()) cb({ error: { message: 'app-server terminated' } });
    this.pending.clear();
    this.notificationHandlers.clear();
  }

  get isRunning(): boolean { return this.ready && !!this.proc && !this.proc.killed; }

  onRequest(handler: RequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => { this.requestHandlers.delete(handler); };
  }

  private respond(id: any, result: any): void {
    if (!this.proc || this.proc.killed) return;
    try { this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); } catch {}
  }
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
interface PendingCodexAssistantMessage {
  blocks: MessageBlock[];
  toolNamesByCallId: Map<string, string>;
}

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

function summarizeCodexRawResponseItem(item: any): string | null {
  if (!item || typeof item !== 'object') return null;
  switch (item.type) {
    case 'web_search_call': {
      const action = item.action || {};
      if (action.type === 'search') {
        const query = shortValue(action.query, 120);
        return query ? `Search web: ${query}` : 'Search web';
      }
      if (action.type === 'open_page') {
        const url = shortValue(action.url, 120);
        return url ? `Open ${url}` : 'Open web page';
      }
      return 'Search web';
    }
    case 'custom_tool_call': {
      const name = shortValue(item.name, 80);
      return name ? `Use ${name}` : 'Use tool';
    }
    case 'local_shell_call': {
      const command = shortValue(item.action?.command || item.action?.cmd, 120);
      return command ? `Run shell command: ${command}` : 'Run shell command';
    }
    default:
      return null;
  }
}

function extractCodexMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((entry: any) => {
      if (!entry || typeof entry !== 'object') return '';
      if ((entry.type === 'output_text' || entry.type === 'input_text' || entry.type === 'text') && typeof entry.text === 'string') {
        return entry.text.trim();
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function extractCodexReasoningText(payload: any): string {
  const fromSummary = Array.isArray(payload?.summary)
    ? payload.summary
      .map((entry: any) => typeof entry === 'string' ? entry : (typeof entry?.text === 'string' ? entry.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    : '';
  if (fromSummary) return fromSummary;
  if (Array.isArray(payload?.content)) {
    return payload.content
      .map((entry: any) => typeof entry === 'string' ? entry : (typeof entry?.text === 'string' ? entry.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return typeof payload?.content === 'string' ? payload.content.trim() : '';
}

function parseCodexArguments(raw: unknown): any {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return raw; }
}

function formatCodexArguments(raw: unknown): string {
  const parsed = parseCodexArguments(raw);
  if (parsed == null) return '';
  if (typeof parsed === 'string') return parsed.trim();
  try { return JSON.stringify(parsed, null, 2); } catch {}
  return String(parsed);
}

function formatCodexPlanSummary(plan: StreamPreviewPlan): string {
  const lines: string[] = [];
  if (plan.explanation?.trim()) lines.push(plan.explanation.trim());
  for (const step of plan.steps) lines.push(`[${step.status}] ${step.step}`);
  return lines.join('\n').trim();
}

function buildCodexAssistantText(blocks: MessageBlock[]): string {
  const finalText = blocks
    .filter(block => block.type === 'text' && block.phase === 'final_answer' && block.content.trim())
    .map(block => block.content.trim())
    .join('\n\n')
    .trim();
  if (finalText) return finalText;

  const commentaryText = blocks
    .filter(block => block.type === 'text' && block.content.trim())
    .map(block => block.content.trim())
    .join('\n\n')
    .trim();
  if (commentaryText) return commentaryText;

  const latestPlan = [...blocks].reverse().find(block => block.type === 'plan' && block.plan?.steps?.length);
  if (latestPlan?.content.trim()) return latestPlan.content.trim();

  const thinking = blocks.find(block => block.type === 'thinking' && block.content.trim())?.content.trim();
  if (thinking) return thinking;

  const toolNames = blocks
    .filter(block => block.type === 'tool_use')
    .map(block => block.toolName?.trim() || '')
    .filter(Boolean);
  if (toolNames.length) return toolNames.join(', ');

  return blocks.find(block => block.type === 'tool_result' && block.content.trim())?.content.trim() || '';
}

function overlayCodexManagedPreview(workdir: string, sessionId: string, richMessages: RichMessage[]): RichMessage[] {
  const managed = findPikiclawSession(workdir, 'codex', sessionId);
  if (!managed) return richMessages;
  const assistantIndex = [...richMessages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(entry => entry.message.role === 'assistant')?.index ?? -1;
  if (assistantIndex < 0) return richMessages;

  const current = richMessages[assistantIndex];
  const blocks = [...current.blocks];
  let changed = false;

  if (managed.lastThinking?.trim() && !blocks.some(block => block.type === 'thinking' && block.content.trim())) {
    const thinkingBlock: MessageBlock = { type: 'thinking', content: managed.lastThinking.trim() };
    const insertIndex = blocks.findIndex(block => block.type === 'text' && block.phase === 'final_answer');
    if (insertIndex >= 0) blocks.splice(insertIndex, 0, thinkingBlock);
    else blocks.push(thinkingBlock);
    changed = true;
  }

  if (managed.lastPlan?.steps?.length && !blocks.some(block => block.type === 'plan' && block.plan?.steps?.length)) {
    const planBlock: MessageBlock = {
      type: 'plan',
      content: formatCodexPlanSummary(managed.lastPlan),
      plan: managed.lastPlan,
    };
    const insertIndex = blocks.findIndex(block => block.type === 'text' && block.phase === 'final_answer');
    if (insertIndex >= 0) blocks.splice(insertIndex, 0, planBlock);
    else blocks.push(planBlock);
    changed = true;
  }

  if (!changed) return richMessages;

  const merged = [...richMessages];
  merged[assistantIndex] = {
    ...current,
    text: buildCodexAssistantText(blocks) || current.text,
    blocks,
  };
  return merged;
}

function buildCodexInteractionRequest(method: string, params: any, requestId: string): CodexInteractionRequest | null {
  if (method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params?.questions) ? params.questions : [];
    return {
      kind: 'requestUserInput',
      requestId,
      threadId: String(params?.threadId || ''),
      turnId: String(params?.turnId || ''),
      itemId: String(params?.itemId || ''),
      questions: questions.map((question: any) => ({
        id: String(question?.id || ''),
        header: String(question?.header || ''),
        question: String(question?.question || ''),
        isOther: !!question?.isOther,
        isSecret: !!question?.isSecret,
        options: Array.isArray(question?.options)
          ? question.options.map((option: any) => ({
            label: String(option?.label || ''),
            description: String(option?.description || ''),
          }))
          : null,
      })).filter((question: any) => question.id && question.question),
    };
  }
  return null;
}

function defaultCodexInteractionResponse(request: CodexInteractionRequest): Record<string, any> {
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of request.questions) answers[question.id] = { answers: [] };
  return { answers };
}

function defaultCodexServerRequestResponse(method: string): Record<string, any> {
  if (method === 'item/commandExecution/requestApproval') return { decision: 'accept' };
  if (method === 'item/fileChange/requestApproval') return { decision: 'accept' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  return {};
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

function buildCodexContextUsage(raw: any): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const total = numberOrNull(raw.totalTokens, raw.total_tokens);
  if (total != null && total >= 0) return total;

  const input = numberOrNull(raw.inputTokens, raw.input_tokens);
  const output = numberOrNull(raw.outputTokens, raw.output_tokens);
  if (input != null && output != null) return input + output;
  if (input != null) return input;
  return null;
}


function applyCodexTokenUsage(
  s: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    cacheCreationInputTokens: number | null;
    contextWindow: number | null;
    contextUsedTokens: number | null;
    codexCumulative: CodexCumulativeUsage | null;
  },
  rawUsage: any, prev?: CodexCumulativeUsage,
) {
  if (!rawUsage || typeof rawUsage !== 'object') return;
  const info = rawUsage.info && typeof rawUsage.info === 'object' ? rawUsage.info : rawUsage;
  const last = info.last ?? info.lastTokenUsage ?? info.last_token_usage ?? rawUsage.last;
  const lastInput = numberOrNull(last?.inputTokens, last?.input_tokens);
  const lastOutput = numberOrNull(last?.outputTokens, last?.output_tokens);
  const lastCached = numberOrNull(last?.cachedInputTokens, last?.cached_input_tokens);
  const lastCacheCreation = numberOrNull(last?.cacheCreationInputTokens, last?.cache_creation_input_tokens);
  if (lastInput != null) s.inputTokens = lastInput;
  if (lastOutput != null) s.outputTokens = lastOutput;
  if (lastCached != null) s.cachedInputTokens = lastCached;
  if (lastCacheCreation != null) s.cacheCreationInputTokens = lastCacheCreation;
  const lastContextUsage = buildCodexContextUsage(last);
  if (lastContextUsage != null) s.contextUsedTokens = lastContextUsage;

  const totalUsage = info.total ?? info.totalTokenUsage ?? info.total_token_usage ?? rawUsage.total ?? rawUsage;
  const total = buildCodexCumulativeUsage(totalUsage);
  if (total) {
    s.codexCumulative = total;
    if (lastInput == null) s.inputTokens = prev ? Math.max(0, total.input - prev.input) : total.input;
    if (lastOutput == null) s.outputTokens = prev ? Math.max(0, total.output - prev.output) : total.output;
    if (lastCached == null) s.cachedInputTokens = prev ? Math.max(0, total.cached - prev.cached) : total.cached;
  }
  // NOTE: do NOT set s.contextUsedTokens from cumulative totals —
  // those counters span the full thread, not the current turn. Use the per-turn
  // `last` usage only. `cached_input_tokens` is already a subset of
  // `input_tokens`, so adding it again inflates the context percentage.
  const contextWindow = numberOrNull(
    info.modelContextWindow,
    info.model_context_window,
    rawUsage.modelContextWindow,
    rawUsage.model_context_window,
  );
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
// Stream state
// ---------------------------------------------------------------------------

interface CodexStreamState {
  sessionId: string | null;
  text: string;
  thinking: string;
  activity: string;
  msgs: string[];
  thinkParts: string[];
  model: string | null;
  thinkingEffort: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  contextWindow: number | null;
  contextUsedTokens: number | null;
  codexCumulative: CodexCumulativeUsage | null;
  turnId: string | null;
  turnStatus: string | null;
  turnError: string | null;
  messagePhases: Map<string, string>;
  commentaryByItem: Map<string, string>;
  activeCommands: Map<string, string>;
  activeToolCalls: Map<string, CodexActiveToolCall>;
  recentNarrative: string[];
  recentFailures: string[];
  completedCommands: number;
  plan: StreamPreviewPlan | null;
}

function createCodexStreamState(opts: StreamOpts): CodexStreamState {
  return {
    sessionId: opts.sessionId,
    text: '', thinking: '', activity: '', msgs: [], thinkParts: [],
    model: opts.model, thinkingEffort: opts.thinkingEffort,
    inputTokens: null, outputTokens: null,
    cachedInputTokens: null, cacheCreationInputTokens: null,
    contextWindow: null, contextUsedTokens: null,
    codexCumulative: null,
    turnId: null, turnStatus: null, turnError: null,
    messagePhases: new Map(),
    commentaryByItem: new Map(),
    activeCommands: new Map(),
    activeToolCalls: new Map(),
    recentNarrative: [], recentFailures: [],
    completedCommands: 0,
    plan: null,
  };
}

function codexErrorResult(
  error: string, start: number,
  sessionId: string | null, model: string | null, thinkingEffort: string,
): StreamResult {
  return {
    ok: false, message: error, thinking: null,
    plan: null,
    sessionId, workspacePath: null,
    model, thinkingEffort,
    elapsedS: (Date.now() - start) / 1000, inputTokens: null, outputTokens: null,
    cachedInputTokens: null, cacheCreationInputTokens: null, contextWindow: null,
    contextUsedTokens: null, contextPercent: null, error,
    codexCumulative: null, stopReason: null, incomplete: true, activity: null,
  };
}

// ---------------------------------------------------------------------------
// Stream notification handler (extracted from doCodexStream)
// ---------------------------------------------------------------------------

function handleCodexNotification(
  method: string, params: any,
  s: CodexStreamState, opts: StreamOpts,
  deadline: number,
  emit: () => void,
  hardTimer: ReturnType<typeof setTimeout>,
  settleTurnDone: (() => void) | null,
  publishTurnControl?: () => void,
): void {
  if (Date.now() > deadline) return;
  if (params.threadId !== s.sessionId) {
    // Only turn/started and model/rerouted are checked below; all others already filter on threadId.
    if (method !== 'turn/started' && method !== 'model/rerouted') return;
    if (params.threadId !== s.sessionId) return;
  }

  switch (method) {
    case 'item/started':
      handleItemStarted(params.item || {}, s, emit);
      return;
    case 'item/agentMessage/delta':
      handleAgentMessageDelta(params, s, emit);
      return;
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      s.thinking += params.delta || '';
      emit();
      return;
    case 'item/completed':
      handleItemCompleted(params.item || {}, s, emit);
      return;
    case 'rawResponseItem/completed':
      handleRawResponseItemCompleted(params.item || {}, s, emit);
      return;
    case 'thread/tokenUsage/updated':
      applyCodexTokenUsage(s, params.tokenUsage, opts.codexPrevCumulative);
      emit();
      return;
    case 'turn/plan/updated':
      handleTurnPlanUpdated(params, s, emit);
      return;
    case 'serverRequest/resolved': {
      const requestId = String(params.requestId || '');
      if (requestId) pushRecentActivity(s.recentNarrative, 'Human input resolved');
      emit();
      return;
    }
    case 'turn/completed': {
      const turn = params.turn || {};
      applyCodexTokenUsage(s, params.tokenUsage || turn.tokenUsage || turn.usage, opts.codexPrevCumulative);
      s.turnStatus = turn.status ?? null;
      if (turn.error) s.turnError = turn.error.message || turn.error.code || JSON.stringify(turn.error);
      s.turnId = turn.id ?? s.turnId;
      clearTimeout(hardTimer);
      settleTurnDone?.();
      return;
    }
    case 'turn/started':
      s.turnId = params.turn?.id ?? null;
      publishTurnControl?.();
      return;
    case 'model/rerouted':
      s.model = params.model ?? s.model;
      return;
  }
}

function handleItemStarted(item: any, s: CodexStreamState, emit: () => void): void {
  if (item.type === 'agentMessage' && item.id) {
    const phase = item.phase || 'final_answer';
    s.messagePhases.set(item.id, phase);
    if (phase !== 'final_answer') { s.commentaryByItem.set(item.id, item.text || ''); emit(); }
  }
  if (item.type === 'commandExecution' && item.id && item.command) {
    s.activeCommands.set(item.id, item.command);
    emit();
  }
  if (item.id && isCodexToolCallItem(item)) {
    const toolCall = summarizeCodexToolCall(item);
    if (toolCall) { s.activeToolCalls.set(item.id, toolCall); emit(); }
  }
}

function handleAgentMessageDelta(params: any, s: CodexStreamState, emit: () => void): void {
  const delta = params.delta || '';
  const phase = params.itemId ? (s.messagePhases.get(params.itemId) || 'final_answer') : 'final_answer';
  if (phase === 'final_answer') {
    s.text += delta;
  } else if (params.itemId) {
    const prev = s.commentaryByItem.get(params.itemId) || '';
    s.commentaryByItem.set(params.itemId, prev + delta);
  }
  emit();
}

function handleItemCompleted(item: any, s: CodexStreamState, emit: () => void): void {
  if (item.type === 'agentMessage' && item.id) {
    handleCompletedAgentMessage(item, s, emit);
  }
  if (item.type === 'reasoning') {
    const parts = [...(item.summary || []), ...(item.content || [])];
    const text = parts.join('\n').trim();
    if (text) { s.thinkParts.push(text); emit(); }
  }
  if (item.type === 'commandExecution' && item.id) {
    handleCompletedCommand(item, s, emit);
  }
  if (item.id && isCodexToolCallItem(item)) {
    handleCompletedToolCall(item, s, emit);
  }
  if (item.type === 'fileChange') {
    pushRecentActivity(s.recentNarrative, summarizeCodexFileChange(item));
    emit();
  }
}

function handleRawResponseItemCompleted(item: any, s: CodexStreamState, emit: () => void): void {
  if (item?.type === 'reasoning') {
    const summary = Array.isArray(item.summary)
      ? item.summary
        .map((entry: any) => (typeof entry === 'string' ? entry : entry?.text || ''))
        .filter(Boolean)
        .join('\n')
        .trim()
      : '';
    if (summary) {
      s.thinkParts.push(summary);
      emit();
      return;
    }
  }
  const summary = summarizeCodexRawResponseItem(item);
  if (!summary) return;
  pushRecentActivity(s.recentNarrative, summary);
  emit();
}

function handleCompletedAgentMessage(item: any, s: CodexStreamState, emit: () => void): void {
  const phase = item.phase || s.messagePhases.get(item.id) || 'final_answer';
  if (phase === 'final_answer') {
    if (item.text?.trim()) s.msgs.push(item.text.trim());
  } else {
    const commentary = item.text?.trim() || s.commentaryByItem.get(item.id)?.trim() || '';
    if (commentary) pushRecentActivity(s.recentNarrative, commentary);
    s.commentaryByItem.delete(item.id);
    emit();
  }
  s.messagePhases.delete(item.id);
}

function handleCompletedCommand(item: any, s: CodexStreamState, emit: () => void): void {
  const cmd = item.command || s.activeCommands.get(item.id) || '';
  s.activeCommands.delete(item.id);
  if (cmd) {
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
    if (exitCode != null && exitCode !== 0) pushRecentActivity(s.recentFailures, `Command failed (${exitCode}): ${cmd}`, 4);
    else s.completedCommands++;
  }
  emit();
}

function handleCompletedToolCall(item: any, s: CodexStreamState, emit: () => void): void {
  const toolCall = s.activeToolCalls.get(item.id) || summarizeCodexToolCall(item);
  s.activeToolCalls.delete(item.id);
  if (toolCall) {
    if (isCodexToolCallFailure(item)) pushRecentActivity(s.recentFailures, `${toolCall.summary} failed`, 4);
    else if (toolCall.kind !== 'apply_patch') pushRecentActivity(s.recentNarrative, `${toolCall.summary} done`);
  }
  emit();
}

function handleTurnPlanUpdated(params: any, s: CodexStreamState, emit: () => void): void {
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

// ---------------------------------------------------------------------------
// Stream request handler (extracted from doCodexStream)
// ---------------------------------------------------------------------------

async function handleCodexRequest(
  method: string, params: any, requestId: string,
  s: CodexStreamState, opts: StreamOpts,
  emit: () => void,
): Promise<Record<string, any>> {
  const interaction = buildCodexInteractionRequest(method, params, requestId);
  if (!interaction) return defaultCodexServerRequestResponse(method);

  pushRecentActivity(s.recentNarrative, interaction.kind === 'requestUserInput' ? 'Waiting for user input' : 'Waiting for approval');
  emit();

  try {
    if (opts.onCodexInteractionRequest) {
      const response = await opts.onCodexInteractionRequest(interaction);
      return response ?? defaultCodexInteractionResponse(interaction);
    }
  } catch (error: any) {
    pushRecentActivity(s.recentFailures, `Human input failed: ${shortValue(error?.message || error, 120)}`, 4);
    emit();
  }
  return defaultCodexInteractionResponse(interaction);
}

// ---------------------------------------------------------------------------
// Stream via app-server
// ---------------------------------------------------------------------------

export async function doCodexStream(opts: StreamOpts): Promise<StreamResult> {
  const start = Date.now();
  const srv = new CodexAppServer();
  let timedOut = false;
  let interrupted = false;
  let unsubscribeNotifications = () => {};
  let unsubscribeRequests = () => {};
  let settleTurnDone: (() => void) | null = null;
  let emitPreview = () => {};
  let publishedTurnControl = false;

  try {
    const config: string[] = [];
    if (opts.codexExtraArgs?.length) {
      for (let i = 0; i < opts.codexExtraArgs.length; i++) {
        if (opts.codexExtraArgs[i] === '-c' && opts.codexExtraArgs[i + 1]) config.push(opts.codexExtraArgs[++i]);
      }
    }

    if (!(await srv.ensureRunning(config))) {
      return codexErrorResult('Failed to start codex app-server.', start, opts.sessionId, opts.model, opts.thinkingEffort);
    }

    const s = createCodexStreamState(opts);
    const publishTurnControl = () => {
      if (publishedTurnControl || !opts.onCodexTurnReady || !s.sessionId || !s.turnId) return;
      publishedTurnControl = true;
      try {
        const control = {
          threadId: s.sessionId,
          turnId: s.turnId,
          steer: async (prompt: string, attachments: string[] = []) => {
            if (!s.sessionId || !s.turnId) return false;
            const expectedTurnId = s.turnId;
            const clippedPrompt = prompt.slice(0, 200);
            agentLog(`[codex-rpc] turn/steer turn=${expectedTurnId} prompt="${clippedPrompt}${prompt.length > 200 ? '…' : ''}"`);
            const steerResp = await srv.call('turn/steer', {
              threadId: s.sessionId,
              expectedTurnId,
              input: buildCodexTurnInput(prompt, attachments),
            }, 30_000);
            if (steerResp.error) {
              const errMsg = steerResp.error.message || 'turn/steer failed';
              agentWarn(`[codex-rpc] turn/steer error: ${errMsg}`);
              pushRecentActivity(s.recentFailures, `Steer failed: ${shortValue(errMsg, 120)}`, 4);
              emitPreview();
              return false;
            }
            s.turnId = steerResp.result?.turnId ?? s.turnId;
            pushRecentActivity(s.recentNarrative, 'Applied steer input');
            emitPreview();
            return true;
          },
        };
        opts.onSteerReady?.(control.steer);
        opts.onCodexTurnReady?.(control);
      } catch (error: any) {
        agentWarn(`[codex-rpc] onCodexTurnReady error: ${error?.message || error}`);
      }
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
      threadResp = await srv.call('thread/resume', { threadId: opts.sessionId, ...threadParams }, 60_000);
    } else {
      agentLog(`[codex-rpc] thread/start cwd=${opts.workdir} model=${opts.codexModel || '(default)'}`);
      threadResp = await srv.call('thread/start', threadParams, 60_000);
    }

    if (threadResp.error) {
      const errMsg = threadResp.error.message || 'thread/start failed';
      agentWarn(`[codex-rpc] thread error: ${errMsg}`);
      return codexErrorResult(errMsg, start, opts.sessionId, opts.model, opts.thinkingEffort);
    }

    const threadResult = threadResp.result;
    s.sessionId = threadResult.thread?.id ?? s.sessionId;
    s.model = threadResult.model ?? s.model;
    if (s.sessionId) {
      try { opts.onSessionId?.(s.sessionId); } catch (error: any) {
        agentWarn(`[codex-rpc] onSessionId error: ${error?.message || error}`);
      }
    }
    agentLog(`[codex-rpc] thread ready: id=${s.sessionId} model=${s.model}`);

    // turn/start
    const input = buildCodexTurnInput(opts.prompt, opts.attachments || []);
    const deadline = start + opts.timeout * 1000;

    const turnDone = new Promise<void>((resolve) => {
      let settled = false;
      settleTurnDone = () => {
        if (settled) return;
        settled = true;
        settleTurnDone = null;
        resolve();
      };
      const hardTimer = setTimeout(() => {
        timedOut = true;
        agentWarn('[codex-rpc] timeout: interrupting turn');
        if (s.turnId && s.sessionId) srv.call('turn/interrupt', { threadId: s.sessionId, turnId: s.turnId }).catch(() => {});
        settleTurnDone?.();
      }, opts.timeout * 1000 + CODEX_STREAM_HARD_KILL_GRACE_MS);

      const emit = () => {
        s.activity = buildCodexActivityPreview(s);
        opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), s.plan);
      };
      emitPreview = emit;

      unsubscribeNotifications = srv.onNotification((method, params) => {
        handleCodexNotification(method, params, s, opts, deadline, emit, hardTimer, settleTurnDone, publishTurnControl);
      });
      unsubscribeRequests = srv.onRequest((method, params, requestId) => {
        return handleCodexRequest(method, params, requestId, s, opts, emit);
      });
    });

    const abortStream = () => {
      if (interrupted) return;
      interrupted = true;
      s.turnStatus = s.turnStatus || 'interrupted';
      s.turnError = s.turnError || 'Interrupted by user.';
      agentWarn(`[codex-rpc] abort requested thread=${s.sessionId || '?'} turn=${s.turnId || '?'}`);
      if (s.turnId && s.sessionId) {
        // Send turn/interrupt and wait for Codex to acknowledge before settling.
        // Don't kill the process here — let the finally block handle it after
        // Codex has had time to persist the interrupted session state.
        srv.call('turn/interrupt', { threadId: s.sessionId, turnId: s.turnId }, 5_000)
          .finally(() => settleTurnDone?.());
      } else {
        srv.kill();
        settleTurnDone?.();
      }
    };
    if (opts.abortSignal?.aborted) abortStream();
    opts.abortSignal?.addEventListener('abort', abortStream, { once: true });

    // Log equivalent CLI command for reproducibility
    const cliParts = ['codex'];
    if (opts.codexModel) cliParts.push('--model', opts.codexModel);
    if (opts.codexFullAccess) cliParts.push('--full-access');
    const effort = mapEffort(opts.thinkingEffort);
    if (effort) cliParts.push('--effort', effort);
    if (opts.sessionId) cliParts.push('--resume', opts.sessionId);
    if (opts.codexExtraArgs?.length) cliParts.push(...opts.codexExtraArgs);
    cliParts.push('-p', `"${opts.prompt.slice(0, 300)}${opts.prompt.length > 300 ? '…' : ''}"`);
    agentLog(`[codex-rpc] full command: cd ${Q(opts.workdir)} && ${cliParts.join(' ')}`);

    agentLog(`[codex-rpc] turn/start prompt="${opts.prompt.slice(0, 300)}${opts.prompt.length > 300 ? '…' : ''}" effort=${effort}`);
    const turnResp = await srv.call('turn/start', {
      threadId: s.sessionId, input,
      model: opts.codexModel || undefined,
      effort: mapEffort(opts.thinkingEffort),
    }, 60_000);

    if (turnResp.error) {
      opts.abortSignal?.removeEventListener('abort', abortStream);
      unsubscribeNotifications();
      unsubscribeRequests();
      const errMsg = turnResp.error.message || 'turn/start failed';
      agentWarn(`[codex-rpc] turn/start error: ${errMsg}`);
      return codexErrorResult(errMsg, start, s.sessionId, s.model, s.thinkingEffort);
    }
    s.turnId = turnResp.result?.turn?.id ?? null;
    publishTurnControl();

    await turnDone;
    opts.abortSignal?.removeEventListener('abort', abortStream);
    unsubscribeNotifications();
    unsubscribeRequests();

    if (!s.text.trim() && s.msgs.length) s.text = s.msgs.join('\n\n');
    if (!s.thinking.trim() && s.thinkParts.length) s.thinking = s.thinkParts.join('\n\n');

    const ok = s.turnStatus === 'completed' && !timedOut && !interrupted;
    const error = s.turnError
      || (interrupted ? 'Interrupted by user.' : null)
      || (timedOut ? `Timed out after ${opts.timeout}s waiting for turn completion.` : null)
      || (!ok ? `Turn ${s.turnStatus || 'unknown'}.` : null);
    const stopReason = timedOut ? 'timeout' : ((interrupted || s.turnStatus === 'interrupted') ? 'interrupted' : null);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    agentLog(`[codex-rpc] result: ok=${ok} elapsed=${elapsed}s text=${s.text.length}chars session=${s.sessionId} status=${s.turnStatus}`);

    return {
      ok, sessionId: s.sessionId,
      workspacePath: null, model: s.model, thinkingEffort: s.thinkingEffort,
      message: s.text.trim() || error || '(no textual response)',
      thinking: s.thinking.trim() || null,
      plan: s.plan?.steps?.length ? s.plan : null,
      elapsedS: (Date.now() - start) / 1000,
      inputTokens: s.inputTokens, outputTokens: s.outputTokens,
      cachedInputTokens: s.cachedInputTokens, cacheCreationInputTokens: s.cacheCreationInputTokens,
      contextWindow: s.contextWindow, ...computeContext(s),
      codexCumulative: s.codexCumulative, error, stopReason, incomplete: !ok,
      activity: s.activity.trim() || null,
    };
  } finally {
    unsubscribeNotifications();
    unsubscribeRequests();
    srv.kill();
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Load title index from ~/.codex/session_index.jsonl (deduped, last entry wins). */
function loadCodexSessionIndex(): Map<string, { threadName: string; updatedAt: string }> {
  const home = process.env.HOME || '';
  if (!home) return new Map();
  const indexPath = path.join(home, '.codex', 'session_index.jsonl');
  if (!fs.existsSync(indexPath)) return new Map();
  const map = new Map<string, { threadName: string; updatedAt: string }>();
  try {
    const data = fs.readFileSync(indexPath, 'utf8');
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.id) map.set(entry.id, { threadName: entry.thread_name || '', updatedAt: entry.updated_at || '' });
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return map;
}

/** Scan ~/.codex/sessions/ rollout files to find sessions matching the given workdir. */
function extractCodexTailQA(filePath: string): { lastQuestion: string | null; lastAnswer: string | null; lastMessageText: string | null } {
  const lines = readTailLines(filePath, 128 * 1024);
  let lastQuestion: string | null = null;
  let lastAnswer: string | null = null;
  let lastMessageText: string | null = null;
  for (const raw of lines) {
    if (!raw || raw[0] !== '{' || !raw.includes('"event_msg"')) continue;
    try {
      const ev = JSON.parse(raw);
      if (ev?.type !== 'event_msg' || !ev.payload || typeof ev.payload !== 'object') continue;
      if (ev.payload.type === 'user_message' && typeof ev.payload.message === 'string') {
        const text = sanitizeSessionUserPreviewText(ev.payload.message);
        if (text) {
          lastQuestion = shortValue(text, 500);
          lastMessageText = shortValue(text, 500);
        }
      } else if (ev.payload.type === 'agent_message' && typeof ev.payload.message === 'string') {
        const text = ev.payload.message.trim();
        if (text) {
          lastAnswer = shortValue(text, 500);
          lastMessageText = shortValue(text, 500);
        }
      }
    } catch { /* skip */ }
  }
  return { lastQuestion, lastAnswer, lastMessageText };
}

function readCodexSessionHead(filePath: string): { sessionId: string; cwd: string; timestamp: string | null; isSubagent: boolean } | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, bytesRead);
    if (!head.includes('"session_meta"')) return null;

    const idMatch = head.match(/"id"\s*:\s*"([^"]+)"/);
    const cwdMatch = head.match(/"cwd"\s*:\s*"([^"]+)"/);
    const tsMatch = head.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (!idMatch || !cwdMatch) return null;

    return {
      sessionId: idMatch[1],
      cwd: cwdMatch[1],
      timestamp: tsMatch?.[1] || null,
      isSubagent: /"source"\s*:\s*\{\s*"subagent"\s*:/.test(head) || /"thread_spawn"\s*:/.test(head),
    };
  } catch {
    return null;
  }
}

function getNativeCodexSessions(workdir: string): SessionInfo[] {
  const home = process.env.HOME || '';
  if (!home) return [];
  const sessionsDir = path.join(home, '.codex', 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const resolvedWorkdir = path.resolve(workdir);
  const titleIndex = loadCodexSessionIndex();
  const sessions: SessionInfo[] = [];
  const seenIds = new Set<string>();

  // Walk year/month/day directories
  const walkDir = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkDir(fullPath); continue; }
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;

      // Read first chunk to extract session_meta fields via regex
      // (first line can be very large due to base_instructions, so we avoid full JSON parse)
      try {
        const meta = readCodexSessionHead(fullPath);
        if (!meta) continue;
        if (meta.isSubagent) continue;
        if (path.resolve(meta.cwd) !== resolvedWorkdir) continue;
        const metaId = meta.sessionId;
        const metaCwd = meta.cwd;
        if (seenIds.has(metaId)) continue;
        seenIds.add(metaId);

        const stat = fs.statSync(fullPath);
        const idx = titleIndex.get(metaId);
        const title = idx?.threadName || null;
        const updatedAt = idx?.updatedAt || stat.mtime.toISOString();
        const tailQA = extractCodexTailQA(fullPath);

        sessions.push({
          sessionId: metaId,
          agent: 'codex',
          workdir: metaCwd,
          workspacePath: null,
          model: null,
          createdAt: meta.timestamp || stat.birthtime.toISOString(),
          title,
          running: Date.now() - Date.parse(updatedAt) < SESSION_RUNNING_THRESHOLD_MS,
          runState: Date.now() - Date.parse(updatedAt) < SESSION_RUNNING_THRESHOLD_MS ? 'running' : 'completed',
          runDetail: null,
          runUpdatedAt: updatedAt,
          classification: null,
          userStatus: null,
          userNote: null,
          lastQuestion: tailQA.lastQuestion,
          lastAnswer: tailQA.lastAnswer,
          lastMessageText: tailQA.lastMessageText,
          migratedFrom: null,
          migratedTo: null,
          linkedSessions: [],
          numTurns: null,
        });
      } catch { /* skip */ }
    }
  };

  walkDir(sessionsDir);
  return sessions;
}

function readCodexSessionMeta(filePath: string): { sessionId: string; cwd: string } | null {
  const meta = readCodexSessionHead(filePath);
  if (!meta) return null;
  return { sessionId: meta.sessionId, cwd: meta.cwd };
}

function findCodexRolloutPath(sessionId: string, workdir: string): string | null {
  const home = process.env.HOME || '';
  if (!home) return null;
  const sessionsRoot = path.join(home, '.codex', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;
  const resolvedWorkdir = path.resolve(workdir);

  const walkDir = (dir: string): string | null => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walkDir(fullPath);
        if (found) return found;
        continue;
      }
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      const meta = readCodexSessionMeta(fullPath);
      if (!meta) continue;
      if (meta.sessionId === sessionId && path.resolve(meta.cwd) === resolvedWorkdir) return fullPath;
    }
    return null;
  };

  return walkDir(sessionsRoot);
}

function getCodexSessionTailFromRollout(opts: SessionTailOpts): SessionTailResult {
  const limit = opts.limit ?? 4;
  const rolloutPath = findCodexRolloutPath(opts.sessionId, opts.workdir);
  if (!rolloutPath) return { ok: false, messages: [], error: 'Session history file not found' };

  try {
    const lines = readTailLines(rolloutPath, 512 * 1024);
    const allMsgs: { role: 'user' | 'assistant'; text: string }[] = [];
    for (const raw of lines) {
      if (!raw || raw[0] !== '{' || !raw.includes('"event_msg"')) continue;
      let ev: any;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev?.type !== 'event_msg' || !ev.payload || typeof ev.payload !== 'object') continue;
      if (ev.payload.type === 'user_message' && typeof ev.payload.message === 'string') {
        const text = stripInjectedPrompts(ev.payload.message).trim();
        if (text) allMsgs.push({ role: 'user', text });
      } else if (ev.payload.type === 'agent_message' && typeof ev.payload.message === 'string') {
        const text = ev.payload.message.trim();
        if (text) allMsgs.push({ role: 'assistant', text });
      }
    }
    return { ok: true, messages: allMsgs.slice(-limit), error: null };
  } catch (error: any) {
    return { ok: false, messages: [], error: error?.message || 'Failed to read session history' };
  }
}

function getCodexSessions(workdir: string, limit?: number): SessionListResult {
  const resolvedWorkdir = path.resolve(workdir);
  // Merge pikiclaw-tracked sessions with native Codex sessions
  const pikiclawSessions = listPikiclawSessions(resolvedWorkdir, 'codex').map(record => ({
    sessionId: record.sessionId,
    agent: 'codex' as const,
    workdir: record.workdir,
    workspacePath: record.workspacePath,
    threadId: record.threadId,
    model: record.model,
    createdAt: record.createdAt,
    title: record.title,
    running: record.runState === 'running',
    runState: record.runState,
    runDetail: record.runDetail,
    runUpdatedAt: record.runUpdatedAt,
    classification: record.classification,
    userStatus: record.userStatus,
    userNote: record.userNote,
    lastQuestion: record.lastQuestion,
    lastAnswer: record.lastAnswer,
    lastMessageText: record.lastMessageText,
    migratedFrom: record.migratedFrom,
    migratedTo: record.migratedTo,
    linkedSessions: record.linkedSessions,
    numTurns: record.numTurns ?? null,
  }));
  const nativeSessions = getNativeCodexSessions(resolvedWorkdir);
  const merged = mergeManagedAndNativeSessions(pikiclawSessions, nativeSessions);
  const sessions = typeof limit === 'number' ? merged.slice(0, limit) : merged;
  const sessionsDir = path.join(process.env.HOME || '', '.codex', 'sessions');
  agentLog(
    `[sessions:codex] workdir=${resolvedWorkdir} sessionsDir=${sessionsDir} sessionsDirExists=${fs.existsSync(sessionsDir)} ` +
    `pikiclaw=${pikiclawSessions.length} native=${nativeSessions.length} merged=${sessions.length}`
  );
  return { ok: true, sessions, error: null };
}

async function getCodexSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
  const limit = opts.limit ?? 4;
  const srv = getSharedServer();
  if (!(await srv.ensureRunning())) return getCodexSessionTailFromRollout(opts);

  const resp = await srv.call('thread/read', { threadId: opts.sessionId, includeTurns: true });
  if (resp.error) {
    const fallback = getCodexSessionTailFromRollout(opts);
    return fallback.ok ? fallback : { ok: false, messages: [], error: resp.error.message || fallback.error || 'thread/read failed' };
  }
  const thread = resp.result?.thread;
  if (!thread) {
    const fallback = getCodexSessionTailFromRollout(opts);
    return fallback.ok ? fallback : { ok: false, messages: [], error: 'No thread data returned' };
  }

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
  const messages = allMsgs.slice(-limit);
  if (messages.length > 0) return { ok: true, messages, error: null };
  return getCodexSessionTailFromRollout(opts);
}

// ---------------------------------------------------------------------------
// Session messages (full content)
// ---------------------------------------------------------------------------

async function getCodexSessionMessages(opts: SessionMessagesOpts): Promise<SessionMessagesResult> {
  if (opts.rich) {
    const rolloutResult = getCodexSessionMessagesFromRollout(opts);
    if (rolloutResult.ok) return rolloutResult;
  }

  // Try RPC first
  const srv = getSharedServer();
  if (await srv.ensureRunning()) {
    try {
      const resp = await srv.call('thread/read', { threadId: opts.sessionId, includeTurns: true });
      if (!resp.error && resp.result?.thread) {
        const thread = resp.result.thread;
        const allMsgs: TailMessage[] = [];
        const richMsgs: RichMessage[] = [];
        for (const turn of (thread.turns ?? [])) {
          for (const item of (turn.items ?? [])) {
            if (item.type === 'userMessage') {
              const parts: string[] = [];
              const blocks: MessageBlock[] = [];
              for (const c of (item.content ?? [])) {
                if (c.type === 'text' && c.text) parts.push(c.text);
                else if (c.type === 'localImage' && c.path) {
                  // Read the image file if it still exists
                  try {
                    if (fs.existsSync(c.path) && fs.statSync(c.path).size <= 4 * 1024 * 1024) {
                      const ext = path.extname(c.path).toLowerCase();
                      const data = fs.readFileSync(c.path).toString('base64');
                      blocks.push({ type: 'image', content: `data:${mimeForExt(ext)};base64,${data}` });
                    }
                  } catch { /* skip unreadable images */ }
                }
              }
              if (parts.length || blocks.length) {
                const text = stripInjectedPrompts(parts.join('\n'));
                if (text) blocks.unshift({ type: 'text', content: text });
                allMsgs.push({ role: 'user', text });
                richMsgs.push({ role: 'user', text, blocks });
              }
            } else if (item.type === 'agentMessage') {
              if (item.text) {
                allMsgs.push({ role: 'assistant', text: item.text });
                richMsgs.push({
                  role: 'assistant',
                  text: item.text,
                  blocks: [{
                    type: 'text',
                    content: item.text,
                    phase: item.phase === 'commentary' ? 'commentary' : 'final_answer',
                  }],
                });
              }
            }
          }
        }
        if (allMsgs.length > 0) {
          return applyTurnWindow(allMsgs, opts, richMsgs);
        }
      }
    } catch { /* fall through to rollout */ }
  }

  // Fallback: read full rollout file
  return getCodexSessionMessagesFromRollout(opts);
}

function getCodexSessionMessagesFromRollout(opts: SessionMessagesOpts): SessionMessagesResult {
  const rolloutPath = findCodexRolloutPath(opts.sessionId, opts.workdir);
  if (!rolloutPath) return { ok: false, messages: [], totalTurns: 0, error: 'Session history file not found' };

  try {
    const content = fs.readFileSync(rolloutPath, 'utf-8');
    const lines = content.split('\n');
    const allMsgs: TailMessage[] = [];
    const richMsgs: RichMessage[] = [];
    const fallbackMsgs: TailMessage[] = [];
    let pendingAssistant: PendingCodexAssistantMessage | null = null;
    let sawAssistantResponseItems = false;

    const ensureAssistant = (): PendingCodexAssistantMessage => {
      if (!pendingAssistant) pendingAssistant = { blocks: [], toolNamesByCallId: new Map() };
      return pendingAssistant;
    };

    const flushAssistant = () => {
      if (!pendingAssistant) return;
      const blocks = pendingAssistant.blocks.filter(block =>
        block.type === 'plan'
        || block.type === 'image'
        || block.type === 'tool_use'
        || block.type === 'tool_result'
        || !!block.content.trim(),
      );
      pendingAssistant = null;
      if (!blocks.length) return;
      const text = buildCodexAssistantText(blocks);
      allMsgs.push({ role: 'assistant', text });
      richMsgs.push({ role: 'assistant', text, blocks });
    };

    for (const raw of lines) {
      if (!raw || raw[0] !== '{') continue;
      let ev: any;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (!ev?.payload || typeof ev.payload !== 'object') continue;

      if (ev.type === 'event_msg') {
        if (ev.payload.type === 'user_message' && typeof ev.payload.message === 'string') {
          flushAssistant();
          const text = stripInjectedPrompts(ev.payload.message).trim();
          if (!text) continue;
          const userMessage: TailMessage = { role: 'user', text };
          fallbackMsgs.push(userMessage);
          allMsgs.push(userMessage);
          richMsgs.push({ role: 'user', text, blocks: [{ type: 'text', content: text }] });
        } else if (ev.payload.type === 'agent_message' && typeof ev.payload.message === 'string') {
          const text = ev.payload.message.trim();
          if (text) fallbackMsgs.push({ role: 'assistant', text });
        }
        continue;
      }

      if (ev.type !== 'response_item') continue;
      const payload = ev.payload;

      if (payload.type === 'message') {
        if (payload.role !== 'assistant') continue;
        const text = extractCodexMessageText(payload.content);
        if (!text) continue;
        ensureAssistant().blocks.push({
          type: 'text',
          content: text,
          phase: payload.phase === 'commentary' ? 'commentary' : 'final_answer',
        });
        sawAssistantResponseItems = true;
        continue;
      }

      if (payload.type === 'reasoning') {
        const text = extractCodexReasoningText(payload);
        if (!text) continue;
        ensureAssistant().blocks.push({ type: 'thinking', content: text });
        sawAssistantResponseItems = true;
        continue;
      }

      if (payload.type === 'function_call') {
        const name = typeof payload.name === 'string' ? payload.name.trim() : '';
        if (!name) continue;
        const assistant = ensureAssistant();
        const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
        if (callId) assistant.toolNamesByCallId.set(callId, name);
        if (name === 'update_plan') {
          const plan = normalizeStreamPreviewPlan(parseCodexArguments(payload.arguments));
          if (plan) {
            assistant.blocks.push({
              type: 'plan',
              content: formatCodexPlanSummary(plan),
              plan,
            });
            sawAssistantResponseItems = true;
          }
          continue;
        }
        assistant.blocks.push({
          type: 'tool_use',
          content: formatCodexArguments(payload.arguments),
          toolName: name,
          toolId: callId || undefined,
        });
        sawAssistantResponseItems = true;
        continue;
      }

      if (payload.type === 'function_call_output') {
        const assistant = ensureAssistant();
        const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
        const toolName = assistant.toolNamesByCallId.get(callId) || '';
        const output = formatCodexArguments(payload.output);
        if (toolName === 'update_plan' && output === 'Plan updated') continue;
        assistant.blocks.push({
          type: 'tool_result',
          content: output,
          toolName: toolName || undefined,
          toolId: callId || undefined,
        });
        sawAssistantResponseItems = true;
        continue;
      }

      const fallbackSummary = summarizeCodexRawResponseItem(payload);
      if (fallbackSummary) {
        ensureAssistant().blocks.push({
          type: 'tool_use',
          content: formatCodexArguments(payload),
          toolName: fallbackSummary,
        });
        sawAssistantResponseItems = true;
      }
    }
    flushAssistant();

    if (!sawAssistantResponseItems && fallbackMsgs.some(message => message.role === 'assistant')) {
      return applyTurnWindow(fallbackMsgs, opts);
    }

    const richWithOverlay = overlayCodexManagedPreview(opts.workdir, opts.sessionId, richMsgs);
    const plainWithOverlay = richWithOverlay.map(message => ({ role: message.role, text: message.text }));
    return applyTurnWindow(plainWithOverlay, opts, opts.rich ? richWithOverlay : undefined);
  } catch (e: any) {
    return { ok: false, messages: [], totalTurns: 0, error: e?.message || 'Failed to read session history' };
  }
}

// ---------------------------------------------------------------------------
// Models (with TTL cache + stale fallback)
// ---------------------------------------------------------------------------

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let modelCache: { result: ModelListResult; fetchedAt: number } | null = null;

function pushModel(models: ModelInfo[], seen: Set<string>, id: string, alias: string | null) {
  const cleanId = id.trim();
  if (!cleanId || seen.has(cleanId)) return;
  seen.add(cleanId);
  models.push({ id: cleanId, alias: alias?.trim() || null });
}

/** Merge currentModel into a cached result so the selected model always appears first. */
function withCurrentModel(cached: ModelListResult, currentModel: string | null | undefined): ModelListResult {
  if (!currentModel?.trim()) return cached;
  const cm = currentModel.trim();
  if (cached.models.some(m => m.id === cm)) return cached;
  return { ...cached, models: [{ id: cm, alias: null }, ...cached.models] };
}

async function discoverCodexModels(opts: ModelListOpts): Promise<ModelListResult> {
  // Return cached result if still fresh
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return withCurrentModel(modelCache.result, opts.currentModel);
  }

  // Try fetching fresh
  const srv = getSharedServer();
  if (!(await srv.ensureRunning())) {
    if (modelCache) return withCurrentModel(modelCache.result, opts.currentModel);
    return { agent: 'codex', models: [], sources: [], note: 'Failed to start codex app-server.' };
  }

  const resp = await srv.call('model/list', { includeHidden: false });
  if (resp.error) {
    if (modelCache) return withCurrentModel(modelCache.result, opts.currentModel);
    return { agent: 'codex', models: [], sources: [], note: resp.error.message || 'model/list failed' };
  }

  const data: any[] = resp.result?.data ?? [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  if (opts.currentModel?.trim()) pushModel(models, seen, opts.currentModel.trim(), null);
  for (const entry of data) {
    const id = entry.model || entry.id;
    if (!id || seen.has(id)) continue;
    pushModel(models, seen, id, entry.displayName && entry.displayName !== id ? entry.displayName : null);
  }

  const result: ModelListResult = { agent: 'codex', models, sources: ['app-server model/list'], note: null };
  modelCache = { result, fetchedAt: Date.now() };
  return result;
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

  async doStream(opts: StreamOpts): Promise<StreamResult> { return doCodexStream(opts); }

  async getSessions(workdir: string, limit?: number): Promise<SessionListResult> {
    return getCodexSessions(workdir, limit);
  }

  async getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
    return getCodexSessionTail(opts);
  }

  async getSessionMessages(opts: SessionMessagesOpts): Promise<SessionMessagesResult> {
    return getCodexSessionMessages(opts);
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
