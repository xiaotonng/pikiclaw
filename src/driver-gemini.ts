/**
 * driver-gemini.ts — Gemini CLI agent driver.
 *
 * Requires `gemini` CLI installed (https://github.com/google-gemini/gemini-cli).
 * Stream protocol: spawns `gemini` with JSON output and parses stdout line-by-line.
 */

import { registerDriver, type AgentDriver } from './agent-driver.js';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { GEMINI_USAGE_TIMEOUTS, SESSION_RUNNING_THRESHOLD_MS } from './constants.js';
import {
  type AgentInfo, type StreamOpts, type StreamResult,
  type SessionListResult, type SessionInfo, type SessionTailOpts, type SessionTailResult,
  type ModelListOpts, type ModelListResult,
  type UsageOpts, type UsageResult, type UsageWindowInfo,
  run, agentLog, detectAgentBin, buildStreamPreviewMeta,
  appendSystemPrompt, pushRecentActivity, firstNonEmptyLine, shortValue, normalizeErrorMessage,
  listPikiclawSessions, findPikiclawSession, isPendingSessionId,
  mergeManagedAndNativeSessions,
  roundPercent, emptyUsage, Q,
} from './code-agent.js';

// ---------------------------------------------------------------------------
// Command & parser
// ---------------------------------------------------------------------------

function hasGeminiFlag(args: string[] | undefined, names: string[]): boolean {
  if (!args?.length) return false;
  return args.some(arg => {
    const trimmed = String(arg || '').trim();
    if (!trimmed.startsWith('-')) return false;
    return names.some(name => trimmed === name || trimmed.startsWith(`${name}=`));
  });
}

function geminiCmd(o: StreamOpts): string[] {
  const approvalMode = o.geminiApprovalMode || 'yolo';
  const sandbox = typeof o.geminiSandbox === 'boolean' ? o.geminiSandbox : false;
  const args = ['gemini', '--output-format', 'stream-json'];
  if (o.geminiModel) args.push('--model', o.geminiModel);
  if (o.sessionId) args.push('--resume', o.sessionId);
  if (!hasGeminiFlag(o.geminiExtraArgs, ['--approval-mode', '--yolo', '-y'])) {
    args.push('--approval-mode', approvalMode);
  }
  if (!hasGeminiFlag(o.geminiExtraArgs, ['--sandbox', '-s'])) {
    args.push('--sandbox', String(sandbox));
  }
  if (o.geminiExtraArgs?.length) args.push(...o.geminiExtraArgs);
  // gemini's -p requires the prompt as its value (not via stdin)
  const promptText = o.geminiSystemInstruction
    ? appendSystemPrompt(o.geminiSystemInstruction, o.prompt)
    : o.prompt;
  args.push('-p', promptText);
  return args;
}

function geminiContextWindowFromModel(model: unknown): number | null {
  const id = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!id) return null;
  if (/^(auto-gemini-(2\.5|3)|gemini-(2\.5|3|3\.1)-)/.test(id)) return 1_048_576;
  return null;
}

function geminiToolName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  return name || 'tool';
}

