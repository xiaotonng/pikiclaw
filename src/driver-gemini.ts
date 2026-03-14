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
  pushRecentActivity,
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

function geminiParse(ev: any, s: any) {
  const t = ev.type || '';

  // init event: {"type":"init","session_id":"...","model":"..."}
  if (t === 'init') {
    s.sessionId = ev.session_id ?? s.sessionId;
    s.model = ev.model ?? s.model;
  }

  // message delta: {"type":"message","role":"assistant","content":"...","delta":true}
  if (t === 'message' && ev.role === 'assistant' && ev.delta) {
    s.text += ev.content || '';
  }

  // tool_call event (if gemini uses tools)
  if (t === 'tool_call') {
    const name = ev.name || ev.tool || 'tool';
    pushRecentActivity(s.recentActivity, `Using ${name}...`);
    s.activity = s.recentActivity.join('\n');
  }

  // tool_result event
  if (t === 'tool_result') {
    const name = ev.name || ev.tool || 'tool';
    pushRecentActivity(s.recentActivity, `${name} done`);
    s.activity = s.recentActivity.join('\n');
  }

  // result event: {"type":"result","status":"success","stats":{...}}
  if (t === 'result') {
    s.sessionId = ev.session_id ?? s.sessionId;
    if (ev.status === 'error' || ev.status === 'failure') {
      s.errors = [ev.error || ev.message || `Gemini returned status: ${ev.status}`];
    }
    s.stopReason = ev.status === 'success' ? 'end_turn' : ev.status;
    const u = ev.stats;
    if (u) {
      s.inputTokens = u.input_tokens ?? u.input ?? s.inputTokens;
      s.outputTokens = u.output_tokens ?? u.output ?? s.outputTokens;
      s.cachedInputTokens = u.cached ?? s.cachedInputTokens;
    }
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
    running: Date.now() - Date.parse(record.updatedAt) < 10_000,
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
