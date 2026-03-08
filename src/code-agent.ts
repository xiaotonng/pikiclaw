import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

export type Agent = 'codex' | 'claude';

export interface StreamOpts {
  agent: Agent;
  prompt: string;
  workdir: string;
  timeout: number;
  sessionId: string | null;
  model: string | null;
  thinkingEffort: string;
  onText: (text: string, thinking: string) => void;
  /** Local file paths to attach (images, documents, etc.) */
  attachments?: string[];
  // codex
  codexModel?: string;
  codexFullAccess?: boolean;
  codexExtraArgs?: string[];
  /** Previous cumulative token totals for this Codex session (used to compute per-invocation delta) */
  codexPrevCumulative?: { input: number; output: number; cached: number };
  // claude
  claudeModel?: string;
  claudePermissionMode?: string;
  claudeExtraArgs?: string[];
  /** Override stdin payload (used for stream-json multimodal input) */
  _stdinOverride?: string;
}

export interface StreamResult {
  ok: boolean;
  message: string;
  thinking: string | null;
  sessionId: string | null;
  model: string | null;
  thinkingEffort: string;
  elapsedS: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** Context window size as reported by the CLI (Claude: result.modelUsage, Codex: models_cache.json) */
  contextWindow: number | null;
  /** Raw cumulative token totals from Codex session (null for Claude). Store these and pass back as codexPrevCumulative on the next invocation. */
  codexCumulative: { input: number; output: number; cached: number } | null;
  error: string | null;
  stopReason: string | null;
  incomplete: boolean;
}

const Q = (a: string) => /[^a-zA-Z0-9_./:=@-]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;

