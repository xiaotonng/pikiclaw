/**
 * CLI spawn framework, stream orchestration, agent detection, and driver delegation.
 */

import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../core/process-control.js';
import { AGENT_DETECT_TIMEOUTS, AGENT_STREAM_HARD_KILL_GRACE_MS } from '../core/constants.js';
import { getDriver, allDrivers } from './driver.js';
import type {
  Agent, AgentDetectOptions, AgentInfo, AgentListResult,
  StreamOpts, StreamResult, CodexCumulativeUsage,
  ModelListOpts, ModelListResult, UsageOpts, UsageResult,
  SessionListOpts, SessionListResult, SessionTailOpts, SessionTailResult,
  SessionMessagesOpts, SessionMessagesResult,
  StreamPreviewMeta,
} from './types.js';
import {
  Q, agentLog, agentWarn, agentError, joinErrorMessages, normalizeErrorMessage,
  buildStreamPreviewMeta, computeContext, shortValue, isPendingSessionId, dedupeStrings,
  normalizeStreamPreviewPlan,
} from './utils.js';
import {
  saveSessionRecord, setSessionRunState, applySessionRunResult,
  ensureSessionWorkspace, importFilesIntoWorkspace, syncManagedSessionIdentity,
  summarizePromptTitle,
} from './session.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function trimSessionText(value: unknown, max = 24_000): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

// ---------------------------------------------------------------------------
// Agent detection (private helpers and cache)
// ---------------------------------------------------------------------------

const AGENT_DETECT_TTL_MS = AGENT_DETECT_TIMEOUTS.detectTtl;
const AGENT_VERSION_TTL_MS = AGENT_DETECT_TIMEOUTS.versionTtl;
const AGENT_VERSION_TIMEOUT_MS = AGENT_DETECT_TIMEOUTS.versionCommand;

interface AgentDetectCacheEntry {
  detectedAt: number;
  versionAt: number;
  info: AgentInfo;
}

const agentDetectCache = new Map<string, AgentDetectCacheEntry>();

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableCandidates(cmd: string): string[] {
  if (process.platform !== 'win32') return [cmd];
  const ext = path.extname(cmd).toLowerCase();
  if (ext) return [cmd];
  const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(value => value.trim())
    .filter(Boolean);
  return [cmd, ...pathExt.map(value => `${cmd}${value.toLowerCase()}`)];
}

