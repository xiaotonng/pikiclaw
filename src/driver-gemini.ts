/**
 * driver-gemini.ts — Gemini CLI agent driver.
 *
 * Requires `gemini` CLI installed (https://github.com/google-gemini/gemini-cli).
 * Stream protocol: spawns `gemini` with JSON output and parses stdout line-by-line.
 */

import { registerDriver, type AgentDriver } from './agent-driver.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AgentInfo, type StreamOpts, type StreamResult,
  type SessionListResult, type SessionInfo, type SessionTailOpts, type SessionTailResult,
  type ModelListOpts, type ModelListResult,
  type UsageOpts, type UsageResult,
  run, agentLog, detectAgentBin, buildStreamPreviewMeta,
  pushRecentActivity, firstNonEmptyLine, shortValue, normalizeErrorMessage,
  listPikiclawSessions, findPikiclawSession, isPendingSessionId,
  emptyUsage,
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
  args.push('-p', o.prompt);
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

/** Read native Gemini CLI sessions from ~/.gemini/tmp/{projectName}/chats/ */
function getNativeGeminiSessions(workdir: string): SessionInfo[] {
  const home = process.env.HOME || '';
  if (!home) return [];
  const projectName = geminiProjectName(workdir);
  if (!projectName) return [];
  const chatsDir = path.join(home, '.gemini', 'tmp', projectName, 'chats');
  if (!fs.existsSync(chatsDir)) return [];

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
          const content = Array.isArray(msg.content) ? msg.content : [];
          const text = content.map((c: any) => c?.text || '').join(' ').replace(/\s+/g, ' ').trim();
          if (text) { title = text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}...`; }
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
        running: data.lastUpdated ? Date.now() - Date.parse(data.lastUpdated) < 10_000 : false,
        runState: data.lastUpdated && Date.now() - Date.parse(data.lastUpdated) < 10_000 ? 'running' : 'completed',
        runDetail: null,
        runUpdatedAt: data.lastUpdated || data.startTime || null,
      });
    } catch { /* skip */ }
  }
  return sessions;
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

  // Merge: pikiclaw records take precedence
  // Filter out pending sessions — they haven't been confirmed by the agent yet
  const seen = new Set<string>();
  const merged: SessionInfo[] = [];
  for (const s of pikiclawSessions) {
    if (isPendingSessionId(s.sessionId)) continue;
    if (s.sessionId) seen.add(s.sessionId);
    merged.push(s);
  }
  for (const s of nativeSessions) {
    if (s.sessionId && !seen.has(s.sessionId)) merged.push(s);
  }

  merged.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
  const sessions = typeof limit === 'number' ? merged.slice(0, limit) : merged;
  const projectName = geminiProjectName(resolvedWorkdir);
  const chatsDir = projectName ? path.join(process.env.HOME || '', '.gemini', 'tmp', projectName, 'chats') : '';
  agentLog(
    `[sessions:gemini] workdir=${resolvedWorkdir} projectName=${projectName || '(none)'} chatsDir=${chatsDir || '(none)'} ` +
    `chatsDirExists=${chatsDir ? fs.existsSync(chatsDir) : false} pikiclaw=${pikiclawSessions.length} native=${nativeSessions.length} merged=${sessions.length}`
  );
  return { ok: true, sessions, error: null };
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
    // TODO: implement gemini session tail reading once protocol is known
    return { ok: true, messages: [], error: null };
  }

  async listModels(_opts: ModelListOpts): Promise<ModelListResult> {
    return { agent: 'gemini', models: [...GEMINI_MODELS], sources: [], note: null };
  }

  getUsage(_opts: UsageOpts): UsageResult {
    return emptyUsage('gemini', 'Gemini usage inspection not yet implemented.');
  }

  shutdown() {}
}

registerDriver(new GeminiDriver());
