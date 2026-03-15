/**
 * mcp-bridge.ts — MCP session bridge orchestrator.
 *
 * Runs inside the main pikiclaw process. For each agent stream:
 *   1. Starts a tiny HTTP callback server on localhost (random port).
 *   2. Writes an MCP config JSON pointing to `pikiclaw --mcp-serve`.
 *   3. The agent CLI loads that config via its MCP registration mechanism.
 *   4. When the agent calls `send_file`, the MCP server POSTs to our callback.
 *   5. We forward the request to the IM channel and respond with success/failure.
 *
 * Lifecycle: one bridge per stream, created before spawn, stopped after stream ends.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadUserConfig } from './user-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpSendFileOpts {
  caption?: string;
  kind?: 'photo' | 'document';
}

export interface McpSendFileResult {
  ok: boolean;
  error?: string;
}

export type McpSendFileCallback = (
  filePath: string,
  opts: McpSendFileOpts,
) => Promise<McpSendFileResult>;

export interface McpBridgeHandle {
  /** Path to the generated MCP config JSON — pass to agent CLI via --mcp-config. */
  configPath: string;
  /** Extra environment variables required by the target agent to load the config. */
  extraEnv?: Record<string, string>;
  /** Whether the MCP server emitted any tool-related activity during the stream. */
  hadActivity: () => boolean;
  /** Gracefully stop the callback server and clean up config file. */
  stop: () => Promise<void>;
}

export interface McpBridgeOpts {
  /** Absolute path to session directory (parent of workspace). */
  sessionDir: string;
  /** Absolute path to the session workspace. */
  workspacePath: string;
  /** Agent workdir (cwd passed to agent). Files here are also allowed for send. */
  workdir?: string;
  /** List of staged file paths (relative to workspace). */
  stagedFiles: string[];
  /** Callback invoked when the agent calls the send_file MCP tool. */
  sendFile: McpSendFileCallback;
  /** Agent type — determines how MCP server is registered. */
  agent?: string;
  /** Optional log sink for MCP tool activity. */
  onLog?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Resolve the MCP server entry script path
// ---------------------------------------------------------------------------

/**
 * Find the compiled mcp-session-server.js next to this file's compiled output.
 * Falls back to running via the CLI entry point with --mcp-serve.
 */
interface McpServerRuntimeInfo {
  execPath: string;
  execArgv: string[];
  argv: string[];
  moduleUrl: string;
}

interface RegisteredMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface GuiIntegrationConfig {
  browserEnabled: boolean;
  browserHeadless: boolean;
  browserIsolated: boolean;
  browserUseExtension: boolean;
  browserExtensionToken: string;
  desktopEnabled: boolean;
  desktopAppiumUrl: string;
}

const PLAYWRIGHT_MCP_EXTENSION_URL = 'https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm';

function sanitizeExecArgv(execArgv: string[]): string[] {
  return execArgv.filter(arg => !/^--inspect(?:-brk)?(?:=.*)?$/.test(arg));
}

function resolveCurrentProcessCommand(runtime: McpServerRuntimeInfo): { command: string; args: string[] } | null {
  const entryScript = runtime.argv[1] ? path.resolve(runtime.argv[1]) : '';
  const base = path.basename(entryScript).toLowerCase();
  if (!entryScript || !fs.existsSync(entryScript)) return null;
  if (base !== 'cli.js' && base !== 'cli.ts') return null;
  return {
    command: runtime.execPath,
    args: [...sanitizeExecArgv(runtime.execArgv), entryScript, '--mcp-serve'],
  };
}

export function resolveMcpServerCommand(runtime: McpServerRuntimeInfo = {
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  moduleUrl: import.meta.url,
}): { command: string; args: string[] } {
  const currentProcess = resolveCurrentProcessCommand(runtime);
  if (currentProcess) return currentProcess;

  // Try to find the compiled JS file in the same directory as this module
  const thisDir = path.dirname(fileURLToPath(runtime.moduleUrl));
  const serverScript = path.join(thisDir, 'mcp-session-server.js');
  if (fs.existsSync(serverScript)) {
    return { command: 'node', args: [serverScript] };
  }
  // Fallback: use pikiclaw CLI with --mcp-serve flag
  const cliScript = path.join(thisDir, 'cli.js');
  if (fs.existsSync(cliScript)) {
    return { command: 'node', args: [cliScript, '--mcp-serve'] };
  }
  // Last resort: assume pikiclaw is in PATH
  return { command: 'pikiclaw', args: ['--mcp-serve'] };
}

function parseOptionalBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text) return null;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return null;
}