function geminiToolLabel(name: string): string {
  return name
    .replace(/^mcp_/, '')
    .replace(/^discovered_tool_/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'tool';
}

function geminiToolSummary(name: unknown, parameters: any): string {
  const tool = geminiToolName(name);
  const params = parameters && typeof parameters === 'object' ? parameters : {};
  switch (tool) {
    case 'read_file': {
      const target = shortValue(params.file_path || params.path, 140);
      return target ? `Read ${target}` : 'Read file';
    }
    case 'read_many_files': {
      const include = shortValue(params.include || params.pattern, 120);
      return include ? `Read files: ${include}` : 'Read files';
    }
    case 'write_file': {
      const target = shortValue(params.file_path || params.path, 140);
      return target ? `Write ${target}` : 'Write file';
    }
    case 'replace': {
      const target = shortValue(params.file_path || params.path, 140);
      return target ? `Edit ${target}` : 'Edit file';
    }
    case 'list_directory': {
      const dir = shortValue(params.dir_path || params.path, 120);
      return dir ? `List files: ${dir}` : 'List files';
    }
    case 'glob': {
      const pattern = shortValue(params.pattern || params.glob, 120);
      return pattern ? `Find files: ${pattern}` : 'Find files';
    }
    case 'grep_search':
    case 'search_file_content': {
      const pattern = shortValue(params.pattern || params.query, 120);
      return pattern ? `Search text: ${pattern}` : 'Search text';
    }
    case 'run_shell_command': {
      const command = shortValue(params.command, 120);
      return command ? `Run shell: ${command}` : 'Run shell';
    }
    case 'web_fetch': {
      const target = shortValue(params.url || params.prompt, 120);
      return target ? `Fetch ${target}` : 'Fetch web page';
    }
    case 'google_web_search': {
      const query = shortValue(params.query, 120);
      return query ? `Search web: ${query}` : 'Search web';
    }
    case 'write_todos': return 'Update todo list';
    case 'save_memory': return 'Save memory';
    case 'ask_user': return 'Request user input';
    case 'activate_skill': {
      const skill = shortValue(params.name, 80);
      return skill ? `Activate skill: ${skill}` : 'Activate skill';
    }
    case 'get_internal_docs': {
      const target = shortValue(params.path, 120);
      return target ? `Read docs: ${target}` : 'Read docs';
    }
    case 'enter_plan_mode': return 'Enter plan mode';
    case 'exit_plan_mode': return 'Exit plan mode';
    default: {
      const detail = shortValue(
        params.file_path
        || params.path
        || params.dir_path
        || params.pattern
        || params.query
        || params.command
        || params.url
        || params.name,
        120,
      );
      const label = shortValue(geminiToolLabel(tool), 80);
      return detail ? `Use ${label}: ${detail}` : `Use ${label}`;
    }
  }
}

function geminiToolResultSummary(tool: { name: string; summary: string } | undefined, ev: any): string {
  const fallbackSummary = geminiToolSummary(
    tool?.name || ev.tool_name || ev.name || ev.tool,
    ev.parameters || ev.args || ev.input || {},
  );
  const summary = tool?.summary || fallbackSummary;
  const detail = shortValue(
    firstNonEmptyLine(
      normalizeErrorMessage(ev.error)
      || ev.output
      || ev.message
      || '',
    ),
    120,
  );
  if (ev.status === 'error') return detail ? `${summary} failed: ${detail}` : `${summary} failed`;
  return detail ? `${summary} -> ${detail}` : `${summary} done`;
}

function geminiParse(ev: any, s: any) {
  const t = ev.type || '';

  // init event: {"type":"init","session_id":"...","model":"..."}
  if (t === 'init') {
    s.sessionId = ev.session_id ?? s.sessionId;
    s.model = ev.model ?? s.model;
    s.contextWindow = geminiContextWindowFromModel(s.model) ?? s.contextWindow;
  }

  // message delta: {"type":"message","role":"assistant","content":"...","delta":true}
  if (t === 'message' && ev.role === 'assistant') {
    if (ev.delta) s.text += ev.content || '';
    else if (!s.text.trim()) s.text = ev.content || '';
  }

  if (t === 'tool_use' || t === 'tool_call') {
    const name = geminiToolName(ev.tool_name || ev.name || ev.tool);
    const summary = geminiToolSummary(name, ev.parameters || ev.args || ev.input || {});
    const toolId = String(ev.tool_id || ev.id || '').trim();
    if (toolId) s.geminiToolsById.set(toolId, { name, summary });
    pushRecentActivity(s.recentActivity, summary);
    s.activity = s.recentActivity.join('\n');
  }

  if (t === 'tool_result') {
    const toolId = String(ev.tool_id || ev.id || '').trim();
    const tool = toolId ? s.geminiToolsById.get(toolId) : undefined;
    pushRecentActivity(s.recentActivity, geminiToolResultSummary(tool, ev));
    s.activity = s.recentActivity.join('\n');
  }

  if (t === 'error') {
    const message = normalizeErrorMessage(ev.message || ev.error) || 'Gemini reported an error';
    if (ev.severity === 'error') {
      s.errors = [...(s.errors || []), message];
    } else {
      pushRecentActivity(s.recentActivity, message);
      s.activity = s.recentActivity.join('\n');
    }
  }

  // result event: {"type":"result","status":"success","stats":{...}}
  if (t === 'result') {
    s.sessionId = ev.session_id ?? s.sessionId;
    if (ev.status === 'error' || ev.status === 'failure') {
      const message = normalizeErrorMessage(ev.error)
        || normalizeErrorMessage(ev.errors)
        || normalizeErrorMessage(ev.message)
        || `Gemini returned status: ${ev.status}`;
      s.errors = [message];
    }
    s.stopReason = ev.status === 'success' ? 'end_turn' : ev.status;
    const u = ev.stats;
    if (u) {
      s.inputTokens = u.input_tokens ?? u.input ?? s.inputTokens;
      s.outputTokens = u.output_tokens ?? u.output ?? s.outputTokens;
      s.cachedInputTokens = u.cached ?? s.cachedInputTokens;
    }
    s.contextWindow = geminiContextWindowFromModel(s.model) ?? s.contextWindow;
  }
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

export async function doGeminiStream(opts: StreamOpts): Promise<StreamResult> {
  // Prompt is passed as -p argument; send empty stdin so run() doesn't duplicate it
  const streamOpts = { ...opts, _stdinOverride: '' };
  return run(geminiCmd(opts), streamOpts, geminiParse);
}

// ---------------------------------------------------------------------------
// Sessions / Tail
// ---------------------------------------------------------------------------

/** Resolve Gemini project name for a workdir from ~/.gemini/projects.json */
function geminiProjectName(workdir: string): string | null {
  const home = process.env.HOME || '';
  if (!home) return null;
  const projectsPath = path.join(home, '.gemini', 'projects.json');
  try {
    const data = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
    const projects = data?.projects;
    if (!projects || typeof projects !== 'object') return null;
    const resolved = path.resolve(workdir);
    // Exact match first, then check entries
    if (projects[resolved]) return projects[resolved];
    for (const [dir, name] of Object.entries(projects)) {
      if (path.resolve(dir) === resolved) return name as string;
    }
  } catch { /* skip */ }
  return null;
}

function geminiChatsDir(workdir: string): string | null {
  const home = process.env.HOME || '';
  if (!home) return null;
  const projectName = geminiProjectName(workdir);
  if (!projectName) return null;
  return path.join(home, '.gemini', 'tmp', projectName, 'chats');
}

function extractGeminiText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim()) parts.push(block.trim());
      continue;
    }
    const text = typeof block?.text === 'string' ? block.text.trim() : '';
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

