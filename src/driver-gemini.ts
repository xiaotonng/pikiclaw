/**
 * driver-gemini.ts — Gemini CLI agent driver.
 *
 * Requires `gemini` CLI installed (https://github.com/google-gemini/gemini-cli).
 * Stream protocol: spawns `gemini` with JSON output and parses stdout line-by-line.
 */

import { registerDriver, type AgentDriver } from './agent-driver.js';
import {
  type AgentInfo, type StreamOpts, type StreamResult,
  type SessionListResult, type SessionTailOpts, type SessionTailResult,
  type ModelListOpts, type ModelListResult,
  type UsageOpts, type UsageResult,
  run, agentLog, detectAgentBin, buildStreamPreviewMeta,
  pushRecentActivity,
  listCodeclawSessions, findCodeclawSessionByLocalId,
  emptyUsage,
} from './code-agent.js';

// ---------------------------------------------------------------------------
// Command & parser
// ---------------------------------------------------------------------------

function geminiCmd(o: StreamOpts): string[] {
  const args = ['gemini', '--output-format', 'stream-json'];
  if (o.geminiModel) args.push('--model', o.geminiModel);
  if (o.sessionId) args.push('--resume', o.sessionId);
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

function getGeminiSessions(workdir: string, limit?: number): SessionListResult {
  const sessions = listCodeclawSessions(workdir, 'gemini', limit).map(record => ({
    sessionId: record.engineSessionId,
    localSessionId: record.localSessionId,
    engineSessionId: record.engineSessionId,
    agent: 'gemini' as const,
    workdir: record.workdir,
    workspacePath: record.workspacePath,
    model: record.model,
    createdAt: record.createdAt,
    title: record.title,
    running: Date.now() - Date.parse(record.updatedAt) < 10_000,
  }));
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
    const managed = findCodeclawSessionByLocalId(opts.workdir, 'gemini', opts.sessionId);
    if (managed && !managed.engineSessionId) return { ok: true, messages: [], error: null };
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
