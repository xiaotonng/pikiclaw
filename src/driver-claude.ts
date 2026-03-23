/**
 * driver-claude.ts — Claude CLI agent driver.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { registerDriver, type AgentDriver } from './agent-driver.js';
import {
  type AgentInfo, type StreamOpts, type StreamResult,
  type SessionListResult, type SessionTailOpts, type SessionTailResult,
  type ModelListOpts, type ModelListResult, type ModelInfo,
  type UsageOpts, type UsageResult, type UsageWindowInfo,
  type SessionInfo,
  // shared helpers
  run, agentLog, detectAgentBin,
  appendSystemPrompt, buildStreamPreviewMeta, pushRecentActivity,
  summarizeClaudeToolUse, summarizeClaudeToolResult,
  IMAGE_EXTS, mimeForExt,
  listPikiclawSessions, findPikiclawSession, isPendingSessionId,
  mergeManagedAndNativeSessions,
  readTailLines, stripInjectedPrompts,
  roundPercent, toIsoFromEpochSeconds, modelFamily, normalizeClaudeModelId, emptyUsage, normalizeUsageStatus,
} from './code-agent.js';
import { SESSION_RUNNING_THRESHOLD_MS } from './constants.js';

// ---------------------------------------------------------------------------
// Multimodal stdin
// ---------------------------------------------------------------------------

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
      content.push({ type: 'text', text: `[Attached file: ${filePath}]` });
    }
  }
  content.push({ type: 'text', text: prompt });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

// ---------------------------------------------------------------------------
// Command & parser
// ---------------------------------------------------------------------------

function claudeCmd(o: StreamOpts): string[] {
  const args = ['claude', '-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
  const model = normalizeClaudeModelId(o.claudeModel);
  if (model) args.push('--model', model);
  if (o.claudePermissionMode) args.push('--permission-mode', o.claudePermissionMode);
  if (o.sessionId) args.push('--resume', o.sessionId);
  if (o.attachments?.length) {
    args.push('--input-format', 'stream-json');
    o._stdinOverride = buildClaudeMultimodalStdin(o.prompt, o.attachments);
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
      const tool = {
        name: String(block?.name || 'Tool').trim() || 'Tool',
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

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

export async function doClaudeStream(opts: StreamOpts): Promise<StreamResult> {
  const result = await run(claudeCmd(opts), opts, claudeParse);
  const retryText = `${result.error || ''}\n${result.message}`;
  if (!result.ok && opts.sessionId && /no conversation found/i.test(retryText)) {
    return run(claudeCmd({ ...opts, sessionId: null }), { ...opts, sessionId: null }, claudeParse);
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
            const text = extractClaudeText(ev.message?.content, true).replace(/\s+/g, ' ').trim();
            if (text) title = text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}...`;
          }
          if (!model && ev.type === 'assistant' && ev.message?.model) {
            model = ev.message.model;
          }
          if (title && model) break;
        } catch { /* skip */ }
      }

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
    model: record.model,
    createdAt: record.createdAt,
    title: record.title,
    running: record.runState === 'running',
    runState: record.runState,
    runDetail: record.runDetail,
    runUpdatedAt: record.runUpdatedAt,
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
// Models
// ---------------------------------------------------------------------------

const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-6', alias: 'opus' },
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

  detect(): AgentInfo { return detectAgentBin('claude', 'claude'); }

  async doStream(opts: StreamOpts): Promise<StreamResult> {
    return doClaudeStream(opts);
  }

  async getSessions(workdir: string, limit?: number): Promise<SessionListResult> {
    return getClaudeSessions(workdir, limit);
  }

  async getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
    return getClaudeSessionTail(opts);
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
