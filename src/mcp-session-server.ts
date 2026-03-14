/**
 * mcp-session-server.ts — MCP server process for pikiclaw session bridge.
 *
 * Spawned by the agent CLI (claude/codex/gemini) via --mcp-config or codex mcp add.
 * Communicates with the agent over stdio using the MCP protocol (JSON-RPC 2.0).
 *
 * Supports two stdio transports (auto-detected from first byte):
 *   - Content-Length framing (Claude, Gemini — standard MCP/LSP)
 *   - Newline-delimited JSON (Codex)
 *
 * Context is injected via environment variables:
 *   MCP_WORKSPACE_PATH — absolute path to the session workspace
 *   MCP_STAGED_FILES   — JSON array of staged file relative paths
 *   MCP_CALLBACK_URL   — HTTP URL for the pikiclaw callback server
 *
 * Tools are defined in src/tools/ — each module exports definitions + handlers.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { McpToolModule, ToolContext } from './tools/types.js';
import { workspaceTools } from './tools/workspace.js';
import { guiTools } from './tools/gui.js';

// ---------------------------------------------------------------------------
// Logging — writes to stderr + file so it doesn't interfere with stdio MCP transport
// ---------------------------------------------------------------------------

const _logFile = (() => {
  try {
    const ws = process.env.MCP_WORKSPACE_PATH || '';
    if (!ws) return null;
    const dir = path.dirname(ws);
    const fp = path.join(dir, 'mcp-server.log');
    return fs.openSync(fp, 'a');
  } catch { return null; }
})();

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  const line = `[mcp-server ${ts}] ${msg}\n`;
  process.stderr.write(line);
  if (_logFile != null) try { fs.writeSync(_logFile, line); } catch {}
}

function summarizeArgs(args: unknown, max = 200): string {
  let text = '';
  try {
    text = JSON.stringify(args);
  } catch {
    text = String(args);
  }
  if (!text) return '{}';
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

// ---------------------------------------------------------------------------
// Context from environment
// ---------------------------------------------------------------------------

const ctx: ToolContext = {
  workspace: process.env.MCP_WORKSPACE_PATH || '',
  stagedFiles: (() => {
    try { return JSON.parse(process.env.MCP_STAGED_FILES || '[]'); } catch { return []; }
  })(),
  callbackUrl: process.env.MCP_CALLBACK_URL || '',
};

log(`started workspace=${ctx.workspace} stagedFiles=${ctx.stagedFiles.length} callbackUrl=${ctx.callbackUrl ? 'set' : 'MISSING'}`);

// ---------------------------------------------------------------------------
// Tool registry — collect all tool modules
// ---------------------------------------------------------------------------

const TOOL_MODULES: McpToolModule[] = [workspaceTools, guiTools];

const ALL_TOOLS = TOOL_MODULES.flatMap(m => m.tools);

/** Lookup: tool name → module that handles it. */
const TOOL_HANDLERS = new Map<string, McpToolModule>();
for (const mod of TOOL_MODULES) {
  for (const t of mod.tools) {
    TOOL_HANDLERS.set(t.name, mod);
  }
}

// ---------------------------------------------------------------------------
// MCP protocol — auto-detect transport format
// ---------------------------------------------------------------------------

/** 'framed' = Content-Length (Claude/Gemini), 'ndjson' = newline-delimited (Codex) */
let transport: 'framed' | 'ndjson' | null = null;

function send(msg: object) {
  const body = JSON.stringify(msg);
  if (transport === 'ndjson') {
    process.stdout.write(body + '\n');
  } else {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
}

function respond(id: unknown, result: object) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id: unknown, code: number, message: string) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Stdio reader — auto-detecting Content-Length framed vs NDJSON
// ---------------------------------------------------------------------------

let buffer = '';

function processFramed() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;
    const body = buffer.slice(bodyStart, bodyStart + len);
    buffer = buffer.slice(bodyStart + len);
    try { handleMessage(JSON.parse(body)); } catch { /* ignore parse errors */ }
  }
}

function processNdjson() {
  while (true) {
    const newlineIdx = buffer.indexOf('\n');
    if (newlineIdx < 0) break;
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    try { handleMessage(JSON.parse(line)); } catch { /* ignore parse errors */ }
  }
}

function processBuffer() {
  if (transport === null) {
    const trimmed = buffer.trimStart();
    if (!trimmed) return;
    transport = trimmed[0] === '{' ? 'ndjson' : 'framed';
  }
  if (transport === 'ndjson') processNdjson();
  else processFramed();
}

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  processBuffer();
});
process.stdin.on('end', () => process.exit(0));

// ---------------------------------------------------------------------------
// Message dispatcher
// ---------------------------------------------------------------------------

function handleMessage(msg: any) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      log(`initialize protocolVersion=${params?.protocolVersion || '?'}`);
      respond(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'pikiclaw-session', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      log('initialized notification received');
      break;

    case 'tools/list':
      log(`tools/list → ${ALL_TOOLS.length} tools: ${ALL_TOOLS.map(t => t.name).join(', ')}`);
      respond(id, { tools: ALL_TOOLS });
      break;

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      const mod = TOOL_HANDLERS.get(name);
      if (!mod) {
        log(`tools/call UNKNOWN tool="${name}"`);
        respondError(id, -32601, `Unknown tool: ${name}`);
        break;
      }
      const argsSummary = summarizeArgs(args);
      log(`tools/call tool="${name}" args=${argsSummary}`);
      const callStart = Date.now();
      void Promise.resolve(mod.handle(name, args, ctx)).then(
        result => {
          const elapsed = Date.now() - callStart;
          const text = result.content?.[0]?.text || '';
          log(`tools/call tool="${name}" ${result.isError ? 'ERROR' : 'OK'} ${elapsed}ms args=${argsSummary} result=${text.slice(0, 150)}`);
          respond(id, result);
        },
        err => {
          const elapsed = Date.now() - callStart;
          log(`tools/call tool="${name}" EXCEPTION ${elapsed}ms args=${argsSummary} error=${err?.message || err}`);
          respond(id, { content: [{ type: 'text', text: `Tool error: ${err?.message || err}` }], isError: true });
        },
      );
      break;
    }

    default:
      if (id !== undefined) {
        log(`unknown method="${method}"`);
        respondError(id, -32601, `Method not found: ${method}`);
      }
  }
}