function agentLog(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[agent ${ts}] ${msg}\n`);
}

async function run(cmd: string[], opts: StreamOpts, parseLine: (ev: any, s: any) => void): Promise<StreamResult> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;
  let stderr = '';
  let lineCount = 0;
  const s = {
    sessionId: opts.sessionId, text: '', thinking: '', msgs: [] as string[], thinkParts: [] as string[],
    model: opts.model, thinkingEffort: opts.thinkingEffort, errors: null as string[] | null,
    inputTokens: null as number | null, outputTokens: null as number | null, cachedInputTokens: null as number | null,
    contextWindow: null as number | null,
    codexCumulative: null as { input: number; output: number; cached: number } | null,
    stopReason: null as string | null,
  };

  const shellCmd = cmd.map(Q).join(' ');
  agentLog(`[spawn] cmd: ${shellCmd}`);
  agentLog(`[spawn] cwd: ${opts.workdir} timeout: ${opts.timeout}s session: ${opts.sessionId || '(new)'}`);
  agentLog(`[spawn] prompt: "${opts.prompt.slice(0, 120)}"`);

  const proc = spawn(shellCmd, { cwd: opts.workdir, stdio: ['pipe', 'pipe', 'pipe'], shell: true });
  agentLog(`[spawn] pid=${proc.pid}`);
  try { proc.stdin!.write(opts._stdinOverride ?? opts.prompt); proc.stdin!.end(); } catch {}
  proc.stderr?.on('data', (c: Buffer) => {
    const chunk = c.toString();
    stderr += chunk;
    agentLog(`[stderr] ${chunk.trim().slice(0, 200)}`);
  });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on('line', raw => {
    if (Date.now() > deadline) { agentLog(`[timeout] deadline exceeded, killing process`); proc.kill('SIGKILL'); return; }
    const line = raw.trim();
    if (!line || line[0] !== '{') return;
    lineCount++;
    try {
      const ev = JSON.parse(line);
      const evType = ev.type || '?';
      // Log key events (not every delta to avoid spam)
      if (evType === 'system' || evType === 'result' || evType === 'assistant' ||
          evType === 'thread.started' || evType === 'turn.completed' || evType === 'item.completed') {
        agentLog(`[event] type=${evType} session=${ev.session_id || s.sessionId || '?'} model=${ev.model || s.model || '?'}`);
      }
      if (evType === 'stream_event') {
        const inner = ev.event || {};
        if (inner.type === 'message_start' || inner.type === 'message_delta') {
          agentLog(`[event] stream_event/${inner.type} session=${ev.session_id || '?'}`);
        }
      }
      parseLine(ev, s);
      opts.onText(s.text, s.thinking);
    } catch {}
  });

  const [procOk, code] = await new Promise<[boolean, number | null]>(resolve => {
    proc.on('close', code => { agentLog(`[exit] code=${code} lines_parsed=${lineCount}`); resolve([code === 0, code]); });
    proc.on('error', e => { agentLog(`[error] ${e.message}`); stderr += e.message; resolve([false, -1]); });
  });

  if (!s.text.trim() && s.msgs.length) s.text = s.msgs.join('\n\n');
  if (!s.thinking.trim() && s.thinkParts.length) s.thinking = s.thinkParts.join('\n\n');

  const ok = procOk && !s.errors;
  const error = s.errors?.map(e => e.trim()).filter(Boolean).join('; ') || (!procOk ? (stderr.trim() || `Failed (exit=${code}).`) : null);
  const incomplete = !ok || s.stopReason === 'max_tokens';
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  agentLog(`[result] ok=${ok && !s.errors} elapsed=${elapsed}s text=${s.text.length}chars thinking=${s.thinking.length}chars session=${s.sessionId || '?'}`);
  if (s.errors) agentLog(`[result] errors: ${s.errors.join('; ')}`);
  if (s.stopReason) agentLog(`[result] stop_reason=${s.stopReason}`);
  if (stderr.trim() && !procOk) agentLog(`[result] stderr: ${stderr.trim().slice(0, 300)}`);

  return {
    ok, sessionId: s.sessionId, model: s.model, thinkingEffort: s.thinkingEffort,
    message: s.text.trim() || s.errors?.join('; ') || (procOk ? '(no textual response)' : `Failed (exit=${code}).\n\n${stderr.trim() || '(no output)'}`),
    thinking: s.thinking.trim() || null,
    elapsedS: (Date.now() - start) / 1000,
    inputTokens: s.inputTokens, outputTokens: s.outputTokens, cachedInputTokens: s.cachedInputTokens,
    contextWindow: s.contextWindow,
    codexCumulative: s.codexCumulative,
    error,
    stopReason: s.stopReason,
    incomplete,
  };
}

// --- codex ---

function codexCmd(o: StreamOpts): string[] {
  const args = ['codex', 'exec'];
  if (o.sessionId) args.push('resume');
  args.push('--json');
  if (o.codexModel) args.push('-m', o.codexModel);
  args.push('-c', `model_reasoning_effort="${o.thinkingEffort}"`);
  if (o.codexFullAccess) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (o.attachments?.length) {
    for (const f of o.attachments) args.push('--image', f);
  }
  if (o.codexExtraArgs?.length) args.push(...o.codexExtraArgs);
  if (o.sessionId) args.push(o.sessionId);
  args.push('-');
  return args;
}

function codexParse(ev: any, s: any, opts: StreamOpts) {
  const t = ev.type || '';
  if (t === 'thread.started') {
    s.sessionId = ev.thread_id ?? s.sessionId;
    s.model = ev.model ?? s.model;
  }
  if (t === 'item.completed') {
    const item = ev.item || {};
    if (item.type === 'agent_message' && item.text?.trim()) { s.msgs.push(item.text.trim()); s.text = s.msgs.join('\n\n'); }
    if (item.type === 'reasoning' && (item.text || item.summary)?.trim()) { s.thinkParts.push((item.text || item.summary).trim()); s.thinking = s.thinkParts.join('\n\n'); }
  }
  if (t === 'turn.completed') {
    const u = ev.usage;
    if (u) {
      // Codex reports cumulative session totals in turn.completed.
      // Store raw cumulative and compute per-invocation delta.
      const cumInput = u.input_tokens ?? 0;
      const cumOutput = u.output_tokens ?? 0;
      const cumCached = u.cached_input_tokens ?? 0;
      s.codexCumulative = { input: cumInput, output: cumOutput, cached: cumCached };
      const prev = opts.codexPrevCumulative;
      s.inputTokens = prev ? Math.max(0, cumInput - prev.input) : cumInput;
      s.outputTokens = prev ? Math.max(0, cumOutput - prev.output) : cumOutput;
      s.cachedInputTokens = prev ? Math.max(0, cumCached - prev.cached) : cumCached;
    }
    s.model = ev.model ?? s.model;
  }
}

export async function doCodexStream(opts: StreamOpts): Promise<StreamResult> {
  const result = await run(codexCmd(opts), opts, (ev, s) => codexParse(ev, s, opts));
  // Codex doesn't report context_window in stream events; read from models_cache.json
  if (!result.contextWindow) result.contextWindow = readCodexContextWindow(result.model);
  return result;
}

// --- claude ---

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function mimeForExt(ext: string): string {
  switch (ext) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

/**
 * Build a stream-json stdin payload that includes images as base64 content
 * blocks alongside the text prompt.
 */
function buildClaudeMultimodalStdin(prompt: string, attachments: string[]): string {
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
        agentLog(`[attach] failed to read image ${filePath}: ${e.message}`);
      }
    } else {
      // For non-image files, tell Claude the path so it can Read it
      content.push({ type: 'text', text: `[Attached file: ${filePath}]` });
    }
  }
  content.push({ type: 'text', text: prompt });
  const msg = {
    type: 'user',
    message: { role: 'user', content },
  };
  return JSON.stringify(msg) + '\n';
}

function claudeCmd(o: StreamOpts): string[] {
  const args = ['claude', '-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
  if (o.claudeModel) args.push('--model', o.claudeModel);
  if (o.claudePermissionMode) args.push('--permission-mode', o.claudePermissionMode);
  if (o.sessionId) args.push('--resume', o.sessionId);
  if (o.attachments?.length) {
    args.push('--input-format', 'stream-json');
    o._stdinOverride = buildClaudeMultimodalStdin(o.prompt, o.attachments);
  }
  if (o.claudeExtraArgs?.length) args.push(...o.claudeExtraArgs);
  return args;
}

function claudeParse(ev: any, s: any) {
  const t = ev.type || '';
  if (t === 'system') { s.sessionId = ev.session_id ?? s.sessionId; s.model = ev.model ?? s.model; s.thinkingEffort = ev.thinking_level ?? s.thinkingEffort; }

  if (t === 'stream_event') {
    const inner = ev.event || {};
    if (inner.type === 'content_block_delta') {
      const d = inner.delta || {};
      if (d.type === 'thinking_delta') s.thinking += d.thinking || '';
      else if (d.type === 'text_delta') s.text += d.text || '';
    }
    if (inner.type === 'message_delta') {
      const d = inner.delta || {};
      s.stopReason = d.stop_reason ?? s.stopReason;
      const u = inner.usage;
      if (u) { s.inputTokens = u.input_tokens ?? s.inputTokens; s.cachedInputTokens = u.cache_read_input_tokens ?? s.cachedInputTokens; s.outputTokens = u.output_tokens ?? s.outputTokens; }
    }
    s.sessionId = ev.session_id ?? s.sessionId;
    s.model = ev.model ?? s.model;
  }

  if (t === 'assistant') {
    const msg = ev.message || {};
    const contents = msg.content || [];
    const th = contents.filter((b: any) => b?.type === 'thinking').map((b: any) => b.thinking || '').join('');
    const tx = contents.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('');
    if (th && !s.thinking.trim()) s.thinking = th;
    if (tx && !s.text.trim()) s.text = tx;
    s.stopReason = msg.stop_reason ?? s.stopReason;
  }

  if (t === 'result') {
    s.sessionId = ev.session_id ?? s.sessionId; s.model = ev.model ?? s.model;
    if (ev.is_error && ev.errors?.length) s.errors = ev.errors;
    if (ev.result && !s.text.trim()) s.text = ev.result;
    s.stopReason = ev.stop_reason ?? s.stopReason;
    const u = ev.usage;
    if (u) { s.inputTokens = u.input_tokens ?? s.inputTokens; s.cachedInputTokens = (u.cache_read_input_tokens ?? u.cached_input_tokens) ?? s.cachedInputTokens; s.outputTokens = u.output_tokens ?? s.outputTokens; }
    // Extract contextWindow from modelUsage (Claude CLI reports this in result event)
    const mu = ev.modelUsage;
    if (mu && typeof mu === 'object') {
      for (const info of Object.values(mu) as any[]) {
        if (info?.contextWindow > 0) { s.contextWindow = info.contextWindow; break; }
      }
    }
  }
}

export async function doClaudeStream(opts: StreamOpts): Promise<StreamResult> {
  const result = await run(claudeCmd(opts), opts, claudeParse);
  // session not found → retry as new conversation
  const retryText = `${result.error || ''}\n${result.message}`;
  if (!result.ok && opts.sessionId && /no conversation found/i.test(retryText)) {
    return run(claudeCmd({ ...opts, sessionId: null }), { ...opts, sessionId: null }, claudeParse);
  }
  return result;
}

// --- unified entry ---

export function doStream(opts: StreamOpts): Promise<StreamResult> {
  return opts.agent === 'codex' ? doCodexStream(opts) : doClaudeStream(opts);
}

// ---------------------------------------------------------------------------
// Session listing
// ---------------------------------------------------------------------------

export interface SessionInfo {
  sessionId: string;
  agent: Agent;
  workdir: string | null;
  model: string | null;
  createdAt: string | null;
  /** First user prompt (truncated), used as a display title */
  title: string | null;
  /** Whether the session file was modified in the last 60 seconds (likely running) */
  running: boolean;
}

export interface SessionListResult {
  ok: boolean;
  sessions: SessionInfo[];
  error: string | null;
}

export interface SessionListOpts {
  agent: Agent;
  /** Absolute workdir path — used to locate Claude project sessions and to filter Codex sessions */
  workdir: string;
  /** Max number of sessions to return (default 50) */
  limit?: number;
}

/**
 * Encode a workdir path to the Claude project directory name.
 * Claude replaces `/` with `-` and strips the leading `-`.
 */
function claudeProjectDirName(workdir: string): string {
  return workdir.replace(/\//g, '-');
}

function readLines(filePath: string, maxLines: number): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < maxLines; i++) {
      const nl = content.indexOf('\n', start);
      if (nl < 0) { if (start < content.length) lines.push(content.slice(start)); break; }
      lines.push(content.slice(start, nl));
      start = nl + 1;
    }
    return lines;
  } catch {
    return [];
  }
}

function parseClaudeSession(filePath: string, workdir: string): SessionInfo | null {
  const lines = readLines(filePath, 10);
  if (!lines.length) return null;
  try {
    const sessionId = path.basename(filePath, '.jsonl');
    const stat = fs.statSync(filePath);
    let model: string | null = null;
    let title: string | null = null;

    for (const raw of lines) {
      if (!raw || raw[0] !== '{') continue;
      try {
        const ev = JSON.parse(raw);
        if (ev.type === 'user' && !title) {
          const content = ev.message?.content;
          if (typeof content === 'string') {
            title = content.slice(0, 120);
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b: any) => b?.type === 'text' && b.text && !b.text.startsWith('<'));
            if (textBlock) title = textBlock.text.slice(0, 120);
          }
        }
        if (ev.type === 'assistant' && !model) {
          model = ev.message?.model ?? null;
        }
      } catch { /* skip unparseable lines */ }
      if (model && title) break;
    }

    return {
      sessionId,
      agent: 'claude',
      workdir,
      model,
      createdAt: stat.birthtime?.toISOString() ?? stat.mtime?.toISOString() ?? null,
      title,
      running: false,
    };
  } catch {
    return null;
  }
}

function readLastLine(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trimEnd().split('\n');
    return lines[lines.length - 1] || null;
  } catch { return null; }
}

function parseCodexSession(filePath: string): SessionInfo | null {
  const lines = readLines(filePath, 40);
  const line = lines[0];
  if (!line) return null;
  try {
    const ev = JSON.parse(line);
    if (ev.type !== 'session_meta') return null;
    const p = ev.payload || {};
    let model: string | null = typeof p.model === 'string' ? p.model : null;

    let title: string | null = null;
    for (const raw of lines.slice(1)) {
      if (!raw || raw[0] !== '{') continue;
      try {
        const item = JSON.parse(raw);
        if (!model && item.type === 'turn_context') {
          const payload = item.payload || {};
          model =
            (typeof payload.model === 'string' ? payload.model : null)
            || (typeof payload?.collaboration_mode?.settings?.model === 'string' ? payload.collaboration_mode.settings.model : null)
            || model;
        }
        if (item.type === 'response_item' && item.payload?.role === 'user' && item.payload?.type === 'message') {
          const content = item.payload.content;
          if (Array.isArray(content)) {
            const textBlock = content.find((b: any) => b?.type === 'input_text' && b.text && !/^[<#]/.test(b.text));
            if (textBlock) title = textBlock.text.slice(0, 120);
          }
        }
      } catch { /* skip */ }
      if (model && title) break;
    }

    // Codex writes task_complete as the last event when done
    let running = false;
    const last = readLastLine(filePath);
    if (last) {
      try {
        const lastEv = JSON.parse(last);
        running = !(lastEv.type === 'event_msg' && lastEv.payload?.type === 'task_complete');
      } catch { /* assume not running if unparseable */ }
    }

    return {
      sessionId: p.id ?? path.basename(filePath, '.jsonl'),
      agent: 'codex',
      workdir: p.cwd ?? null,
      model: model ?? null,
      createdAt: p.timestamp ?? null,
      title,
      running,
    };
  } catch {
    return null;
  }
}

/** Collect session IDs from running `claude --resume <id>` processes. */
function getRunningClaudeSessionIds(): Set<string> {
  try {
    const out = execSync('ps -eo args 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    const ids = new Set<string>();
    for (const m of out.matchAll(/--resume\s+(\S+)/g)) ids.add(m[1]);
    return ids;
  } catch { return new Set(); }
}

function getClaudeSessions(opts: SessionListOpts): SessionListResult {
  const limit = opts.limit ?? 50;
  const home = process.env.HOME || '';
  const projectDir = path.join(home, '.claude', 'projects', claudeProjectDirName(opts.workdir));

  if (!fs.existsSync(projectDir)) {
    return { ok: true, sessions: [], error: null };
  }

  const sessions: SessionInfo[] = [];
  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, full: path.join(projectDir, f), mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    const runningIds = getRunningClaudeSessionIds();
    const now = Date.now();
    for (const f of files) {
      const info = parseClaudeSession(f.full, opts.workdir);
      if (info) {
        info.running = runningIds.has(info.sessionId) || (now - f.mtime < 10_000);
        sessions.push(info);
      }
    }
  } catch (e: any) {
    return { ok: false, sessions: [], error: e.message };
  }
  return { ok: true, sessions, error: null };
}

function getCodexSessions(opts: SessionListOpts): SessionListResult {
  const limit = opts.limit ?? 50;
  const home = process.env.HOME || '';
  const sessionsRoot = path.join(home, '.codex', 'sessions');

  if (!fs.existsSync(sessionsRoot)) {
    return { ok: true, sessions: [], error: null };
  }

  const all: { path: string; mtime: number }[] = [];
  try {
    // Walk year/month/day directories
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
            const full = path.join(dp, f);
            all.push({ path: full, mtime: fs.statSync(full).mtimeMs });
          }
        }
      }
    }
  } catch (e: any) {
    return { ok: false, sessions: [], error: e.message };
  }

  // Sort newest first, parse and filter by workdir
  all.sort((a, b) => b.mtime - a.mtime);
  const sessions: SessionInfo[] = [];
  for (const entry of all) {
    if (sessions.length >= limit) break;
    const info = parseCodexSession(entry.path);
    if (info && info.workdir === opts.workdir) sessions.push(info);
  }
  return { ok: true, sessions, error: null };
}

export function getSessions(opts: SessionListOpts): SessionListResult {
  return opts.agent === 'codex' ? getCodexSessions(opts) : getClaudeSessions(opts);
}

// ---------------------------------------------------------------------------
// Agent listing
// ---------------------------------------------------------------------------

export interface AgentInfo {
  agent: Agent;
  installed: boolean;
  path: string | null;
  version: string | null;
}

export interface AgentListResult {
  agents: AgentInfo[];
}

function detectAgent(cmd: string, agent: Agent): AgentInfo {
  let binPath: string | null = null;
  try { binPath = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8' }).trim() || null; } catch { /* */ }
  let version: string | null = null;
  if (binPath) {
    try { version = execSync(`${cmd} --version 2>/dev/null`, { encoding: 'utf-8' }).trim().split('\n')[0] || null; } catch { /* */ }
  }
  return { agent, installed: !!binPath, path: binPath, version };
}

export function listAgents(): AgentListResult {
  return {
    agents: [
      detectAgent('claude', 'claude'),
      detectAgent('codex', 'codex'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  /** Short alias (e.g. 'opus', 'sonnet') — null if the id IS the alias */
  alias: string | null;
}

export interface ModelListResult {
  agent: Agent;
  models: ModelInfo[];
  sources: string[];
  note: string | null;
}

export interface ModelListOpts {
  workdir?: string;
  currentModel?: string | null;
}

function shellOutput(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim() || null;
  } catch {
    return null;
  }
}

function pushUnique<T>(items: T[], value: T) {
  if (!items.includes(value)) items.push(value);
}

function pushModel(models: ModelInfo[], seen: Set<string>, id: string, alias: string | null) {
  const cleanId = id.trim();
  if (!cleanId || seen.has(cleanId)) return;
  seen.add(cleanId);
  models.push({ id: cleanId, alias: alias?.trim() || null });
}

function claudeModelAlias(modelId: string | null | undefined): string | null {
  const value = String(modelId || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'opus' || value.startsWith('claude-opus-')) return 'opus';
  if (value === 'sonnet' || value.startsWith('claude-sonnet-')) return 'sonnet';
  if (value === 'haiku' || value.startsWith('claude-haiku-')) return 'haiku';
  return null;
}

function isClaudeModelToken(token: string): boolean {
  return token === 'opus' || token === 'sonnet' || token === 'haiku' || token.startsWith('claude-');
}

function addClaudeModel(models: ModelInfo[], seen: Set<string>, rawModel: string | null | undefined): boolean {
  const clean = String(rawModel || '').trim();
  if (!clean) return false;
  const alias = claudeModelAlias(clean);
  if (!alias && !clean.toLowerCase().startsWith('claude-')) return false;
  if (clean === alias) {
    if (models.some((m) => m.alias === alias)) return false;
    pushModel(models, seen, clean, null);
    return true;
  }
  if (alias) {
    const aliasIndex = models.findIndex((m) => m.id === alias && !m.alias);
    if (aliasIndex >= 0) {
      models.splice(aliasIndex, 1);
      seen.delete(alias);
    }
  }
  pushModel(models, seen, clean, alias);
  return true;
}

function isCodexModelToken(token: string): boolean {
  return /^(?:o\d(?:-[a-z0-9.-]+)?|gpt-[a-z0-9.-]+|codex-mini(?:-[a-z0-9.-]+)?)$/i.test(token);
}

function addCodexModel(models: ModelInfo[], seen: Set<string>, rawModel: string | null | undefined): boolean {
  const clean = String(rawModel || '').trim();
  if (!clean || !isCodexModelToken(clean)) return false;
  pushModel(models, seen, clean, null);
  return true;
}

function readCodexConfigModels(home: string): string[] {
  const configPath = path.join(home, '.codex', 'config.toml');
  if (!fs.existsSync(configPath)) return [];

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const found: string[] = [];
    const defaultModel = raw.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
    if (defaultModel) pushUnique(found, defaultModel);

    const migrationsSection = raw.match(/\[notice\.model_migrations\]\n([\s\S]*?)(?:\n\[|$)/)?.[1] || '';
    for (const match of migrationsSection.matchAll(/"[^"]+"\s*=\s*"([^"]+)"/g)) {
      if (match[1]) pushUnique(found, match[1]);
    }
    return found.filter(isCodexModelToken);
  } catch {
    return [];
  }
}

function readCodexCachedModels(home: string): string[] {
  const cachePath = path.join(home, '.codex', 'models_cache.json');
  if (!fs.existsSync(cachePath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const models = Array.isArray(raw?.models) ? raw.models : [];
    return models
      .filter((m: any) => m?.visibility === 'list')
      .sort((a: any, b: any) => (Number(a?.priority) || 0) - (Number(b?.priority) || 0))
      .map((m: any) => String(m?.slug || '').trim())
      .filter(isCodexModelToken);
  } catch {
    return [];
  }
}

/** Look up context_window for a Codex model from ~/.codex/models_cache.json */
function readCodexContextWindow(model: string | null): number | null {
  if (!model) return null;
  const home = process.env.HOME || '';
  const cachePath = path.join(home, '.codex', 'models_cache.json');
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const models = Array.isArray(raw?.models) ? raw.models : [];
    const entry = models.find((m: any) => m?.slug === model);
    const cw = Number(entry?.context_window);
    return cw > 0 ? cw : null;
  } catch {
    return null;
  }
}

function readClaudeStateModels(home: string, workdir?: string): string[] {
  const statePath = path.join(home, '.claude.json');
  if (!fs.existsSync(statePath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const projects = raw?.projects;
    if (!projects || typeof projects !== 'object') return [];

    const found: string[] = [];
    const addFromProject = (projectState: any) => {
      const usage = projectState?.lastModelUsage;
      if (!usage || typeof usage !== 'object') return;
      for (const modelId of Object.keys(usage)) {
        if (isClaudeModelToken(modelId)) pushUnique(found, modelId);
      }
    };

    if (workdir && typeof projects[workdir] === 'object') {
      addFromProject(projects[workdir]);
    }
    for (const [projectPath, projectState] of Object.entries(projects)) {
      if (projectPath === workdir) continue;
      addFromProject(projectState);
    }

    return found;
  } catch {
    return [];
  }
}

function discoverClaudeModels(opts: ModelListOpts): ModelListResult {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const sources: string[] = [];
  const home = process.env.HOME || '';

  if (opts.currentModel?.trim()) {
    addClaudeModel(models, seen, opts.currentModel);
    pushUnique(sources, 'current config');
  }

  let foundStateModel = false;
  for (const modelId of readClaudeStateModels(home, opts.workdir)) {
    foundStateModel = addClaudeModel(models, seen, modelId) || foundStateModel;
  }
  if (foundStateModel) pushUnique(sources, '~/.claude.json');

  const help = shellOutput('claude --help 2>/dev/null');
  if (help) {
    let foundHelpModel = false;
    for (const match of help.matchAll(/\b(?:opus|sonnet|haiku|claude-(?:opus|sonnet|haiku)-[a-z0-9-]+)\b/gi)) {
      const token = match[0].trim();
      foundHelpModel = addClaudeModel(models, seen, token) || foundHelpModel;
    }
    if (foundHelpModel) pushUnique(sources, 'claude --help');
  }

  if (opts.workdir) {
    const sessions = getClaudeSessions({ agent: 'claude', workdir: opts.workdir, limit: 20 });
    let foundSessionModel = false;
    for (const session of sessions.sessions) {
      if (!session.model) continue;
      foundSessionModel = addClaudeModel(models, seen, session.model) || foundSessionModel;
    }
    if (foundSessionModel) pushUnique(sources, 'recent sessions');
  }

  return {
    agent: 'claude',
    models,
    sources,
    note: 'Claude CLI does not expose a machine-readable model list; entries are discovered from current config, ~/.claude.json, CLI help, and local session state.',
  };
}

function discoverCodexModels(opts: ModelListOpts): ModelListResult {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const sources: string[] = [];
  const home = process.env.HOME || '';

  let foundCacheModel = false;
  for (const modelId of readCodexCachedModels(home)) {
    foundCacheModel = addCodexModel(models, seen, modelId) || foundCacheModel;
  }
  if (foundCacheModel) pushUnique(sources, '~/.codex/models_cache.json');

  const help = shellOutput('codex --help 2>/dev/null');
  if (help) {
    let foundHelpModel = false;
    for (const match of help.matchAll(/model="([^"]+)"/g)) {
      addCodexModel(models, seen, match[1]);
      foundHelpModel = true;
    }
    if (foundHelpModel) pushUnique(sources, 'codex --help');
  }

  if (opts.currentModel?.trim()) {
    addCodexModel(models, seen, opts.currentModel);
    pushUnique(sources, 'current config');
  }

  let foundConfigModel = false;
  for (const modelId of readCodexConfigModels(home)) {
    foundConfigModel = addCodexModel(models, seen, modelId) || foundConfigModel;
  }
  if (foundConfigModel) pushUnique(sources, '~/.codex/config.toml');

  if (opts.workdir) {
    const sessions = getCodexSessions({ agent: 'codex', workdir: opts.workdir, limit: 20 });
    let foundSessionModel = false;
    for (const session of sessions.sessions) {
      if (!session.model) continue;
      foundSessionModel = addCodexModel(models, seen, session.model) || foundSessionModel;
    }
    if (foundSessionModel) pushUnique(sources, 'recent sessions');
  }

  return {
    agent: 'codex',
    models,
    sources,
    note: 'Codex CLI does not expose a model-list subcommand; entries are discovered from the local Codex model cache and other local state.',
  };
}

export function listModels(agent: Agent, opts: ModelListOpts = {}): ModelListResult {
  return agent === 'codex' ? discoverCodexModels(opts) : discoverClaudeModels(opts);
}

// ---------------------------------------------------------------------------
// Usage inspection
// ---------------------------------------------------------------------------

export interface UsageWindowInfo {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  /**
   * Remaining seconds as reported when the usage snapshot was captured.
   * Combine with `capturedAt` to estimate the current remaining time.
   */
  resetAfterSeconds: number | null;
  status: string | null;
}

export interface UsageResult {
  ok: boolean;
  agent: Agent;
  source: string | null;
  capturedAt: string | null;
  status: string | null;
  windows: UsageWindowInfo[];
  error: string | null;
}

export interface UsageOpts {
  agent: Agent;
  model?: string | null;
}

function toIsoFromEpochSeconds(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function roundPercent(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function labelFromWindowMinutes(value: unknown, fallback: string): string {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes === 300) return '5h';
  if (minutes === 10080) return '7d';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function usageWindowFromRateLimit(fallback: string, limit: any): UsageWindowInfo | null {
  if (!limit || typeof limit !== 'object') return null;

  const usedPercent = roundPercent(limit.used_percent);
  const remainingPercent = usedPercent == null ? null : Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
  const resetAt = toIsoFromEpochSeconds(limit.reset_at ?? limit.resets_at);

  let resetAfterSeconds: number | null = null;
  const directResetAfter = Number(limit.reset_after_seconds);
  if (Number.isFinite(directResetAfter) && directResetAfter >= 0) {
    resetAfterSeconds = Math.round(directResetAfter);
  } else if (resetAt) {
    const resetAtMs = Date.parse(resetAt);
    if (Number.isFinite(resetAtMs)) {
      resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
    }
  }

  return {
    label: labelFromWindowMinutes(limit.window_minutes, fallback),
    usedPercent,
    remainingPercent,
    resetAt,
    resetAfterSeconds,
    status: typeof limit.status === 'string' ? limit.status : null,
  };
}

function parseJsonTail(raw: string): any | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(raw.slice(start)); } catch { return null; }
}

function modelFamily(model: string | null | undefined): string | null {
  const lower = model?.toLowerCase() || '';
  if (!lower) return null;
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return null;
}

function emptyUsage(agent: Agent, error: string): UsageResult {
  return {
    ok: false,
    agent,
    source: null,
    capturedAt: null,
    status: null,
    windows: [],
    error,
  };
}

function getCodexStateDbPath(home: string): string | null {
  const root = path.join(home, '.codex');
  if (!fs.existsSync(root)) return null;
  try {
    const files = fs.readdirSync(root)
      .filter(name => /^state.*\.sqlite$/i.test(name))
      .map(name => ({ name, full: path.join(root, name), mtime: fs.statSync(path.join(root, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.full || null;
  } catch {
    return null;
  }
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

  return {
    ok: true,
    agent: 'codex',
    source,
    capturedAt,
    status,
    windows,
    error: null,
  };
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
  } catch {
    return null;
  }
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
            const full = path.join(dp, f);
            all.push({ path: full, mtime: fs.statSync(full).mtimeMs });
          }
        }
      }
    }
  } catch {
    return null;
  }

  all.sort((a, b) => b.mtime - a.mtime);
  for (const entry of all.slice(0, 30)) {
    try {
      const lines = fs.readFileSync(entry.path, 'utf-8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
        const raw = lines[i];
        if (!raw || raw[0] !== '{' || !raw.includes('rate_limits')) continue;
        let ev: any;
        try { ev = JSON.parse(raw); } catch { continue; }
        const result = codexUsageFromRateLimits(
          ev?.payload?.rate_limits,
          typeof ev?.timestamp === 'string' ? ev.timestamp : null,
          'session-history',
        );
        if (result) return result;
      }
    } catch {
      // ignore malformed or unreadable session files
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Claude usage from OAuth API (https://api.anthropic.com/api/oauth/usage)
// ---------------------------------------------------------------------------

function getClaudeOAuthToken(): string | null {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
      encoding: 'utf-8', timeout: 3000,
    }).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
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

    const makeWindow = (label: string, entry: any): UsageWindowInfo | null => {
      if (!entry || typeof entry !== 'object') return null;
      const usedPercent = roundPercent(entry.utilization);
      if (usedPercent == null) return null;
      const remainingPercent = Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
      const resetAt = typeof entry.resets_at === 'string' ? entry.resets_at : null;
      let resetAfterSeconds: number | null = null;
      if (resetAt) {
        const resetAtMs = Date.parse(resetAt);
        if (Number.isFinite(resetAtMs)) {
          resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
        }
      }
      return {
        label,
        usedPercent,
        remainingPercent,
        resetAt,
        resetAfterSeconds,
        status: usedPercent >= 100 ? 'limit_reached' : usedPercent >= 80 ? 'warning' : 'allowed',
      };
    };

    const windows: UsageWindowInfo[] = [];
    const w5h = makeWindow('5h', data.five_hour);
    if (w5h) windows.push(w5h);
    const w7d = makeWindow('7d', data.seven_day);
    if (w7d) windows.push(w7d);
    const w7dOpus = makeWindow('7d Opus', data.seven_day_opus);
    if (w7dOpus) windows.push(w7dOpus);
    const w7dSonnet = makeWindow('7d Sonnet', data.seven_day_sonnet);
    if (w7dSonnet) windows.push(w7dSonnet);
    const wExtra = makeWindow('Extra', data.extra_usage);
    if (wExtra) windows.push(wExtra);

    if (!windows.length) return null;

    const overallStatus = windows.some(w => w.status === 'limit_reached') ? 'limit_reached'
      : windows.some(w => w.status === 'warning') ? 'warning'
      : 'allowed';

    return {
      ok: true,
      agent: 'claude',
      source: 'oauth-api',
      capturedAt,
      status: overallStatus,
      windows,
      error: null,
    };
  } catch {
    return null;
  }
}

function getClaudeUsageFromTelemetry(home: string, model?: string | null): UsageResult | null {
  const telemetryRoot = path.join(home, '.claude', 'telemetry');
  if (!fs.existsSync(telemetryRoot)) return null;

  const preferredFamily = modelFamily(model);
  type ClaudeTelemetryCandidate = {
    capturedAtMs: number;
    capturedAt: string;
    status: string | null;
    hoursTillReset: number | null;
    model: string | null;
  };
  let bestAny: ClaudeTelemetryCandidate | null = null;
  let bestMatch: ClaudeTelemetryCandidate | null = null;

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
        if (typeof meta === 'string') {
          try { meta = JSON.parse(meta); } catch { meta = null; }
        }

        const hoursTillReset = Number(meta?.hoursTillReset);
        const candidate = {
          capturedAtMs,
          capturedAt: new Date(capturedAtMs).toISOString(),
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
  } catch {
    return null;
  }

  const chosen = bestMatch || bestAny;
  if (!chosen) return null;

  const resetAfterSeconds = chosen.hoursTillReset == null ? null : Math.max(0, Math.round(chosen.hoursTillReset * 3600));
  const resetAt = resetAfterSeconds == null ? null : new Date(chosen.capturedAtMs + resetAfterSeconds * 1000).toISOString();
  const windows: UsageWindowInfo[] = [{
    label: 'Current',
    usedPercent: null,
    remainingPercent: null,
    resetAt,
    resetAfterSeconds,
    status: chosen.status,
  }];

  return {
    ok: true,
    agent: 'claude',
    source: 'telemetry',
    capturedAt: chosen.capturedAt,
    status: chosen.status,
    windows,
    error: null,
  };
}

export function getUsage(opts: UsageOpts): UsageResult {
  const home = process.env.HOME || '';
  if (!home) return emptyUsage(opts.agent, 'HOME is not set.');

  if (opts.agent === 'codex') {
    return getCodexUsageFromStateDb(home)
      || getCodexUsageFromSessions(home)
      || emptyUsage('codex', 'No recent Codex usage data found.');
  }

  return getClaudeUsageFromOAuth()
    || getClaudeUsageFromTelemetry(home, opts.model)
    || emptyUsage('claude', 'No recent Claude usage data found.');
}