function boolFromConfigEnv(configValue: unknown, envValue: unknown, fallback: boolean): boolean {
  const envParsed = parseOptionalBool(envValue);
  if (envParsed != null) return envParsed;
  const configParsed = parseOptionalBool(configValue);
  if (configParsed != null) return configParsed;
  return fallback;
}

export function resolveGuiIntegrationConfig(
  config = loadUserConfig(),
  env: Record<string, string | undefined> = process.env,
): GuiIntegrationConfig {
  return {
    browserEnabled: boolFromConfigEnv(config.browserGuiEnabled, env.PIKICLAW_BROWSER_GUI, true),
    browserHeadless: boolFromConfigEnv(config.browserGuiHeadless, env.PIKICLAW_BROWSER_HEADLESS, false),
    browserIsolated: boolFromConfigEnv(config.browserGuiIsolated, env.PIKICLAW_BROWSER_ISOLATED, false),
    browserUseExtension: boolFromConfigEnv(config.browserGuiUseExtension, env.PIKICLAW_BROWSER_USE_EXTENSION, true),
    browserExtensionToken: String(env.PLAYWRIGHT_MCP_EXTENSION_TOKEN || config.browserGuiExtensionToken || '').trim(),
    desktopEnabled: boolFromConfigEnv(config.desktopGuiEnabled, env.PIKICLAW_DESKTOP_GUI, process.platform === 'darwin'),
    desktopAppiumUrl: String(env.PIKICLAW_DESKTOP_APPIUM_URL || config.desktopAppiumUrl || 'http://127.0.0.1:4723').trim() || 'http://127.0.0.1:4723',
  };
}

export function buildSupplementalMcpServers(gui: GuiIntegrationConfig = resolveGuiIntegrationConfig()): RegisteredMcpServer[] {
  const servers: RegisteredMcpServer[] = [];
  if (gui.browserEnabled) {
    // In extension mode, skip browser integration if no token is configured —
    // without a token, each connection requires a manual browser authorization
    // click that remote users cannot perform.
    if (gui.browserUseExtension && !gui.browserExtensionToken) {
      // Silently skip — the dashboard Extensions section will show "Token required".
    } else {
      const args = ['-y', '@playwright/mcp@latest'];
      if (gui.browserUseExtension) {
        args.push('--extension');
      } else {
        if (gui.browserHeadless) args.push('--headless');
        if (gui.browserIsolated) args.push('--isolated');
      }
      servers.push({
        name: 'pikiclaw-browser',
        command: 'npx',
        args,
        env: gui.browserUseExtension && gui.browserExtensionToken
          ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: gui.browserExtensionToken }
          : undefined,
      });
    }
  }
  return servers;
}

export function buildGuiSetupHints(gui: GuiIntegrationConfig = resolveGuiIntegrationConfig()): string[] {
  const hints: string[] = [];
  if (!gui.browserEnabled || !gui.browserUseExtension) return hints;

  hints.push(
    `browser extension mode enabled; install Playwright MCP Bridge in the current Chrome profile first: ${PLAYWRIGHT_MCP_EXTENSION_URL}`,
  );
  if (!gui.browserExtensionToken) {
    hints.push(
      'after installing the extension, open its UI to copy PLAYWRIGHT_MCP_EXTENSION_TOKEN if you want to skip the browser approval prompt',
    );
  }
  return hints;
}

function buildClaudeMcpConfig(servers: RegisteredMcpServer[]) {
  return {
    mcpServers: Object.fromEntries(servers.map(server => [
      server.name,
      { type: 'stdio', command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}) },
    ])),
  };
}

function buildGeminiMcpConfig(servers: RegisteredMcpServer[]) {
  return {
    mcpServers: Object.fromEntries(servers.map(server => [
      server.name,
      { command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}), trust: true },
    ])),
  };
}

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
const SEND_FILE_TIMEOUT_MS = 60_000; // 60s timeout for sendFile callback
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isPhotoFile(filePath: string): boolean {
  return PHOTO_EXTS.has(path.extname(filePath).toLowerCase());
}

