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
import { resolveAgentInjection, getActiveProfile, getProvider, getProviderModelList, updateProfile } from '../model/index.js';
import type {
  Agent, AgentDetectOptions, AgentInfo, AgentListResult,
  StreamOpts, StreamResult, CodexCumulativeUsage,
  ModelListOpts, ModelListResult, UsageOpts, UsageResult,
  SessionListOpts, SessionListResult, SessionTailOpts, SessionTailResult,
  SessionMessagesOpts, SessionMessagesResult,
  StreamPreviewMeta, StreamSubAgent,
} from './types.js';
import {
  Q, agentLog, agentWarn, agentError, joinErrorMessages, normalizeErrorMessage,
  buildStreamPreviewMeta, computeContext, shortValue, isPendingSessionId, dedupeStrings,
  normalizeStreamPreviewPlan,
} from './utils.js';
import {
  saveSessionRecord, setSessionRunState, applySessionRunResult,
  ensureSessionWorkspace, importFilesIntoWorkspace, syncManagedSessionIdentity,
  summarizePromptTitle, recordFork,
} from './session.js';
import { collapseSkillPrompt } from './skills.js';

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

export async function run(
  cmd: string[],
  opts: StreamOpts,
  parseLine: (ev: any, s: any) => void,
  parseStderrLine?: (line: string, s: any) => void,
): Promise<StreamResult> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;
  let stderr = '';
  let lineCount = 0;
  let timedOut = false;
  let interrupted = false;
  // BYOK: seed contextWindow from the provider-cached value so the live
  // preview percent uses the real denominator (e.g. 1M for DeepSeek v4 Pro
  // via OpenRouter) instead of whatever the CLI happens to report later.
  // Parsers gate their cc/codex-advertised updates on `s.byokContextWindow`.
  const byokWindow = opts.byokContextWindow && opts.byokContextWindow > 0
    ? opts.byokContextWindow
    : null;
  const byokProvider = opts.byokProviderName || null;
  const s = {
    sessionId: opts.sessionId, text: '', thinking: '', msgs: [] as string[], thinkParts: [] as string[],
    model: opts.model, thinkingEffort: opts.thinkingEffort, errors: null as unknown[] | null,
    inputTokens: null as number | null, outputTokens: null as number | null, cachedInputTokens: null as number | null,
    cacheCreationInputTokens: null as number | null,
    contextWindow: byokWindow as number | null,
    byokContextWindow: byokWindow as number | null,
    byokProviderName: byokProvider as string | null,
    contextUsedTokens: null as number | null,
    codexCumulative: null as CodexCumulativeUsage | null,
    stopReason: null as string | null, activity: '',
    recentActivity: [] as string[],
    claudeToolsById: new Map<string, { name: string; summary: string }>(),
    seenClaudeToolIds: new Set<string>(),
    geminiToolsById: new Map<string, { name: string; summary: string }>(),
    // Claude-only: sub-agent invocations from the Task tool. Other drivers leave it empty.
    subAgents: new Map<string, StreamSubAgent>(),
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
  let stderrLineBuf = '';
  proc.stderr?.on('data', (c: Buffer) => {
    const chunk = c.toString();
    stderr += chunk;
    agentLog(`[stderr] ${chunk.trim().slice(0, 200)}`);
    if (!parseStderrLine) return;
    stderrLineBuf += chunk;
    const lines = stderrLineBuf.split(/\r?\n/);
    stderrLineBuf = lines.pop() || '';
    let touched = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { parseStderrLine(trimmed, s); touched = true; } catch {}
    }
    if (touched) {
      try { opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), null); } catch {}
    }
  });

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
  // For display fields (title / lastQuestion / lastMessageText) prefer the
  // `/skillname` shorthand the user typed over the long expansion we
  // synthesized for the agent — the expanded form is what the CLI consumes,
  // but it shouldn't leak into session list previews or sidebar tabs.
  const displayPrompt = collapseSkillPrompt(opts.prompt) ?? opts.prompt;
  const session = ensureSessionWorkspace({ agent: opts.agent, workdir: opts.workdir, sessionId: opts.sessionId, title: displayPrompt });
  const importedFiles = importFilesIntoWorkspace(session.workspacePath, opts.attachments || []);
  const attachmentRelPaths = dedupeStrings([...session.record.stagedFiles, ...importedFiles]);
  // Capture staged files for MCP bridge before clearing
  const stagedFiles = [...session.record.stagedFiles];
  session.record.stagedFiles = [];
  if (!session.record.title) session.record.title = summarizePromptTitle(displayPrompt) || null;
  session.record.lastQuestion = shortValue(displayPrompt, 500);
  session.record.lastMessageText = shortValue(displayPrompt, 500);
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
  if (result.thinkingEffort) session.record.thinkingEffort = result.thinkingEffort;
  const displayPrompt = collapseSkillPrompt(prompt) ?? prompt;
  if (!session.record.title) session.record.title = summarizePromptTitle(displayPrompt);
  session.record.lastQuestion = shortValue(displayPrompt, 500);
  session.record.lastAnswer = shortValue(result.message, 500);
  session.record.lastMessageText = shortValue(result.message, 500) || shortValue(displayPrompt, 500);
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

  // Start MCP bridge for IM tools (when sendFile is available) and/or supplemental servers (browser, etc.)
  let bridge: import('./mcp/bridge.js').McpBridgeHandle | null = null;
  try {
    const { startMcpBridge } = await import('./mcp/bridge.js');
    const sessionDir = path.dirname(session.workspacePath);
    // Pikiclaw no longer injects an MCP `im_ask_user` tool. Each driver routes
    // its native ask-user signal directly through `opts.onInteraction`:
    //   - Codex:  JSON-RPC `item/tool/requestUserInput` → `toAgentInteraction`
    //   - Claude: native `AskUserQuestion` tool (CLI degrades to plain text in
    //             non-interactive mode, which then flows back as a normal next
    //             user message)
    //   - Gemini/Hermes: their CLIs disable native ask-user in non-interactive
    //             mode by design; the model picks a default and proceeds.
    bridge = await startMcpBridge({
      sessionDir,
      workspacePath: session.workspacePath,
      workdir: opts.workdir,
      stagedFiles,
      sendFile: opts.mcpSendFile,
      agent: opts.agent,
      onLog: (message: string) => agentLog(`[mcp] ${message}`),
    });
    if (bridge) {
      prepared.mcpConfigPath = bridge.configPath;
      if (bridge.mcpServers) prepared.mcpServers = bridge.mcpServers;
      if (bridge.extraEnv) prepared.extraEnv = { ...(prepared.extraEnv || {}), ...bridge.extraEnv };
      if (bridge.configPath) agentLog(`[mcp] bridge started on ${bridge.configPath}`);
      else if (bridge.mcpServers) agentLog(`[mcp] bridge registered with ${Object.keys(bridge.mcpServers).length} server(s)`);
      else agentLog('[mcp] bridge registered with codex');
      try { agentLog(`[mcp] config content:\n${fs.readFileSync(bridge.configPath, 'utf-8')}`); } catch {};
    }
  } catch (e: any) {
    agentWarn(`[mcp] bridge start failed: ${e.message} — proceeding without MCP`);
  }

  // Apply BYOK injection (Provider/Profile from the model layer): merges env
  // vars into prepared.extraEnv, overrides the per-agent model field, and
  // hands argvAppend to drivers that consume it (Hermes via opts.extraEnv → its own argv builder).
  try {
    const injection = await resolveAgentInjection(prepared.agent);
    if (injection) {
      prepared.extraEnv = { ...(prepared.extraEnv || {}), ...injection.env };
      if (injection.modelOverride) {
        if (prepared.agent === 'claude') prepared.claudeModel = injection.modelOverride;
        else if (prepared.agent === 'codex') prepared.codexModel = injection.modelOverride;
        else if (prepared.agent === 'gemini') prepared.geminiModel = injection.modelOverride;
        else if (prepared.agent === 'hermes') prepared.hermesModel = injection.modelOverride;
        prepared.model = injection.modelOverride;
      }
      if (injection.argvAppend?.length) {
        prepared.byokArgvAppend = injection.argvAppend;
      }
      if (injection.codexConfigOverrides?.length) {
        const flags = injection.codexConfigOverrides.flatMap(o => ['-c', o]);
        prepared.codexExtraArgs = [...(prepared.codexExtraArgs || []), ...flags];
      }
      if (injection.contextWindow && injection.contextWindow > 0) {
        prepared.byokContextWindow = injection.contextWindow;
      }
      if (injection.providerName) {
        prepared.byokProviderName = injection.providerName;
      }
      agentLog(`[byok] ${injection.detail}`);
    }
    // resolveAgentEffort (runtime-config) reads only the top-level hermesReasoningEffort
    // field and cannot see the effort stored inside models.profiles[].effort. Override
    // thinkingEffort here so the Profile's effort wins over the config default.
    const activeProfile = getActiveProfile(prepared.agent);
    if (activeProfile?.effort) {
      prepared.thinkingEffort = activeProfile.effort;
    }
  } catch (e: any) {
    agentWarn(`[byok] failed to apply Profile injection: ${e?.message || e}`);
  }

  try {
    const driver = getDriver(prepared.agent);
    if (opts.forkOf && !driver.capabilities?.fork) {
      throw new Error(`Agent ${prepared.agent} does not support fork`);
    }
    const result = await driver.doStream(prepared);
    const finalized = finalizeStreamResult(result, opts.workdir, opts.prompt, session);
    // Once the child has its real session ID, link the lineage. We do this
    // after finalize so the child record is persisted with its native ID.
    if (opts.forkOf && finalized.sessionId) {
      try {
        recordFork(opts.workdir, {
          parent: { agent: opts.agent, sessionId: opts.forkOf.parentSessionId },
          child: { agent: opts.agent, sessionId: finalized.sessionId },
          atTurn: opts.forkOf.atTurn,
        });
      } catch (e: any) {
        agentWarn(`[fork] recordFork failed: ${e?.message || e}`);
      }
    }
    return finalized;
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
    const failureDisplayPrompt = collapseSkillPrompt(opts.prompt) ?? opts.prompt;
    session.record.lastQuestion = shortValue(failureDisplayPrompt, 500);
    session.record.lastAnswer = shortValue(failedResult.message, 500);
    session.record.lastMessageText = shortValue(failedResult.message, 500) || shortValue(failureDisplayPrompt, 500);
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

/**
 * Resolve the model list a UI surface should show for `agent`.
 *
 * If the agent has an active BYOK Profile, the bound provider's `/models`
 * response wins — every model the user can pick is one the provider exposes.
 * Otherwise we fall back to the agent driver's native list.
 *
 * Used by the dashboard agent-status response and the IM `/models` command so
 * both surfaces stay consistent with the configured provider binding.
 */
export async function resolveAgentModels(agent: Agent, opts: ModelListOpts = {}): Promise<ModelListResult> {
  const profile = getActiveProfile(agent);
  if (!profile) return getDriver(agent).listModels(opts);

  const provider = getProvider(profile.providerId);
  if (!provider) return getDriver(agent).listModels(opts);

  try {
    const result = await getProviderModelList(provider.id);
    if (result && result.models.length > 0) {
      return {
        agent,
        models: result.models.map(id => ({ id, alias: null })),
        sources: [`${provider.name} · ${provider.baseURL}`],
        note: `Provider-bound models. ${result.fromCache ? 'Cached' : 'Live'}.`,
      };
    }
  } catch {
    /* fall through to driver */
  }

  // Provider unreachable or returned 0 models — let the user still pick the
  // currently-bound id by surfacing it as a single-entry list.
  return {
    agent,
    models: profile.modelId ? [{ id: profile.modelId, alias: null }] : [],
    sources: [`${provider.name} · unreachable`],
    note: 'Could not enumerate provider models. Showing bound model only.',
  };
}

export function getUsage(opts: UsageOpts): UsageResult {
  return getDriver(opts.agent).getUsage(opts);
}

/**
 * If the user has a BYOK Profile bound to `agent`, return its raw modelId
 * (e.g. "deepseek/deepseek-v4-flash"). Returns null when no profile is bound.
 * Used by display paths that need to show the profile's model rather than the
 * pikiclaw user-config model (which may be stale or unrelated to the active profile).
 */
export function getAgentBoundModelId(agent: Agent): string | null {
  const profile = getActiveProfile(agent);
  return profile?.modelId ?? null;
}

/**
 * Persist a model id to the active BYOK Profile for `agent`. Returns true when
 * the Profile was updated (caller should skip writing the legacy
 * `<agent>Model` user-config field), false when no Profile is bound.
 *
 * Hermes uses this as the *primary* persistence path because `hermes acp` does
 * not support runtime model switching via CLI flags — the only way to change
 * the model is the Profile (which the driver passes to ACP `session/set_model`).
 */
export function setAgentBoundModelId(agent: Agent, modelId: string): boolean {
  const profile = getActiveProfile(agent);
  if (!profile) return false;
  const trimmed = modelId.trim();
  if (!trimmed || trimmed === profile.modelId) return true;
  updateProfile(profile.id, { modelId: trimmed });
  return true;
}
