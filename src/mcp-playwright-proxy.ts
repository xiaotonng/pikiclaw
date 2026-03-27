import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRetainedLogSink, writeScopedLog, type LogLevel } from './logging.js';
import {
  getManagedBrowserProfileDir,
  resolveManagedBrowserMcpCommand,
} from './browser-profile.js';

const DISABLED_TOOLS = new Set(['browser_install']);
const DISABLED_TOOL_ERROR = [
  'browser_install is disabled by pikiclaw.',
  'Install Chrome locally and configure the browser mode during pikiclaw setup instead.',
].join(' ');

function envBool(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

const logSink = (() => {
  try {
    const profileDir = process.env.PIKICLAW_PLAYWRIGHT_PROFILE_DIR || getManagedBrowserProfileDir();
    fs.mkdirSync(profileDir, { recursive: true });
    return createRetainedLogSink(path.join(profileDir, 'playwright-mcp-proxy.log'));
  } catch {
    return null;
  }
})();

function log(message: string, level: LogLevel = 'debug') {
  if (!writeScopedLog('playwright-mcp-proxy', message, { level, stream: 'stderr' })) return;
  logSink?.(`[playwright-mcp-proxy ${new Date().toTimeString().slice(0, 8)}] ${message}\n`);
}

type Transport = 'framed' | 'ndjson';

function createSender(write: (chunk: string) => void) {
  return (transport: Transport, message: unknown) => {
    const body = JSON.stringify(message);
    if (transport === 'ndjson') write(`${body}\n`);
    else write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
}

function createParser(onMessage: (message: any) => void) {
  let transport: Transport | null = null;
  let buffer = '';

  const processFramed = () => {
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.slice(bodyStart, bodyStart + length);
      buffer = buffer.slice(bodyStart + length);
      try { onMessage(JSON.parse(body)); } catch {}
    }
  };

  const processNdjson = () => {
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch {}
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      if (!transport) {
        const trimmed = buffer.trimStart();
        if (!trimmed) return;
        transport = trimmed.startsWith('{') ? 'ndjson' : 'framed';
      }
      if (transport === 'ndjson') processNdjson();
      else processFramed();
    },
    transport(): Transport | null {
      return transport;
    },
  };
}

const profileDir = String(process.env.PIKICLAW_PLAYWRIGHT_PROFILE_DIR || '').trim() || getManagedBrowserProfileDir();
const headless = envBool('PIKICLAW_PLAYWRIGHT_HEADLESS', false);
const cdpEndpoint = String(process.env.PIKICLAW_PLAYWRIGHT_CDP_ENDPOINT || '').trim() || null;
const upstreamMode = cdpEndpoint ? 'attach' : (headless ? 'headless' : 'headed');
const upstream = resolveManagedBrowserMcpCommand(profileDir, { headless, cdpEndpoint });
log(`spawn upstream source=${upstream.source} mode=${upstreamMode} command=${upstream.command} args=${JSON.stringify(upstream.args)}`);

const child = spawn(upstream.command, upstream.args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PIKICLAW_PLAYWRIGHT_PROFILE_DIR: profileDir,
    PIKICLAW_PLAYWRIGHT_HEADLESS: String(headless),
    PIKICLAW_PLAYWRIGHT_CDP_ENDPOINT: cdpEndpoint || '',
  },
});

const sendToParent = createSender(chunk => process.stdout.write(chunk));
const sendToChild = createSender(chunk => child.stdin.write(chunk));
const pendingMethods = new Map<string, string>();
let parentTransport: Transport | null = null;
let childTransport: Transport | null = null;

const parentParser = createParser(message => {
  parentTransport = parentParser.transport();
  if (!parentTransport) return;

  const requestId = message?.id;
  const method = typeof message?.method === 'string' ? message.method : '';
  if (requestId != null && method) pendingMethods.set(String(requestId), method);

  if (method === 'tools/call' && DISABLED_TOOLS.has(String(message?.params?.name || ''))) {
    log(`blocked disabled tool call name=${message?.params?.name || ''}`, 'warn');
    sendToParent(parentTransport, {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        content: [{ type: 'text', text: DISABLED_TOOL_ERROR }],
        isError: true,
      },
    });
    pendingMethods.delete(String(requestId));
    return;
  }

  sendToChild(parentTransport, message);
});

const childParser = createParser(message => {
  childTransport = childParser.transport();
  parentTransport = parentTransport || childTransport;
  if (!parentTransport) return;

  const requestId = message?.id != null ? String(message.id) : '';
  const pendingMethod = requestId ? pendingMethods.get(requestId) || '' : '';

  if (pendingMethod === 'tools/list' && Array.isArray(message?.result?.tools)) {
    const original = message.result.tools;
    const filtered = original.filter((tool: any) => !DISABLED_TOOLS.has(String(tool?.name || '')));
    if (filtered.length !== original.length) {
      log(`filtered tools/list ${original.length} -> ${filtered.length}`);
      message = {
        ...message,
        result: {
          ...message.result,
          tools: filtered,
        },
      };
    }
  }

  if (requestId) pendingMethods.delete(requestId);
  sendToParent(parentTransport, message);
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => parentParser.push(String(chunk)));
process.stdin.on('end', () => {
  child.stdin.end();
});

child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => childParser.push(String(chunk)));
child.stderr.on('data', chunk => {
  const text = String(chunk).trim();
  if (text) log(`upstream stderr: ${text}`, 'warn');
});

child.on('close', code => {
  log(`upstream exited code=${code ?? 'null'}`, code === 0 || code == null ? 'debug' : 'warn');
  process.exit(code ?? 0);
});

child.on('error', error => {
  log(`upstream spawn error: ${error.message}`, 'error');
  process.exit(1);
});
