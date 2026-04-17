/**
 * Claude Code CLI driver: stream parsing, session reads, model listing, usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { registerDriver, type AgentDriver } from '../driver.js';
import {
  type StreamOpts, type StreamResult, type StreamPreviewPlan,
  type SessionListResult, type SessionTailOpts, type SessionTailResult,
  type SessionMessagesOpts, type SessionMessagesResult,
  type TailMessage, type RichMessage, type MessageBlock,
  type ModelListOpts, type ModelListResult, type ModelInfo,
  type UsageOpts, type UsageResult, type UsageWindowInfo,
  type SessionInfo,
  // shared helpers
  Q, run, agentError, agentLog, agentWarn,
  appendSystemPrompt, buildStreamPreviewMeta, pushRecentActivity,
  summarizeClaudeToolUse, summarizeClaudeToolResult, joinErrorMessages, parseTodoWriteAsPlan,
  IMAGE_EXTS, mimeForExt,
  listPikiclawSessions, findPikiclawSession, isPendingSessionId,
  mergeManagedAndNativeSessions,
  readTailLines, stripInjectedPrompts, sanitizeSessionUserPreviewText, SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE, applyTurnWindow, shortValue,
  roundPercent, toIsoFromEpochSeconds, modelFamily, normalizeClaudeModelId, emptyUsage, normalizeUsageStatus,
} from '../index.js';
import { AGENT_STREAM_HARD_KILL_GRACE_MS, SESSION_RUNNING_THRESHOLD_MS } from '../../core/constants.js';
import { terminateProcessTree } from '../../core/process-control.js';

// ---------------------------------------------------------------------------
// Multimodal stdin
// ---------------------------------------------------------------------------

function buildClaudeUserMessage(prompt: string, attachments: string[]): string {
  const content: any[] = [];
  for (const filePath of attachments) {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      try {
        const data = fs.readFileSync(filePath);
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mimeForExt(ext), data: data.toString('base64') },
        });
      } catch (e: any) {
        agentWarn(`[attach] failed to read image ${filePath}: ${e.message}`);
      }
    } else {
      content.push({ type: 'text', text: `[Attached file: ${filePath}]` });
    }
  }
  content.push({ type: 'text', text: prompt });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

function claudeUsesStreamJsonInput(o: StreamOpts): boolean {
  return !!o.attachments?.length || !!o.onSteerReady;
}

const CLAUDE_STEER_IDLE_CLOSE_MS = 1200;

// ---------------------------------------------------------------------------
// Command & parser
// ---------------------------------------------------------------------------

function claudeCmd(o: StreamOpts): string[] {
  const args = ['claude', '-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
  const model = normalizeClaudeModelId(o.claudeModel);
  if (model) args.push('--model', model);
  if (o.claudePermissionMode) args.push('--permission-mode', o.claudePermissionMode);
  if (o.sessionId) args.push('--resume', o.sessionId);
  if (claudeUsesStreamJsonInput(o)) {
    args.push('--input-format', 'stream-json');
    if (o.onSteerReady) args.push('--replay-user-messages');
    if (o.attachments?.length) o._stdinOverride = buildClaudeUserMessage(o.prompt, o.attachments);
  }
  if (o.thinkingEffort) args.push('--effort', o.thinkingEffort);
  if (o.claudeAppendSystemPrompt) args.push('--append-system-prompt', o.claudeAppendSystemPrompt);
  if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath);
  if (o.claudeExtraArgs?.length) args.push(...o.claudeExtraArgs);
  return args;
}

function claudeContextWindowFromModel(model: unknown): number | null {
  const id = normalizeClaudeModelId(model).toLowerCase();
  if (!id) return null;
  if (id === 'haiku' || /^claude-haiku-/.test(id)) return 200_000;
  if (id === 'opus' || id === 'sonnet') return 1_000_000;
  if (/^claude-(opus|sonnet)-/.test(id)) return 1_000_000;
  return null;
}

function claudeParse(ev: any, s: any) {
  const t = ev.type || '';
  if (t === 'system') {
    s.sessionId = ev.session_id ?? s.sessionId;
    s.model = ev.model ?? s.model;
    s.thinkingEffort = ev.thinking_level ?? s.thinkingEffort;
    s.contextWindow = claudeContextWindowFromModel(s.model) ?? s.contextWindow;
  }

  if (t === 'stream_event') {
    const inner = ev.event || {};
    if (inner.type === 'message_start') {
      const u = inner.message?.usage;
      s.inputTokens = u?.input_tokens ?? null;
      s.cachedInputTokens = u?.cache_read_input_tokens ?? null;
      s.cacheCreationInputTokens = u?.cache_creation_input_tokens ?? null;
      s.outputTokens = null;
      // Snapshot per-call input total so result-event cumulative values don't
      // inflate the context-window percentage.
      const callCtx = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
      if (callCtx > 0) s.contextUsedTokens = callCtx;
    }
    if (inner.type === 'content_block_delta') {
      const d = inner.delta || {};
      if (d.type === 'thinking_delta') s.thinking += d.thinking || '';
      else if (d.type === 'text_delta') s.text += d.text || '';
    }
    if (inner.type === 'message_delta') {
      const d = inner.delta || {};
      s.stopReason = d.stop_reason ?? s.stopReason;
      const u = inner.usage;
      if (u) {
        if (u.input_tokens != null) s.inputTokens = u.input_tokens;
        if (u.cache_read_input_tokens != null) s.cachedInputTokens = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) s.cacheCreationInputTokens = u.cache_creation_input_tokens;
        if (u.output_tokens != null) s.outputTokens = u.output_tokens;
      }
    }
    s.sessionId = ev.session_id ?? s.sessionId;
    s.model = ev.model ?? s.model;
    s.contextWindow = claudeContextWindowFromModel(s.model) ?? s.contextWindow;
  }

  if (t === 'assistant') {
    const msg = ev.message || {};
    const contents = msg.content || [];
    const th = contents.filter((b: any) => b?.type === 'thinking').map((b: any) => b.thinking || '').join('');
    const tx = contents.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('');
    const toolUses = contents.filter((b: any) => b?.type === 'tool_use');
    if (th && !s.thinking.trim()) s.thinking = th;
    if (tx && !s.text.trim()) s.text = tx;
    for (const block of toolUses) {
      const toolId = String(block?.id || '').trim();
      if (!toolId || s.seenClaudeToolIds.has(toolId)) continue;
      const toolName = String(block?.name || 'Tool').trim() || 'Tool';
      // TodoWrite → update plan instead of adding activity noise
      if (toolName === 'TodoWrite') {
        const plan = parseTodoWriteAsPlan(block?.input);
        if (plan) s.plan = plan;
        s.seenClaudeToolIds.add(toolId);
        s.claudeToolsById.set(toolId, { name: toolName, summary: 'Update plan' });
        continue;
      }
      const tool = {
        name: toolName,
        summary: summarizeClaudeToolUse(block?.name, block?.input || {}),
      };
      s.seenClaudeToolIds.add(toolId);
      s.claudeToolsById.set(toolId, tool);
      pushRecentActivity(s.recentActivity, tool.summary);
    }
    s.activity = s.recentActivity.join('\n');
    s.stopReason = msg.stop_reason ?? s.stopReason;
  }

  if (t === 'user') {
    const msg = ev.message || {};
    const contents = Array.isArray(msg.content) ? msg.content : [];
    const toolResults = contents.filter((b: any) => b?.type === 'tool_result');
    for (const block of toolResults) {
      const toolId = String(block?.tool_use_id || '').trim();
      const tool = toolId ? s.claudeToolsById.get(toolId) : undefined;
      // Skip TodoWrite results from activity — plan card handles it
      if (tool?.name === 'TodoWrite') continue;
      pushRecentActivity(s.recentActivity, summarizeClaudeToolResult(tool, block, ev.tool_use_result));
    }
    s.activity = s.recentActivity.join('\n');
  }

  if (t === 'result') {
    s.sessionId = ev.session_id ?? s.sessionId; s.model = ev.model ?? s.model;
    if (ev.is_error && ev.errors?.length) s.errors = ev.errors;
    if (ev.result && !s.text.trim()) s.text = ev.result;
    s.stopReason = ev.stop_reason ?? s.stopReason;
    const u = ev.usage;
    if (u) {
      s.inputTokens = u.input_tokens ?? s.inputTokens;
      s.cachedInputTokens = (u.cache_read_input_tokens ?? u.cached_input_tokens) ?? s.cachedInputTokens;
      s.cacheCreationInputTokens = u.cache_creation_input_tokens ?? s.cacheCreationInputTokens;
      s.outputTokens = u.output_tokens ?? s.outputTokens;
    }
    const mu = ev.modelUsage;
    if (mu && typeof mu === 'object') {
      for (const info of Object.values(mu) as any[]) {
        if (info?.contextWindow > 0) { s.contextWindow = info.contextWindow; break; }
      }
    }
  }
}

function createClaudeStreamState(opts: StreamOpts) {
  return {
    sessionId: opts.sessionId,
    text: '',
    thinking: '',
    msgs: [] as string[],
    thinkParts: [] as string[],
    model: opts.model,
    thinkingEffort: opts.thinkingEffort,
    errors: null as unknown[] | null,
    inputTokens: null as number | null,
    outputTokens: null as number | null,
    cachedInputTokens: null as number | null,
    cacheCreationInputTokens: null as number | null,
    contextWindow: null as number | null,
    contextUsedTokens: null as number | null,
    codexCumulative: null,
    stopReason: null as string | null,
    activity: '',
    recentActivity: [] as string[],
    plan: null as StreamPreviewPlan | null,
    claudeToolsById: new Map<string, { name: string; summary: string }>(),
    seenClaudeToolIds: new Set<string>(),
  };
}

function resetClaudeTurnState(s: ReturnType<typeof createClaudeStreamState>, note?: string) {
  s.text = '';
  s.thinking = '';
  s.msgs = [];
  s.thinkParts = [];
  s.errors = null;
  s.inputTokens = null;
  s.outputTokens = null;
  s.cachedInputTokens = null;
  s.cacheCreationInputTokens = null;
  s.contextUsedTokens = null;
  s.stopReason = null;
  s.activity = '';
  s.recentActivity = [];
  s.claudeToolsById = new Map();
  s.seenClaudeToolIds = new Set();
  if (note) {
    pushRecentActivity(s.recentActivity, note);
    s.activity = s.recentActivity.join('\n');
  }
}

async function doClaudeInteractiveStream(opts: StreamOpts): Promise<StreamResult> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;
  let stderr = '';
  let lineCount = 0;
  let timedOut = false;
  let interrupted = false;
  let stdinClosed = false;
  let steerQueued = false;
  let awaitingSteeredResponseStart = false;
  let idleCloseTimer: NodeJS.Timeout | null = null;
  const s = createClaudeStreamState(opts);

  const cmd = claudeCmd(opts);
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

  const closeInput = () => {
    if (idleCloseTimer) {
      clearTimeout(idleCloseTimer);
      idleCloseTimer = null;
    }
    if (stdinClosed) return;
    stdinClosed = true;
    try { proc.stdin?.end(); } catch {}
  };

  const emit = () => {
    opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), s.plan);
  };

  const abortStream = () => {
    if (interrupted || proc.killed) return;
    interrupted = true;
    s.stopReason = 'interrupted';
    closeInput();
    agentWarn(`[abort] user interrupt, killing process tree pid=${proc.pid}`);
    terminateProcessTree(proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 5000 });
  };
  if (opts.abortSignal?.aborted) abortStream();
  opts.abortSignal?.addEventListener('abort', abortStream, { once: true });

  const scheduleIdleClose = () => {
    if (idleCloseTimer) clearTimeout(idleCloseTimer);
    idleCloseTimer = setTimeout(() => {
      idleCloseTimer = null;
      if (stdinClosed || interrupted || timedOut || proc.killed || proc.exitCode != null) return;
      agentLog(`[stdin] closing Claude input after ${CLAUDE_STEER_IDLE_CLOSE_MS}ms idle result window`);
      closeInput();
    }, CLAUDE_STEER_IDLE_CLOSE_MS);
  };

  const startsClaudeFollowup = (ev: any): boolean => {
    const evType = ev?.type || '';
    if (evType === 'assistant') return true;
    if (evType !== 'stream_event') return false;
    const innerType = ev?.event?.type || '';
    return innerType === 'message_start' || innerType === 'content_block_delta';
  };

  const sendInput = (
    prompt: string,
    attachments: string[] = [],
    note?: string,
    kind: 'initial' | 'steer' = 'steer',
  ): boolean => {
    if (stdinClosed || interrupted || timedOut || proc.killed || proc.exitCode != null) return false;
    try {
      proc.stdin?.write(buildClaudeUserMessage(prompt, attachments));
      if (kind === 'steer') {
        steerQueued = true;
        if (idleCloseTimer) {
          clearTimeout(idleCloseTimer);
          idleCloseTimer = null;
        }
      }
      if (note) {
        pushRecentActivity(s.recentActivity, note);
        s.activity = s.recentActivity.join('\n');
        emit();
      }
      return true;
    } catch (error: any) {
      agentWarn(`[stdin] failed to write Claude input: ${error?.message || error}`);
      return false;
    }
  };

  if (!sendInput(opts.prompt, opts.attachments || [], undefined, 'initial')) {
    closeInput();
  }
  try {
    opts.onSteerReady?.(async (prompt: string, attachments: string[] = []) => {
      if (!sendInput(prompt, attachments, 'Queued steer input', 'steer')) return false;
      return true;
    });
  } catch (error: any) {
    agentWarn(`[stdin] onSteerReady error: ${error?.message || error}`);
  }

  proc.stderr?.on('data', (c: Buffer) => {
    const chunk = c.toString();
    stderr += chunk;
    agentLog(`[stderr] ${chunk.trim().slice(0, 200)}`);
  });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on('line', raw => {
    if (Date.now() > deadline) {
      timedOut = true;
      s.stopReason = 'timeout';
      closeInput();
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
      if (evType !== 'result' && idleCloseTimer) {
        clearTimeout(idleCloseTimer);
        idleCloseTimer = null;
      }
      if (awaitingSteeredResponseStart && startsClaudeFollowup(ev)) {
        awaitingSteeredResponseStart = false;
        steerQueued = false;
        resetClaudeTurnState(s);
      }
      if (evType === 'system' || evType === 'result' || evType === 'assistant') {
        agentLog(`[event] type=${evType} session=${ev.session_id || s.sessionId || '?'} model=${ev.model || s.model || '?'}`);
      }
      if (evType === 'stream_event') {
        const inner = ev.event || {};
        if (inner.type === 'message_start' || inner.type === 'message_delta') {
          agentLog(`[event] stream_event/${inner.type} session=${ev.session_id || s.sessionId || '?'}`);
        }
      }
      claudeParse(ev, s);
      if (evType === 'result') {
        const hasError = !!ev.is_error || (Array.isArray(ev.errors) && ev.errors.length > 0);
        if (hasError) {
          awaitingSteeredResponseStart = false;
          steerQueued = false;
          closeInput();
        } else if (steerQueued) {
          awaitingSteeredResponseStart = true;
          scheduleIdleClose();
        } else {
          closeInput();
        }
      }
      emit();
    } catch {}
  });

  const hardTimer = setTimeout(() => {
    timedOut = true;
    s.stopReason = 'timeout';
    closeInput();
    agentWarn(`[timeout] hard deadline reached (${opts.timeout}s), killing process tree pid=${proc.pid}`);
    terminateProcessTree(proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 5000 });
  }, opts.timeout * 1000 + AGENT_STREAM_HARD_KILL_GRACE_MS);

  const [procOk, code] = await new Promise<[boolean, number | null]>(resolve => {
    proc.on('close', code => {
      clearTimeout(hardTimer);
      if (idleCloseTimer) {
        clearTimeout(idleCloseTimer);
        idleCloseTimer = null;
      }
      agentLog(`[exit] code=${code} lines_parsed=${lineCount}`);
      resolve([code === 0, code]);
    });
    proc.on('error', e => {
      clearTimeout(hardTimer);
      if (idleCloseTimer) {
        clearTimeout(idleCloseTimer);
        idleCloseTimer = null;
      }
      agentError(`[error] ${e.message}`);
      stderr += e.message;
      resolve([false, -1]);
    });
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
    ok,
    sessionId: s.sessionId,
    workspacePath: null,
    model: s.model,
    thinkingEffort: s.thinkingEffort,
    message: s.text.trim() || errorText || (procOk ? '(no textual response)' : `Failed (exit=${code}).\n\n${stderr.trim() || '(no output)'}`),
    thinking: s.thinking.trim() || null,
    elapsedS: (Date.now() - start) / 1000,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cachedInputTokens: s.cachedInputTokens,
    cacheCreationInputTokens: s.cacheCreationInputTokens,
    contextWindow: s.contextWindow,
    contextUsedTokens: s.contextUsedTokens,
    contextPercent: roundPercent((s.contextUsedTokens || 0) / (s.contextWindow || 0)),
    codexCumulative: null,
    error,
    plan: s.plan,
    stopReason: s.stopReason,
    incomplete,
    activity: s.activity.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

export async function doClaudeStream(opts: StreamOpts): Promise<StreamResult> {
  const result = opts.onSteerReady
    ? await doClaudeInteractiveStream(opts)
    : await run(claudeCmd(opts), opts, claudeParse);
  const retryText = `${result.error || ''}\n${result.message}`;
  if (!result.ok && opts.sessionId && /no conversation found/i.test(retryText)) {
    return doClaudeStream({ ...opts, sessionId: null });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function claudeProjectDirName(workdir: string): string {
  return workdir.replace(/\//g, '-');
}

/** Read native Claude Code sessions from ~/.claude/projects/{dirName}/*.jsonl */
function extractClaudeTailQA(filePath: string): { lastQuestion: string | null; lastAnswer: string | null; lastMessageText: string | null } {
  // Use a larger tail (1 MB) so we can reach past tool-result / assistant
  // exchanges that follow the last real user question (which may be multi-MB
  // due to embedded images).
  const lines = readTailLines(filePath, 1024 * 1024);
  let lastQuestion: string | null = null;
  let lastAnswer: string | null = null;
  let lastMessageText: string | null = null;
  for (const raw of lines) {
    if (!raw || raw[0] !== '{') continue;
    try {
      const ev = JSON.parse(raw);
      if (ev.type === 'user') {
        const text = sanitizeSessionUserPreviewText(extractClaudeText(ev.message?.content, true));
        if (text) {
          lastQuestion = shortValue(text, 500);
          lastMessageText = shortValue(text, 500);
        }
      } else if (ev.type === 'assistant') {
        const text = extractClaudeText(ev.message?.content).trim();
        if (text) {
          lastAnswer = shortValue(text, 500);
          lastMessageText = shortValue(text, 500);
        }
      }
    } catch { /* skip */ }
  }
  return { lastQuestion, lastAnswer, lastMessageText };
}