function resolveAgentBinPath(cmd: string): string | null {
  const raw = String(cmd || '').trim();
  if (!raw) return null;

  const hasPathSeparator = raw.includes('/') || raw.includes('\\');
  if (hasPathSeparator) {
    const absolutePath = path.resolve(raw);
    for (const candidate of executableCandidates(absolutePath)) {
      if (isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  const searchPaths = String(process.env.PATH || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);

  for (const dir of searchPaths) {
    for (const candidate of executableCandidates(path.join(dir, raw))) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function readAgentVersion(binPath: string, timeoutMs: number): string | null {
  try {
    const devnull = process.platform === 'win32' ? '2>nul' : '2>/dev/null';
    return execSync(`${Q(binPath)} --version ${devnull}`, {
      encoding: 'utf-8',
      timeout: Math.max(250, timeoutMs),
    }).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

// Agent detection (used by all drivers)
export function detectAgentBin(cmd: string, agent: string, options: AgentDetectOptions = {}): AgentInfo {
  const cacheKey = `${agent}:${cmd}`;
  const now = Date.now();
  const includeVersion = !!options.includeVersion;
  const refresh = !!options.refresh;
  const versionTimeoutMs = options.versionTimeoutMs ?? AGENT_VERSION_TIMEOUT_MS;
  let entry = agentDetectCache.get(cacheKey) || null;

  const shouldRefreshBase = refresh || !entry || now - entry.detectedAt > AGENT_DETECT_TTL_MS;
  if (shouldRefreshBase) {
    const binPath = resolveAgentBinPath(cmd);
    const previousVersion = entry?.info.path === binPath ? entry.info.version ?? null : null;
    const previousVersionAt = entry?.info.path === binPath ? entry.versionAt : 0;
    entry = {
      detectedAt: now,
      versionAt: previousVersionAt,
      info: {
        agent,
        installed: !!binPath,
        path: binPath,
        version: previousVersion,
      },
    };
    agentDetectCache.set(cacheKey, entry);
  }

  if (!entry) {
    return { agent, installed: false, path: null, version: null };
  }

  if (
    includeVersion
    && entry.info.installed
    && entry.info.path
    && (refresh || !entry.versionAt || now - entry.versionAt > AGENT_VERSION_TTL_MS)
  ) {
    entry.info.version = readAgentVersion(entry.info.path, versionTimeoutMs);
    entry.versionAt = now;
    agentDetectCache.set(cacheKey, entry);
  }

  return { ...entry.info };
}

export function listAgents(options: AgentDetectOptions = {}): AgentListResult {
  return { agents: allDrivers().map(d => detectAgentBin(d.cmd, d.id, options)) };
}

// ---------------------------------------------------------------------------
// Shared CLI spawn framework (used by driver-claude.ts, driver-gemini.ts)
// ---------------------------------------------------------------------------

export async function run(cmd: string[], opts: StreamOpts, parseLine: (ev: any, s: any) => void): Promise<StreamResult> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;
  let stderr = '';
  let lineCount = 0;
  let timedOut = false;
  let interrupted = false;
  const s = {
    sessionId: opts.sessionId, text: '', thinking: '', msgs: [] as string[], thinkParts: [] as string[],
    model: opts.model, thinkingEffort: opts.thinkingEffort, errors: null as unknown[] | null,
    inputTokens: null as number | null, outputTokens: null as number | null, cachedInputTokens: null as number | null,
    cacheCreationInputTokens: null as number | null, contextWindow: null as number | null,
    contextUsedTokens: null as number | null,
    codexCumulative: null as CodexCumulativeUsage | null,
    stopReason: null as string | null, activity: '',
    recentActivity: [] as string[],
    claudeToolsById: new Map<string, { name: string; summary: string }>(),
    seenClaudeToolIds: new Set<string>(),
    geminiToolsById: new Map<string, { name: string; summary: string }>(),
  };

  const shellCmd = cmd.map(Q).join(' ');
  agentLog(`[spawn] full command: cd ${Q(opts.workdir)} && ${shellCmd}`);
  agentLog(`[spawn] timeout: ${opts.timeout}s session: ${opts.sessionId || '(new)'}`);
  agentLog(`[spawn] prompt (stdin): "${opts.prompt.slice(0, 300)}${opts.prompt.length > 300 ? '…' : ''}"`);

  const spawnEnv = { ...process.env, ...(opts.extraEnv || {}) };
  delete spawnEnv.CLAUDECODE;
  const proc = spawn(shellCmd, {
    cwd: opts.workdir,
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
  });
  agentLog(`[spawn] pid=${proc.pid}`);
  const abortStream = () => {
    if (interrupted || proc.killed) return;
    interrupted = true;
    s.stopReason = 'interrupted';
    agentLog(`[abort] user interrupt, killing process tree pid=${proc.pid}`);
    terminateProcessTree(proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 5000 });
  };
  if (opts.abortSignal?.aborted) abortStream();
  opts.abortSignal?.addEventListener('abort', abortStream, { once: true });
  try { proc.stdin!.write(opts._stdinOverride ?? opts.prompt); proc.stdin!.end(); } catch {}
  proc.stderr?.on('data', (c: Buffer) => { const chunk = c.toString(); stderr += chunk; agentLog(`[stderr] ${chunk.trim().slice(0, 200)}`); });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on('line', raw => {
    if (Date.now() > deadline) {
      timedOut = true;
      s.stopReason = 'timeout';
      agentWarn('[timeout] deadline exceeded, killing process tree');
      terminateProcessTree(proc, { signal: 'SIGKILL' });
      return;
    }
    const line = raw.trim();
    if (!line || line[0] !== '{') return;
    lineCount++;
    try {
      const ev = JSON.parse(line);
      const evType = ev.type || '?';
      if (evType === 'system' || evType === 'result' || evType === 'assistant' || evType === 'thread.started' || evType === 'turn.completed' || evType === 'item.completed') {
        agentLog(`[event] type=${evType} session=${ev.session_id || s.sessionId || '?'} model=${ev.model || s.model || '?'}`);
      }
      if (evType === 'stream_event') {
        const inner = ev.event || {};
        if (inner.type === 'message_start' || inner.type === 'message_delta') agentLog(`[event] stream_event/${inner.type} session=${ev.session_id || '?'}`);
      }
      parseLine(ev, s);
      opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), null);
    } catch {}
  });

  const hardTimer = setTimeout(() => {
    timedOut = true; s.stopReason = 'timeout';
    agentWarn(`[timeout] hard deadline reached (${opts.timeout}s), killing process tree pid=${proc.pid}`);
    terminateProcessTree(proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 5000 });
  }, opts.timeout * 1000 + AGENT_STREAM_HARD_KILL_GRACE_MS);

  const [procOk, code] = await new Promise<[boolean, number | null]>(resolve => {
    proc.on('close', code => { clearTimeout(hardTimer); agentLog(`[exit] code=${code} lines_parsed=${lineCount}`); resolve([code === 0, code]); });
    proc.on('error', e => { clearTimeout(hardTimer); agentError(`[error] ${e.message}`); stderr += e.message; resolve([false, -1]); });
  });
  opts.abortSignal?.removeEventListener('abort', abortStream);

  if (!s.text.trim() && s.msgs.length) s.text = s.msgs.join('\n\n');
  if (!s.thinking.trim() && s.thinkParts.length) s.thinking = s.thinkParts.join('\n\n');

  const errorText = joinErrorMessages(s.errors);
  const ok = procOk && !s.errors && !timedOut && !interrupted;
  const error = errorText
    || (interrupted ? 'Interrupted by user.' : null)
    || (timedOut ? `Timed out after ${opts.timeout}s before the agent reported completion.` : null)
    || (!procOk ? (stderr.trim() || `Failed (exit=${code}).`) : null);
  const incomplete = !ok || s.stopReason === 'max_tokens' || s.stopReason === 'timeout';
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  agentLog(`[result] ok=${ok && !s.errors} elapsed=${elapsed}s text=${s.text.length}chars thinking=${s.thinking.length}chars session=${s.sessionId || '?'}`);
  if (errorText) agentWarn(`[result] errors: ${errorText}`);
  if (s.stopReason) agentLog(`[result] stop_reason=${s.stopReason}`);
  if (stderr.trim() && !procOk) agentWarn(`[result] stderr: ${stderr.trim().slice(0, 300)}`);

  return {
    ok, sessionId: s.sessionId, workspacePath: null,
    model: s.model, thinkingEffort: s.thinkingEffort,
    message: s.text.trim() || errorText || (procOk ? '(no textual response)' : `Failed (exit=${code}).\n\n${stderr.trim() || '(no output)'}`),
    thinking: s.thinking.trim() || null,
    elapsedS: (Date.now() - start) / 1000,
    inputTokens: s.inputTokens, outputTokens: s.outputTokens, cachedInputTokens: s.cachedInputTokens,
    cacheCreationInputTokens: s.cacheCreationInputTokens, contextWindow: s.contextWindow,
    ...computeContext(s), codexCumulative: s.codexCumulative, error, stopReason: s.stopReason,
    incomplete, activity: s.activity.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Stream orchestration
// ---------------------------------------------------------------------------

function prepareStreamOpts(opts: StreamOpts): { prepared: StreamOpts; session: SessionWorkspaceInfo; attachments: string[]; stagedFiles: string[] } {
  const session = ensureSessionWorkspace({ agent: opts.agent, workdir: opts.workdir, sessionId: opts.sessionId, title: opts.prompt });
  const importedFiles = importFilesIntoWorkspace(session.workspacePath, opts.attachments || []);
  const attachmentRelPaths = dedupeStrings([...session.record.stagedFiles, ...importedFiles]);
  // Capture staged files for MCP bridge before clearing
  const stagedFiles = [...session.record.stagedFiles];
  session.record.stagedFiles = [];
  if (!session.record.title) session.record.title = summarizePromptTitle(opts.prompt) || null;
  session.record.lastQuestion = shortValue(opts.prompt, 500);
  session.record.lastMessageText = shortValue(opts.prompt, 500);
  setSessionRunState(session.record, 'running', null);
  saveSessionRecord(opts.workdir, session.record);

  const attachmentPaths = attachmentRelPaths.map(relPath => path.join(session.workspacePath, relPath));

  // For pending sessions, pass null sessionId to the CLI so it creates a new session
  const effectiveSessionId = isPendingSessionId(session.sessionId) ? null : session.sessionId;

  return {
    session,
    attachments: attachmentPaths,
    stagedFiles,
    prepared: {
      ...opts,
      sessionId: effectiveSessionId,
      attachments: attachmentPaths.length ? attachmentPaths : undefined,
      onSessionId: (nativeSessionId: string) => {
        if (syncManagedSessionIdentity(session, opts.workdir, nativeSessionId)) {
          saveSessionRecord(opts.workdir, session.record);
        }
        try {
          opts.onSessionId?.(nativeSessionId);
        } catch (error: any) {
          agentWarn(`[session] onSessionId callback failed: ${error?.message || error}`);
        }
      },
    },
  };
}

function finalizeStreamResult(result: StreamResult, workdir: string, prompt: string, session: SessionWorkspaceInfo): StreamResult {
  if (result.sessionId) syncManagedSessionIdentity(session, workdir, result.sessionId);
  session.record.model = result.model || session.record.model;
  if (!session.record.title) session.record.title = summarizePromptTitle(prompt);
  session.record.lastQuestion = shortValue(prompt, 500);
  session.record.lastAnswer = shortValue(result.message, 500);
  session.record.lastMessageText = shortValue(result.message, 500) || shortValue(prompt, 500);
  session.record.lastThinking = trimSessionText(result.thinking);
  session.record.lastPlan = normalizeStreamPreviewPlan(result.plan);
  applySessionRunResult(session.record, result);
  saveSessionRecord(workdir, session.record);
  return { ...result, sessionId: session.sessionId, workspacePath: session.workspacePath };
}

// SessionWorkspaceInfo type (matches the internal type used by session.ts)
interface SessionWorkspaceInfo {
  sessionId: string;
  workspacePath: string;
  record: import('./types.js').ManagedSessionRecord;
}

export async function doStream(opts: StreamOpts): Promise<StreamResult> {
  let session: SessionWorkspaceInfo;
  let prepared: StreamOpts;
  let stagedFiles: string[];
  try {
    const prep = prepareStreamOpts(opts);
    session = prep.session;
    prepared = prep.prepared;
    stagedFiles = prep.stagedFiles;
  } catch (e: any) {
    const message = e?.message || String(e);
    return {
      ok: false, message, thinking: null,
      sessionId: opts.sessionId, workspacePath: null, model: opts.model, thinkingEffort: opts.thinkingEffort,
      elapsedS: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null,
      cacheCreationInputTokens: null, contextWindow: null, contextUsedTokens: null, contextPercent: null,
      codexCumulative: null, error: message, stopReason: null, incomplete: true, activity: null, plan: null,
    };
  }

  // Start MCP bridge if sendFile callback is provided
  let bridge: import('./mcp/bridge.js').McpBridgeHandle | null = null;
  if (opts.mcpSendFile) {
    try {
      const { startMcpBridge } = await import('./mcp/bridge.js');
      const sessionDir = path.dirname(session.workspacePath);
      bridge = await startMcpBridge({
        sessionDir,
        workspacePath: session.workspacePath,
        workdir: opts.workdir,
        stagedFiles,
        sendFile: opts.mcpSendFile,
        agent: opts.agent,
        onLog: (message: string) => agentLog(`[mcp] ${message}`),
      });
      prepared.mcpConfigPath = bridge.configPath;
      if (bridge.extraEnv) prepared.extraEnv = { ...(prepared.extraEnv || {}), ...bridge.extraEnv };
      if (bridge.configPath) agentLog(`[mcp] bridge started on ${bridge.configPath}`);
      else agentLog('[mcp] bridge registered with codex');
      try { agentLog(`[mcp] config content:\n${fs.readFileSync(bridge.configPath, 'utf-8')}`); } catch {};
    } catch (e: any) {
      agentWarn(`[mcp] bridge start failed: ${e.message} — proceeding without MCP`);
    }
  }

  try {
    const driver = getDriver(prepared.agent);
    const result = await driver.doStream(prepared);
    return finalizeStreamResult(result, opts.workdir, opts.prompt, session);
  } catch (error: any) {
    const failedResult: StreamResult = {
      ok: false,
      message: normalizeErrorMessage(error) || 'Agent stream failed.',
      thinking: null,
      sessionId: session.sessionId,
      workspacePath: session.workspacePath,
      model: session.record.model,
      thinkingEffort: prepared.thinkingEffort,
      elapsedS: 0,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      contextWindow: null,
      contextUsedTokens: null,
      contextPercent: null,
      codexCumulative: null,
      error: normalizeErrorMessage(error) || 'Agent stream failed.',
      stopReason: null,
      incomplete: true,
      activity: null,
      plan: null,
    };
    session.record.lastQuestion = shortValue(opts.prompt, 500);
    session.record.lastAnswer = shortValue(failedResult.message, 500);
    session.record.lastMessageText = shortValue(failedResult.message, 500) || shortValue(opts.prompt, 500);
    session.record.lastThinking = null;
    session.record.lastPlan = null;
    applySessionRunResult(session.record, failedResult);
    saveSessionRecord(opts.workdir, session.record);
    throw error;
  } finally {
    if (bridge) {
      await bridge.stop().catch(() => {});
      if (bridge.hadActivity()) agentLog('[mcp] bridge stopped');
    }
  }
}

// ---------------------------------------------------------------------------
// Driver delegation
// ---------------------------------------------------------------------------

export function getSessions(opts: SessionListOpts): Promise<SessionListResult> {
  const workdir = path.resolve(opts.workdir);
  agentLog(`[sessions] request agent=${opts.agent} workdir=${workdir} limit=${opts.limit ?? 'all'}`);
  return getDriver(opts.agent).getSessions(workdir, opts.limit).then(result => {
    agentLog(`[sessions] result agent=${opts.agent} ok=${result.ok} count=${result.sessions.length} error=${result.error || '(none)'}`);
    return result;
  });
}

export function getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
  return getDriver(opts.agent).getSessionTail(opts);
}

export function getSessionMessages(opts: SessionMessagesOpts & { agent: Agent }): Promise<SessionMessagesResult> {
  return getDriver(opts.agent).getSessionMessages(opts);
}

export function listModels(agent: Agent, opts: ModelListOpts = {}): Promise<ModelListResult> {
  return getDriver(agent).listModels(opts);
}

export function getUsage(opts: UsageOpts): UsageResult {
  return getDriver(opts.agent).getUsage(opts);
}