function normalizeGeminiSessionTitle(value: unknown): string | null {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}...`;
}

function findGeminiSessionFile(workdir: string, sessionId: string): string | null {
  const chatsDir = geminiChatsDir(workdir);
  if (!chatsDir || !fs.existsSync(chatsDir)) return null;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(chatsDir, { withFileTypes: true }); } catch { return null; }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('session-') || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(chatsDir, entry.name);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data?.sessionId === sessionId) return filePath;
    } catch { /* skip */ }
  }
  return null;
}

/** Read native Gemini CLI sessions from ~/.gemini/tmp/{projectName}/chats/ */
function getNativeGeminiSessionsFromFiles(workdir: string): SessionInfo[] {
  const chatsDir = geminiChatsDir(workdir);
  if (!chatsDir || !fs.existsSync(chatsDir)) return [];

  const sessions: SessionInfo[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(chatsDir, { withFileTypes: true }); } catch { return []; }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('session-') || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(chatsDir, entry.name);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!data.sessionId) continue;
      // Extract title from first user message
      let title: string | null = null;
      const messages = Array.isArray(data.messages) ? data.messages : [];
      for (const msg of messages) {
        if (msg.type === 'user') {
          title = normalizeGeminiSessionTitle(extractGeminiText(msg.content));
          break;
        }
      }
      sessions.push({
        sessionId: data.sessionId,
        agent: 'gemini',
        workdir,
        workspacePath: null,
        model: null,
        createdAt: data.startTime || null,
        title,
        running: data.lastUpdated ? Date.now() - Date.parse(data.lastUpdated) < SESSION_RUNNING_THRESHOLD_MS : false,
        runState: data.lastUpdated && Date.now() - Date.parse(data.lastUpdated) < SESSION_RUNNING_THRESHOLD_MS ? 'running' : 'completed',
        runDetail: null,
        runUpdatedAt: data.lastUpdated || data.startTime || null,
      });
    } catch { /* skip */ }
  }
  return sessions;
}

function getNativeGeminiSessions(workdir: string): SessionInfo[] {
  return getNativeGeminiSessionsFromFiles(workdir);
}

function getGeminiSessions(workdir: string, limit?: number): SessionListResult {
  const resolvedWorkdir = path.resolve(workdir);
  // Merge pikiclaw-tracked sessions with native Gemini sessions
  const pikiclawSessions = listPikiclawSessions(resolvedWorkdir, 'gemini').map(record => ({
    sessionId: record.sessionId,
    agent: 'gemini' as const,
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
  const nativeSessions = getNativeGeminiSessions(resolvedWorkdir);
  const merged = mergeManagedAndNativeSessions(pikiclawSessions, nativeSessions);
  const sessions = typeof limit === 'number' ? merged.slice(0, limit) : merged;
  const projectName = geminiProjectName(resolvedWorkdir);
  const chatsDir = projectName ? geminiChatsDir(resolvedWorkdir) || '' : '';
  agentLog(
    `[sessions:gemini] workdir=${resolvedWorkdir} projectName=${projectName || '(none)'} chatsDir=${chatsDir || '(none)'} ` +
    `chatsDirExists=${chatsDir ? fs.existsSync(chatsDir) : false} pikiclaw=${pikiclawSessions.length} native=${nativeSessions.length} merged=${sessions.length}`
  );
  return { ok: true, sessions, error: null };
}

function getGeminiSessionTail(opts: SessionTailOpts): SessionTailResult {
  const limit = opts.limit ?? 4;
  const filePath = findGeminiSessionFile(opts.workdir, opts.sessionId);
  if (!filePath) return { ok: false, messages: [], error: 'Session file not found' };

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const allMsgs: { role: 'user' | 'assistant'; text: string }[] = [];
    for (const msg of messages) {
      const type = typeof msg?.type === 'string' ? msg.type.trim().toLowerCase() : '';
      const role = type === 'user' ? 'user' : type === 'gemini' ? 'assistant' : null;
      if (!role) continue;
      const text = extractGeminiText(msg?.content);
      if (text) allMsgs.push({ role, text });
    }
    return { ok: true, messages: allMsgs.slice(-limit), error: null };
  } catch (e: any) {
    return { ok: false, messages: [], error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Models — static list for now, can be extended with `gemini models list`
// ---------------------------------------------------------------------------

// Model IDs from gemini-cli-core (no CLI command to list them dynamically)
const GEMINI_MODELS = [
  { id: 'auto-gemini-3', alias: 'auto-3' },
  { id: 'auto-gemini-2.5', alias: 'auto' },
  { id: 'gemini-3.1-pro-preview', alias: '3.1-pro' },
  { id: 'gemini-3-pro-preview', alias: '3-pro' },
  { id: 'gemini-3-flash-preview', alias: '3-flash' },
  { id: 'gemini-2.5-pro', alias: 'pro' },
  { id: 'gemini-2.5-flash', alias: 'flash' },
  { id: 'gemini-2.5-flash-lite', alias: 'flash-lite' },
];

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const GEMINI_USAGE_TIMEOUT_MS = GEMINI_USAGE_TIMEOUTS.request;
const GEMINI_USAGE_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
let lastGeminiUsage: UsageResult | null = null;

function cachedGeminiUsage(error: string): UsageResult {
  return lastGeminiUsage?.ok ? lastGeminiUsage : emptyUsage('gemini', error);
}

function getGeminiOAuthToken(): string | null {
  const home = process.env.HOME || '';
  if (!home) return null;
  const credsPath = path.join(home, '.gemini', 'oauth_creds.json');
  try {
    const raw = fs.readFileSync(credsPath, 'utf-8').trim();
    if (!raw || raw[0] !== '{') return null;
    const parsed = JSON.parse(raw);
    const token = typeof parsed?.access_token === 'string' ? parsed.access_token.trim() : '';
    return token || null;
  } catch {
    return null;
  }
}

function geminiUsageLabel(modelId: unknown): string {
  const raw = typeof modelId === 'string' ? modelId.trim() : '';
  const lower = raw.toLowerCase();
  if (!lower) return 'Gemini';
  if (lower.includes('flash-lite')) return 'Flash Lite';
  if (lower.includes('flash')) return 'Flash';
  if (lower.includes('pro')) return 'Pro';
  return raw
    .replace(/^gemini-/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || 'Gemini';
}

function geminiUsageStatus(usedPercent: number | null): string | null {
  if (usedPercent == null) return null;
  if (usedPercent >= 100) return 'limit_reached';
  if (usedPercent >= 80) return 'warning';
  return 'allowed';
}

function geminiResetAt(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function geminiResetAtMs(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function geminiUsageWindowSort(label: string): number {
  switch (label) {
    case 'Pro': return 0;
    case 'Flash': return 1;
    case 'Flash Lite': return 2;
    default: return 10;
  }
}

function parseGeminiUsageResponse(data: any, capturedAt: string): UsageResult | null {
  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
  const grouped = new Map<string, { label: string; remainingFraction: number; resetAt: string | null }>();

  for (const bucket of buckets) {
    const remainingFraction = Number(bucket?.remainingFraction);
    if (!Number.isFinite(remainingFraction)) continue;
    const label = geminiUsageLabel(bucket?.modelId);
    const resetAt = geminiResetAt(bucket?.resetTime);
    const prev = grouped.get(label);
    if (!prev
      || remainingFraction < prev.remainingFraction
      || (remainingFraction === prev.remainingFraction && geminiResetAtMs(resetAt) < geminiResetAtMs(prev.resetAt))) {
      grouped.set(label, { label, remainingFraction, resetAt });
    }
  }

  const windows: UsageWindowInfo[] = [...grouped.values()]
    .map(entry => {
      const usedPercent = roundPercent((1 - entry.remainingFraction) * 100);
      const remainingPercent = roundPercent(entry.remainingFraction * 100);
      let resetAfterSeconds: number | null = null;
      if (entry.resetAt) {
        const resetAtMs = Date.parse(entry.resetAt);
        if (Number.isFinite(resetAtMs)) resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
      }
      return {
        label: entry.label,
        usedPercent,
        remainingPercent,
        resetAt: entry.resetAt,
        resetAfterSeconds,
        status: geminiUsageStatus(usedPercent),
      };
    })
    .sort((a, b) => {
      const byLabel = geminiUsageWindowSort(a.label) - geminiUsageWindowSort(b.label);
      return byLabel || a.label.localeCompare(b.label);
    });

  if (!windows.length) return null;

  const status = windows.some(window => window.status === 'limit_reached') ? 'limit_reached'
    : windows.some(window => window.status === 'warning') ? 'warning'
    : 'allowed';

  return { ok: true, agent: 'gemini', source: 'quota-api', capturedAt, status, windows, error: null };
}

function geminiUsageError(status: number, bodyText: string): UsageResult {
  let detail = '';
  const trimmed = String(bodyText || '').trim();
  if (trimmed && trimmed[0] === '{') {
    try {
      const parsed = JSON.parse(trimmed);
      detail = normalizeErrorMessage(parsed?.error?.message)
        || normalizeErrorMessage(parsed?.error)
        || normalizeErrorMessage(parsed?.message)
        || '';
    } catch {}
  }
  return cachedGeminiUsage(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
}

async function getGeminiUsageLive(): Promise<UsageResult> {
  const token = getGeminiOAuthToken();
  if (!token) return cachedGeminiUsage('Gemini OAuth token not found.');

  try {
    const raw = execSync(
      `curl -sS --max-time ${Math.ceil(GEMINI_USAGE_TIMEOUT_MS / 1000)} -w '\\n%{http_code}' -H ${Q(`Authorization: Bearer ${token}`)} -H 'Content-Type: application/json' -d '{}' ${Q(GEMINI_USAGE_URL)}`,
      { encoding: 'utf-8', timeout: GEMINI_USAGE_TIMEOUT_MS + GEMINI_USAGE_TIMEOUTS.execSyncBuffer },
    );
    const trimmed = raw.trimEnd();
    const sep = trimmed.lastIndexOf('\n');
    const bodyText = sep >= 0 ? trimmed.slice(0, sep) : '';
    const status = Number(sep >= 0 ? trimmed.slice(sep + 1).trim() : '');
    if (!Number.isFinite(status)) return cachedGeminiUsage('Gemini quota query returned an invalid HTTP status.');
    if (status < 200 || status >= 300) return geminiUsageError(status, bodyText);
    if (!bodyText.trim() || bodyText.trim()[0] !== '{') return cachedGeminiUsage('Gemini quota query returned an invalid response.');
    const usage = parseGeminiUsageResponse(JSON.parse(bodyText), new Date().toISOString())
      || cachedGeminiUsage('No Gemini quota buckets returned.');
    if (usage.ok) lastGeminiUsage = usage;
    return usage;
  } catch (err: any) {
    const detail = normalizeErrorMessage(err?.message || err) || 'Gemini usage query failed.';
    return cachedGeminiUsage(detail);
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

class GeminiDriver implements AgentDriver {
  readonly id = 'gemini';
  readonly cmd = 'gemini';
  readonly thinkLabel = 'Thinking';

  detect(): AgentInfo { return detectAgentBin('gemini', 'gemini'); }

  async doStream(opts: StreamOpts): Promise<StreamResult> { return doGeminiStream(opts); }

  async getSessions(workdir: string, limit?: number): Promise<SessionListResult> {
    return getGeminiSessions(workdir, limit);
  }

  async getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
    return getGeminiSessionTail(opts);
  }

  async listModels(_opts: ModelListOpts): Promise<ModelListResult> {
    return { agent: 'gemini', models: [...GEMINI_MODELS], sources: [], note: null };
  }

  getUsage(_opts: UsageOpts): UsageResult {
    return cachedGeminiUsage('No recent Gemini usage data found.');
  }

  async getUsageLive(_opts: UsageOpts): Promise<UsageResult> {
    return getGeminiUsageLive();
  }

  shutdown() {}
}

registerDriver(new GeminiDriver());