function getNativeClaudeSessions(workdir: string): SessionInfo[] {
  const home = process.env.HOME || '';
  if (!home) return [];
  const projectDir = path.join(home, '.claude', 'projects', claudeProjectDirName(workdir));
  if (!fs.existsSync(projectDir)) return [];

  const sessions: SessionInfo[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { return []; }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -6); // strip .jsonl
    const filePath = path.join(projectDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      // Read enough bytes to get past the system_prompt line (can be 20KB+) and
      // reach the first user/assistant events for title and model extraction.
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const head = buf.toString('utf8', 0, bytesRead);
      const lines = head.split('\n');

      let title: string | null = null;
      let model: string | null = null;
      for (const line of lines) {
        if (!line || line[0] !== '{') continue;
        try {
          const ev = JSON.parse(line);
          if (!title && ev.type === 'user') {
            const text = sanitizeSessionUserPreviewText(extractClaudeText(ev.message?.content, true));
            if (text) title = text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}...`;
          }
          if (!model && ev.type === 'assistant' && ev.message?.model) {
            model = ev.message.model;
          }
          if (title && model) break;
        } catch { /* skip */ }
      }
      // Fallback: if the first user message line is too large (e.g. contains
      // base64 images) JSON.parse above will fail.  Read a bigger chunk and
      // regex-extract text blocks to find the actual user question.
      if (!title) {
        let scanStr = head;
        if (stat.size > 65536) {
          try {
            const fd2 = fs.openSync(filePath, 'r');
            const bigBuf = Buffer.alloc(Math.min(10 * 1024 * 1024, stat.size));
            const bigRead = fs.readSync(fd2, bigBuf, 0, bigBuf.length, 0);
            fs.closeSync(fd2);
            scanStr = bigBuf.toString('utf8', 0, bigRead);
          } catch { /* keep using head */ }
        }
        const re = /"type":"text","text":"((?:[^"\\]|\\.)*)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(scanStr)) !== null) {
          let raw = m[1]
            .replace(/\\n/g, ' ').replace(/\\t/g, ' ')
            .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
            .replace(/\s+/g, ' ').trim();
          if (!raw || raw.startsWith('<') || raw.startsWith('[Image:')) continue;
          raw = stripInjectedPrompts(raw);
          if (!raw) continue;
          title = raw.length <= 120 ? raw : `${raw.slice(0, 117).trimEnd()}...`;
          break;
        }
      }

      // Quick turn count: count real user messages (exclude tool_result)
      let numTurns = 0;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const rawLines = raw.split('\n');
        for (const rl of rawLines) {
          if (rl.length > 2 && rl.includes('"type":"user"') && !rl.includes('"tool_result"')) numTurns++;
        }
      } catch { /* ignore count errors */ }

      const tailQA = extractClaudeTailQA(filePath);
      sessions.push({
        sessionId,
        agent: 'claude',
        workdir,
        workspacePath: null,
        model,
        createdAt: stat.birthtime.toISOString(),
        title,
        running: Date.now() - stat.mtimeMs < SESSION_RUNNING_THRESHOLD_MS,
        runState: Date.now() - stat.mtimeMs < SESSION_RUNNING_THRESHOLD_MS ? 'running' : 'completed',
        runDetail: null,
        runUpdatedAt: stat.mtime.toISOString(),
        classification: null,
        userStatus: null,
        userNote: null,
        lastQuestion: tailQA.lastQuestion,
        lastAnswer: tailQA.lastAnswer,
        lastMessageText: tailQA.lastMessageText,
        migratedFrom: null,
        migratedTo: null,
        linkedSessions: [],
        numTurns: numTurns || null,
      });
    } catch { /* skip unreadable files */ }
  }
  return sessions;
}

function getClaudeSessions(workdir: string, limit?: number): SessionListResult {
  const resolvedWorkdir = path.resolve(workdir);
  // Merge pikiclaw-tracked sessions with native Claude sessions
  const pikiclawSessions = listPikiclawSessions(resolvedWorkdir, 'claude').map(record => ({
    sessionId: record.sessionId,
    agent: 'claude' as const,
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
  const nativeSessions = getNativeClaudeSessions(resolvedWorkdir);
  const merged = mergeManagedAndNativeSessions(pikiclawSessions, nativeSessions);
  const sessions = typeof limit === 'number' ? merged.slice(0, limit) : merged;
  const projectDir = path.join(process.env.HOME || '', '.claude', 'projects', claudeProjectDirName(resolvedWorkdir));
  agentLog(
    `[sessions:claude] workdir=${resolvedWorkdir} projectDir=${projectDir} projectDirExists=${fs.existsSync(projectDir)} ` +
    `pikiclaw=${pikiclawSessions.length} native=${nativeSessions.length} merged=${sessions.length}`
  );
  return { ok: true, sessions, error: null };
}

// ---------------------------------------------------------------------------
// Session tail
// ---------------------------------------------------------------------------

function extractClaudeText(content: any, skipSystemBlocks = false): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      if (skipSystemBlocks && block.text.startsWith('<')) continue;
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function getClaudeSessionTail(opts: SessionTailOpts): SessionTailResult {
  const limit = opts.limit ?? 4;
  const home = process.env.HOME || '';
  const projectDir = path.join(home, '.claude', 'projects', claudeProjectDirName(opts.workdir));
  const filePath = path.join(projectDir, `${opts.sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return { ok: false, messages: [], error: 'Session file not found' };
  }

  try {
    const lines = readTailLines(filePath);
    const allMsgs: { role: 'user' | 'assistant'; text: string }[] = [];
    for (const raw of lines) {
      if (!raw || raw[0] !== '{') continue;
      try {
        const ev = JSON.parse(raw);
        if (ev.type === 'user') {
          const text = stripInjectedPrompts(extractClaudeText(ev.message?.content, true));
          if (text) allMsgs.push({ role: 'user', text });
        } else if (ev.type === 'assistant') {
          const text = extractClaudeText(ev.message?.content, true);
          if (text) allMsgs.push({ role: 'assistant', text });
        }
      } catch { /* skip */ }
    }
    return { ok: true, messages: allMsgs.slice(-limit), error: null };
  } catch (e: any) {
    return { ok: false, messages: [], error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Session messages (full content)
// ---------------------------------------------------------------------------

/** Extract structured content blocks from Claude message content.
 *  When `todoWriteToolIds` is provided, TodoWrite tool_use blocks are emitted
 *  as `plan` blocks and their IDs are tracked so tool_results can be skipped. */
function extractClaudeBlocks(content: any, skipSystemBlocks = false, todoWriteToolIds?: Set<string>): MessageBlock[] {
  if (typeof content === 'string') return [{ type: 'text', content }];
  if (!Array.isArray(content)) return [];
  const blocks: MessageBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (skipSystemBlocks && block.text.startsWith('<')) continue;
      blocks.push({ type: 'text', content: block.text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      blocks.push({ type: 'thinking', content: block.thinking });
    } else if (block.type === 'tool_use') {
      // TodoWrite → emit as plan block instead of generic tool_use
      if (block.name === 'TodoWrite' && todoWriteToolIds) {
        const plan = parseTodoWriteAsPlan(block.input);
        if (plan) {
          todoWriteToolIds.add(block.id);
          blocks.push({ type: 'plan', content: '', plan, toolId: block.id });
          continue;
        }
      }
      const inputStr = block.input ? JSON.stringify(block.input, null, 2) : '';
      blocks.push({ type: 'tool_use', content: inputStr, toolName: block.name || 'unknown', toolId: block.id });
    } else if (block.type === 'tool_result') {
      const resultText = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
          : '';
      blocks.push({ type: 'tool_result', content: resultText, toolId: block.tool_use_id });
    } else if (block.type === 'image' && block.source?.type === 'base64' && block.source.data) {
      const mediaType = block.source.media_type || 'image/png';
      // Skip excessively large images (> 12MB base64 ≈ 9MB binary) to keep API payloads sane
      if (block.source.data.length <= 12 * 1024 * 1024) {
        blocks.push({ type: 'image', content: `data:${mediaType};base64,${block.source.data}` });
      }
    }
  }
  return blocks;
}

/** Detect system-injected user events (context compression summaries, interruption markers)
 *  that should not split the assistant turn when parsing session JSONL. */
function isSystemInjectedUserEvent(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  // Interruption markers injected by Claude Code
  if (/^\[Request interrupted by user(?: for tool use)?\]$/i.test(trimmed)) return true;
  // Context compression summaries are typically very long
  if (trimmed.length > 800) return true;
  // Known continuation markers
  const lower = trimmed.toLowerCase();
  const markers = ['continued from a previous', 'summary below covers', 'earlier portion of the conversation', 'here is a summary of', 'conversation summary'];
  return markers.some(m => lower.includes(m));
}

function getClaudeSessionMessages(opts: SessionMessagesOpts): SessionMessagesResult {
  const home = process.env.HOME || '';
  const projectDir = path.join(home, '.claude', 'projects', claudeProjectDirName(opts.workdir));
  const filePath = path.join(projectDir, `${opts.sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return { ok: false, messages: [], totalTurns: 0, error: 'Session file not found' };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    // Parse raw events, merging consecutive same-role events into one message.
    // Claude JSONL writes one event per content block (thinking, text, tool_use, tool_result).
    // Consecutive assistant events form a single assistant message.
    // User events with tool_result are system-injected and should be hidden;
    // only user events with actual user text start a new user message.
    const allMsgs: TailMessage[] = [];
    const richMsgs: RichMessage[] = [];

    let pendingRole: 'user' | 'assistant' | null = null;
    let pendingTextParts: string[] = [];
    let pendingBlocks: MessageBlock[] = [];
    const todoWriteToolIds = new Set<string>();

    const flush = () => {
      if (!pendingRole) return;
      const text = pendingTextParts.join('\n');
      if (text || pendingBlocks.length) {
        allMsgs.push({ role: pendingRole, text });
        richMsgs.push({ role: pendingRole, text, blocks: [...pendingBlocks] });
      }
      pendingRole = null;
      pendingTextParts = [];
      pendingBlocks = [];
    };

    for (const raw of lines) {
      if (!raw || raw[0] !== '{') continue;
      try {
        const ev = JSON.parse(raw);
        if (ev.type === 'user') {
          // Check if this is a tool_result (system-injected) or actual user message
          const contentArr = ev.message?.content;
          const isToolResult = Array.isArray(contentArr)
            && contentArr.length > 0
            && contentArr.every((b: any) => b?.type === 'tool_result');

          if (isToolResult) {
            // Tool results belong to the preceding assistant turn — append as blocks
            if (pendingRole === 'assistant') {
              for (const block of contentArr) {
                // Skip TodoWrite results — plan card handles it
                if (todoWriteToolIds.has(block.tool_use_id)) continue;
                const resultText = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
                    : '';
                if (resultText) {
                  pendingBlocks.push({ type: 'tool_result', content: resultText, toolId: block.tool_use_id });
                }
              }
            }
            continue;
          }

          // Context compression summaries and interruption markers should not
          // split the current assistant turn — skip them so the response stays merged.
          if (pendingRole === 'assistant') {
            const probe = extractClaudeText(ev.message?.content, true);
            if (isSystemInjectedUserEvent(probe)) continue;
          }

          // Actual user message — flush previous and start new
          flush();
          const rawText = stripInjectedPrompts(extractClaudeText(ev.message?.content, true));
          const userBlocks = extractClaudeBlocks(ev.message?.content, true);
          // Include image blocks from the user message
          const imageBlocks = userBlocks.filter(b => b.type === 'image');
          // Strip [Image:...] placeholders from display text — the actual images are in imageBlocks
          const text = rawText.replace(SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE, '').replace(/\s+/g, ' ').trim();
          if (text || imageBlocks.length) {
            pendingRole = 'user';
            pendingTextParts = text ? [text] : [];
            pendingBlocks = text ? [{ type: 'text', content: text }, ...imageBlocks] : [...imageBlocks];
          }
        } else if (ev.type === 'assistant') {
          // If we were accumulating a user message, flush it
          if (pendingRole === 'user') flush();
          // Start or continue accumulating assistant blocks
          pendingRole = 'assistant';
          const text = extractClaudeText(ev.message?.content, true);
          if (text) pendingTextParts.push(text);
          const blocks = extractClaudeBlocks(ev.message?.content, true, todoWriteToolIds);
          pendingBlocks.push(...blocks);
        }
      } catch { /* skip malformed lines */ }
    }
    flush();

    return applyTurnWindow(allMsgs, opts, opts.rich ? richMsgs : undefined);
  } catch (e: any) {
    return { ok: false, messages: [], totalTurns: 0, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-7', alias: 'opus' },
  { id: 'claude-sonnet-4-6', alias: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', alias: 'haiku' },
];

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function getClaudeOAuthToken(): string | null {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
      encoding: 'utf-8', timeout: 3000,
    }).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

function getClaudeUsageFromOAuth(): UsageResult | null {
  const token = getClaudeOAuthToken();
  if (!token) return null;

  try {
    const raw = execSync(
      `curl -s --max-time 5 -H "Authorization: Bearer ${token}" -H "anthropic-beta: oauth-2025-04-20" -H "Content-Type: application/json" "https://api.anthropic.com/api/oauth/usage"`,
      { encoding: 'utf-8', timeout: 8000 },
    ).trim();
    if (!raw || raw[0] !== '{') return null;

    const data = JSON.parse(raw);
    const capturedAt = new Date().toISOString();
    const apiError = data?.error;
    if (apiError && typeof apiError === 'object') {
      // The usage query endpoint itself returned an error (e.g. 429 rate
      // limit on the query API).  This does NOT reflect the user's actual
      // Claude usage status, so fall through to telemetry instead of
      // reporting a misleading "limit_reached".
      return null;
    }

    const makeWindow = (label: string, entry: any): UsageWindowInfo | null => {
      if (!entry || typeof entry !== 'object') return null;
      const usedPercent = roundPercent(entry.utilization);
      if (usedPercent == null) return null;
      const remainingPercent = Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
      const resetAt = typeof entry.resets_at === 'string' ? entry.resets_at : null;
      let resetAfterSeconds: number | null = null;
      if (resetAt) {
        const resetAtMs = Date.parse(resetAt);
        if (Number.isFinite(resetAtMs)) resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
      }
      return {
        label, usedPercent, remainingPercent, resetAt, resetAfterSeconds,
        status: usedPercent >= 100 ? 'limit_reached' : usedPercent >= 80 ? 'warning' : 'allowed',
      };
    };

    const windows: UsageWindowInfo[] = [];
    for (const [label, key] of [['5h', 'five_hour'], ['7d', 'seven_day'], ['7d Opus', 'seven_day_opus'], ['7d Sonnet', 'seven_day_sonnet'], ['Extra', 'extra_usage']] as const) {
      const w = makeWindow(label, (data as any)[key]);
      if (w) windows.push(w);
    }
    if (!windows.length) return null;

    const overallStatus = windows.some(w => w.status === 'limit_reached') ? 'limit_reached'
      : windows.some(w => w.status === 'warning') ? 'warning' : 'allowed';

    return { ok: true, agent: 'claude', source: 'oauth-api', capturedAt, status: overallStatus, windows, error: null };
  } catch { return null; }
}

function getClaudeUsageFromTelemetry(home: string, model?: string | null): UsageResult | null {
  const telemetryRoot = path.join(home, '.claude', 'telemetry');
  if (!fs.existsSync(telemetryRoot)) return null;

  const preferredFamily = modelFamily(model);
  type Candidate = { capturedAtMs: number; capturedAt: string; status: string | null; hoursTillReset: number | null; model: string | null };
  let bestAny: Candidate | null = null;
  let bestMatch: Candidate | null = null;

  try {
    const files = fs.readdirSync(telemetryRoot)
      .filter(name => name.endsWith('.json'))
      .map(name => ({ full: path.join(telemetryRoot, name), mtime: fs.statSync(path.join(telemetryRoot, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50);

    for (const file of files) {
      const lines = fs.readFileSync(file.full, 'utf-8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const raw = lines[i];
        if (!raw || raw[0] !== '{' || !raw.includes('tengu_claudeai_limits_status_changed')) continue;
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { continue; }
        const data = parsed?.event_data;
        if (data?.event_name !== 'tengu_claudeai_limits_status_changed') continue;
        const capturedAtMs = Date.parse(data.client_timestamp || '');
        if (!Number.isFinite(capturedAtMs)) continue;
        let meta = data.additional_metadata;
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
        const hoursTillReset = Number(meta?.hoursTillReset);
        const candidate: Candidate = {
          capturedAtMs, capturedAt: new Date(capturedAtMs).toISOString(),
          status: typeof meta?.status === 'string' ? meta.status : null,
          hoursTillReset: Number.isFinite(hoursTillReset) ? hoursTillReset : null,
          model: typeof data.model === 'string' ? data.model : null,
        };
        if (!bestAny || candidate.capturedAtMs > bestAny.capturedAtMs) bestAny = candidate;
        if (preferredFamily && candidate.model?.toLowerCase().includes(preferredFamily)) {
          if (!bestMatch || candidate.capturedAtMs > bestMatch.capturedAtMs) bestMatch = candidate;
        }
      }
    }
  } catch { return null; }

  const chosen = bestMatch || bestAny;
  if (!chosen) return null;

  const status = normalizeUsageStatus(chosen.status);
  const resetAfterSeconds = chosen.hoursTillReset == null ? null : Math.max(0, Math.round(chosen.hoursTillReset * 3600));
  const resetAt = resetAfterSeconds == null ? null : new Date(chosen.capturedAtMs + resetAfterSeconds * 1000).toISOString();
  // Build a locale-neutral label from capture age (e.g. "3h ago", "2d ago")
  const ageMs = Date.now() - chosen.capturedAtMs;
  const ageMins = Math.round(ageMs / 60_000);
  const ageLabel = ageMins < 1 ? '<1m ago' : ageMins < 60 ? `${ageMins}m ago` : ageMins < 1440 ? `${Math.round(ageMins / 60)}h ago` : `${Math.round(ageMins / 1440)}d ago`;
  const windows: UsageWindowInfo[] = [{ label: ageLabel, usedPercent: null, remainingPercent: null, resetAt, resetAfterSeconds, status }];

  return { ok: true, agent: 'claude', source: 'telemetry', capturedAt: chosen.capturedAt, status, windows, error: null };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

class ClaudeDriver implements AgentDriver {
  readonly id = 'claude';
  readonly cmd = 'claude';
  readonly thinkLabel = 'Thinking';

  async doStream(opts: StreamOpts): Promise<StreamResult> {
    return doClaudeStream(opts);
  }

  async getSessions(workdir: string, limit?: number): Promise<SessionListResult> {
    return getClaudeSessions(workdir, limit);
  }

  async getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
    return getClaudeSessionTail(opts);
  }

  async getSessionMessages(opts: SessionMessagesOpts): Promise<SessionMessagesResult> {
    return getClaudeSessionMessages(opts);
  }

  async listModels(_opts: ModelListOpts): Promise<ModelListResult> {
    return { agent: 'claude', models: [...CLAUDE_MODELS], sources: [], note: null };
  }

  getUsage(opts: UsageOpts): UsageResult {
    const home = process.env.HOME || '';
    if (!home) return emptyUsage('claude', 'HOME is not set.');
    return getClaudeUsageFromOAuth()
      || getClaudeUsageFromTelemetry(home, opts.model)
      || emptyUsage('claude', 'No recent Claude usage data found.');
  }

  shutdown() {}
}

registerDriver(new ClaudeDriver());