/** Check if realFile is inside any of the allowed root directories. */
function isInsideAllowedRoot(realFile: string, allowedRoots: string[]): boolean {
  for (const root of allowedRoots) {
    try {
      const realRoot = fs.realpathSync(root);
      const rel = path.relative(realRoot, realFile);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    } catch { /* root doesn't exist, skip */ }
  }
  return false;
}

export function resolveSendFilePath(
  inputPath: string,
  workspacePath: string,
  stagedFiles: string[] = [],
  workdir?: string,
): { path: string | null; error?: string } {
  const requested = String(inputPath || '').trim();
  if (!requested) return { path: null, error: 'path is required' };
  if (path.isAbsolute(requested)) return { path: requested };

  const roots = {
    workspace: path.resolve(workspacePath),
    workdir: workdir ? path.resolve(workdir) : '',
    tmp: path.resolve(os.tmpdir()),
  };

  const aliasPrefixes: Array<{ prefix: string; root: string }> = [
    { prefix: '@workspace/', root: roots.workspace },
    { prefix: 'workspace:', root: roots.workspace },
    { prefix: 'ws:', root: roots.workspace },
    ...(roots.workdir ? [
      { prefix: '@workdir/', root: roots.workdir },
      { prefix: 'workdir:', root: roots.workdir },
      { prefix: 'wd:', root: roots.workdir },
    ] : []),
    { prefix: '@tmp/', root: roots.tmp },
    { prefix: 'tmp:', root: roots.tmp },
  ];

  for (const { prefix, root } of aliasPrefixes) {
    if (!requested.startsWith(prefix)) continue;
    const suffix = requested.slice(prefix.length).trim();
    return { path: suffix ? path.resolve(root, suffix) : root };
  }

  const candidates = [
    path.resolve(roots.workspace, requested),
    ...(roots.workdir ? [path.resolve(roots.workdir, requested)] : []),
  ];

  for (const candidate of candidates) {
    try {
      fs.realpathSync(candidate);
      return { path: candidate };
    } catch {
      // Try next candidate.
    }
  }

  if (!requested.includes('/') && !requested.includes(path.sep)) {
    const basenameMatches = new Map<string, string>();
    const dedupedMatches: string[] = [];
    const addMatch = (candidate: string) => {
      const key = path.resolve(candidate);
      if (basenameMatches.has(key)) return;
      basenameMatches.set(key, key);
      dedupedMatches.push(key);
    };

    try {
      const tmpCandidate = path.join(roots.tmp, requested);
      if (fs.existsSync(tmpCandidate)) addMatch(tmpCandidate);
    } catch {}

    for (const relPath of stagedFiles) {
      if (path.basename(relPath) !== requested) continue;
      addMatch(path.join(roots.workspace, relPath));
    }

    if (dedupedMatches.length === 1) return { path: dedupedMatches[0] };
    if (dedupedMatches.length > 1) {
      return {
        path: null,
        error: `ambiguous file name "${requested}"; use @workspace/..., @workdir/..., or @tmp/...`,
      };
    }
  }

  return {
    path: candidates[0] || null,
    error: `file not found: ${requested}; try @workspace/..., @workdir/..., @tmp/..., or a unique filename`,
  };
}

export async function startMcpBridge(opts: McpBridgeOpts): Promise<McpBridgeHandle> {
  const { sessionDir, workspacePath, stagedFiles, sendFile } = opts;
  let hadActivity = false;
  const gui = resolveGuiIntegrationConfig();
  for (const hint of buildGuiSetupHints(gui)) opts.onLog?.(hint);

  // Build allowed roots: workspace + workdir + /tmp
  const allowedRoots = [workspacePath];
  if (opts.workdir) allowedRoots.push(opts.workdir);
  allowedRoots.push('/tmp', os.tmpdir());

  // ── HTTP callback server ──
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/send-file' && req.url !== '/log')) {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });

    // Timeout for receiving the request body
    const bodyTimer = setTimeout(() => {
      req.destroy(new Error('request body timeout'));
    }, 10_000);

    req.on('end', async () => {
      clearTimeout(bodyTimer);
      try {
        if (req.url === '/log') {
          const data = JSON.parse(body || '{}');
          const message = typeof data.message === 'string' ? data.message.trim() : '';
          if (message) {
            hadActivity = true;
            opts.onLog?.(message);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        const data = JSON.parse(body);
        const relPath = String(data.path || '').trim();
        if (!relPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'path is required' }));
          return;
        }

        // Resolve and validate path
        const resolved = resolveSendFilePath(relPath, workspacePath, stagedFiles, opts.workdir);
        const absPath = resolved.path;
        let realFile: string;
        try { realFile = fs.realpathSync(String(absPath || '')); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: resolved.error || `file not found: ${relPath}` }));
          return;
        }
        if (!isInsideAllowedRoot(realFile, allowedRoots)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'file must be inside the workspace, workdir, or /tmp' }));
          return;
        }

        // Size check
        const stat = fs.statSync(realFile);
        if (!stat.isFile()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not a regular file' }));
          return;
        }
        if (stat.size > ARTIFACT_MAX_BYTES) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `file too large (${stat.size} bytes, max ${ARTIFACT_MAX_BYTES})` }));
          return;
        }

        // Auto-detect kind
        const kind = data.kind === 'photo' ? 'photo'
          : data.kind === 'document' ? 'document'
          : isPhotoFile(realFile) ? 'photo'
          : 'document';

        const caption = typeof data.caption === 'string' ? data.caption.trim().slice(0, 1024) || undefined : undefined;
        hadActivity = true;

        const result = await Promise.race([
          sendFile(realFile, { caption, kind }),
          new Promise<McpSendFileResult>((_, reject) =>
            setTimeout(() => reject(new Error(`sendFile timed out after ${SEND_FILE_TIMEOUT_MS / 1000}s`)), SEND_FILE_TIMEOUT_MS),
          ),
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e?.message || 'internal error' }));
      }
    });
  });

  // Set server-level timeouts to prevent hanging connections
  server.requestTimeout = 90_000;   // 90s max for entire request lifecycle
  server.headersTimeout = 10_000;   // 10s to receive headers

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  // ── Register MCP server with the agent ──
  const { command, args } = resolveMcpServerCommand();
  const envVars = {
    MCP_WORKSPACE_PATH: workspacePath,
    MCP_WORKDIR: opts.workdir || '',
    MCP_STAGED_FILES: JSON.stringify(stagedFiles),
    MCP_CALLBACK_URL: `http://127.0.0.1:${port}`,
    MCP_LOG_URL: `http://127.0.0.1:${port}/log`,
    PIKICLAW_DESKTOP_GUI: String(gui.desktopEnabled),
    PIKICLAW_DESKTOP_APPIUM_URL: gui.desktopAppiumUrl,
  };
  const servers: RegisteredMcpServer[] = [
    { name: 'pikiclaw', command, args, env: envVars },
    ...buildSupplementalMcpServers(gui),
  ];

  let configPath = '';
  let extraEnv: Record<string, string> | undefined;
  const codexRegisteredNames: string[] = [];

  if (opts.agent === 'codex') {
    // Codex: register MCP servers via `codex mcp add/remove`
    for (const server of servers) {
      const codexArgs = ['mcp', 'add', server.name];
      for (const [k, v] of Object.entries(server.env || {})) codexArgs.push('--env', `${k}=${v}`);
      codexArgs.push('--', server.command, ...server.args);
      try {
        execFileSync('codex', codexArgs, { stdio: 'pipe', timeout: 10_000 });
        codexRegisteredNames.push(server.name);
      } catch {
        try { execFileSync('codex', ['mcp', 'remove', server.name], { stdio: 'pipe', timeout: 5_000 }); } catch {}
        execFileSync('codex', codexArgs, { stdio: 'pipe', timeout: 10_000 });
        codexRegisteredNames.push(server.name);
      }
    }
  } else if (opts.agent === 'gemini') {
    // Gemini CLI 0.32+ loads MCP servers from settings.json rather than --mcp-config.
    configPath = path.join(sessionDir, 'gemini-system-settings.json');
    const config = buildGeminiMcpConfig(servers);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    extraEnv = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: configPath };
  } else {
    // Claude: write MCP config JSON for --mcp-config
    configPath = path.join(sessionDir, 'mcp-config.json');
    const config = buildClaudeMcpConfig(servers);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  return {
    configPath,
    extraEnv,
    hadActivity: () => hadActivity,
    stop: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const name of [...codexRegisteredNames].reverse()) {
        try { execFileSync('codex', ['mcp', 'remove', name], { stdio: 'pipe', timeout: 5_000 }); } catch {}
      }
      if (configPath) {
        try { fs.rmSync(configPath, { force: true }); } catch {}
      }
    },
  };
}
