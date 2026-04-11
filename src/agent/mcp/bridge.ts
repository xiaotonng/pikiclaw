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
import {
  getManagedBrowserProfileDir,
  prepareManagedBrowserForAutomation,
} from '../../browser-profile.js';
import { loadUserConfig } from '../../core/config/user-config.js';
import { MCP_TIMEOUTS, MCP_ARTIFACT_MAX_BYTES } from '../../core/constants.js';

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
  browserProfileDir: string;
  browserHeadless: boolean;
  desktopEnabled: boolean;
  desktopAppiumUrl: string;
}

interface BrowserRegistrationRuntime {
  cdpEndpoint?: string | null;
}

function sanitizeExecArgv(execArgv: string[]): string[] {
  return execArgv.filter(arg => !/^--inspect(?:-brk)?(?:=.*)?$/.test(arg));
}

function resolveCurrentCliCommand(
  runtime: McpServerRuntimeInfo,
  extraArgs: string[],
): { command: string; args: string[] } | null {
  const entryScript = runtime.argv[1] ? path.resolve(runtime.argv[1]) : '';
  const base = path.basename(entryScript).toLowerCase();
  if (!entryScript || !fs.existsSync(entryScript)) return null;
  if (base !== 'main.js' && base !== 'main.ts' && base !== 'cli.js' && base !== 'cli.ts') return null;
  return {
    command: runtime.execPath,
    args: [...sanitizeExecArgv(runtime.execArgv), entryScript, ...extraArgs],
  };
}

export function resolveMcpServerCommand(runtime: McpServerRuntimeInfo = {
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  moduleUrl: import.meta.url,
}): { command: string; args: string[] } {
  const currentProcess = resolveCurrentCliCommand(runtime, ['--mcp-serve']);
  if (currentProcess) return currentProcess;

  // Try to find the compiled JS file in the same directory as this module
  const thisDir = path.dirname(fileURLToPath(runtime.moduleUrl));
  const serverScript = path.join(thisDir, 'session-server.js');
  if (fs.existsSync(serverScript)) {
    return { command: 'node', args: [serverScript] };
  }
  // Fallback: use pikiclaw CLI with --mcp-serve flag
  const cliScript = path.resolve(thisDir, '../../cli/main.js');
  if (fs.existsSync(cliScript)) {
    return { command: 'node', args: [cliScript, '--mcp-serve'] };
  }
  // Last resort: assume pikiclaw is in PATH
  return { command: 'pikiclaw', args: ['--mcp-serve'] };
}

export function resolvePlaywrightMcpProxyCommand(runtime: McpServerRuntimeInfo = {
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  moduleUrl: import.meta.url,
}): { command: string; args: string[] } {
  const currentProcess = resolveCurrentCliCommand(runtime, ['--playwright-mcp-proxy']);
  if (currentProcess) return currentProcess;

  const thisDir = path.dirname(fileURLToPath(runtime.moduleUrl));
  const proxyScript = path.join(thisDir, 'playwright-proxy.js');
  if (fs.existsSync(proxyScript)) {
    return { command: 'node', args: [proxyScript] };
  }
  const cliScript = path.resolve(thisDir, '../../cli/main.js');
  if (fs.existsSync(cliScript)) {
    return { command: 'node', args: [cliScript, '--playwright-mcp-proxy'] };
  }
  return { command: 'pikiclaw', args: ['--playwright-mcp-proxy'] };
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
  const browserEnabled = boolFromConfigEnv(
    typeof config.browserEnabled === 'boolean' ? config.browserEnabled : (config as Record<string, unknown>).browserUseProfile,
    env.PIKICLAW_BROWSER_ENABLED ?? env.PIKICLAW_BROWSER_USE_PROFILE,
    false,
  );
  return {
    browserEnabled,
    browserProfileDir: getManagedBrowserProfileDir(),
    browserHeadless: boolFromConfigEnv(config.browserHeadless, env.PIKICLAW_BROWSER_HEADLESS, false),
    desktopEnabled: boolFromConfigEnv(config.desktopGuiEnabled, env.PIKICLAW_DESKTOP_GUI, process.platform === 'darwin'),
    desktopAppiumUrl: String(env.PIKICLAW_DESKTOP_APPIUM_URL || config.desktopAppiumUrl || 'http://127.0.0.1:4723').trim() || 'http://127.0.0.1:4723',
  };
}

export function buildSupplementalMcpServers(
  gui: GuiIntegrationConfig = resolveGuiIntegrationConfig(),
  runtime: BrowserRegistrationRuntime = {},
): RegisteredMcpServer[] {
  if (!gui.browserEnabled) return [];
  const profileDir = gui.browserProfileDir || getManagedBrowserProfileDir();
  const browserServer = resolvePlaywrightMcpProxyCommand();
  const cdpEndpoint = runtime.cdpEndpoint || '';
  return [{
    name: 'pikiclaw-browser',
    command: browserServer.command,
    args: browserServer.args,
    env: {
      PIKICLAW_PLAYWRIGHT_PROFILE_DIR: profileDir,
      PIKICLAW_PLAYWRIGHT_HEADLESS: String(gui.browserHeadless),
      ...(cdpEndpoint ? { PIKICLAW_PLAYWRIGHT_CDP_ENDPOINT: cdpEndpoint } : {}),
    },
  }];
}

export function buildGuiSetupHints(gui: GuiIntegrationConfig = resolveGuiIntegrationConfig()): string[] {
  if (!gui.browserEnabled) return [];
  return [
    `managed browser profile mode enabled; runtime sessions reuse ${gui.browserProfileDir || getManagedBrowserProfileDir()}; configured MCP browser mode=${gui.browserHeadless ? 'headless' : 'headed'}. This mode keeps automation isolated from your everyday browser. If the managed browser is already open, pikiclaw will try to attach to it first. When using browser_tabs, use action="new" to open a tab, not "create".`,
  ];
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
    // Session attachments live under .pikiclaw/... and should remain readable to
    // Gemini's built-in file tools even when the project ignores that directory.
    fileFiltering: {
      respectGitIgnore: false,
      respectGeminiIgnore: false,
    },
    mcpServers: Object.fromEntries(servers.map(server => [
      server.name,
      { command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}), trust: true },
    ])),
  };
}

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

const ARTIFACT_MAX_BYTES = MCP_ARTIFACT_MAX_BYTES;
const SEND_FILE_TIMEOUT_MS = MCP_TIMEOUTS.sendFile;
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
  const browserRuntime: BrowserRegistrationRuntime = {};
  if (gui.browserEnabled) {
    const preparedBrowser = await prepareManagedBrowserForAutomation(
      gui.browserProfileDir || getManagedBrowserProfileDir(),
      { headless: gui.browserHeadless },
    );
    if (preparedBrowser.connectionMode === 'attach' && preparedBrowser.cdpEndpoint) {
      opts.onLog?.(`reusing managed browser process via CDP at ${preparedBrowser.cdpEndpoint}.`);
    } else if (preparedBrowser.closedPids.length) {
      opts.onLog?.(
        `closed managed browser setup process${preparedBrowser.closedPids.length > 1 ? 'es' : ''} (${preparedBrowser.closedPids.join(', ')}) before starting browser automation.`,
      );
    }
    browserRuntime.cdpEndpoint = preparedBrowser.cdpEndpoint;
    opts.onLog?.(`browser MCP registration mode=${preparedBrowser.connectionMode === 'attach' ? 'attach' : (gui.browserHeadless ? 'headless' : 'launch')}.`);
    for (const hint of buildGuiSetupHints(gui)) opts.onLog?.(hint);
  }

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
    }, MCP_TIMEOUTS.requestBody);

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
  server.requestTimeout = MCP_TIMEOUTS.serverRequest;
  server.headersTimeout = MCP_TIMEOUTS.serverHeaders;

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
    ...buildSupplementalMcpServers(gui, browserRuntime),
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
        execFileSync('codex', codexArgs, { stdio: 'pipe', timeout: MCP_TIMEOUTS.codexMcpAdd });
        codexRegisteredNames.push(server.name);
      } catch {
        try { execFileSync('codex', ['mcp', 'remove', server.name], { stdio: 'pipe', timeout: MCP_TIMEOUTS.codexMcpRemove }); } catch {}
        execFileSync('codex', codexArgs, { stdio: 'pipe', timeout: MCP_TIMEOUTS.codexMcpAdd });
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
    const bridgeConfig = buildClaudeMcpConfig(servers);
    const mergedServers: Record<string, any> = {};

    // Discover and merge existing MCP configs (project-local, then user-global)
    for (const candidate of [
      path.join(opts.workdir || '', '.mcp.json'),
      path.join(opts.workdir || '', '.claude', '.mcp.json'),
      path.join(os.homedir(), '.claude', '.mcp.json'),
    ]) {
      try {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.mcpServers) Object.assign(mergedServers, parsed.mcpServers);
      } catch { /* not found or invalid — skip */ }
    }

    // Bridge servers take precedence (overwrite duplicates)
    Object.assign(mergedServers, bridgeConfig.mcpServers);

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: mergedServers }, null, 2));
  }

  return {
    configPath,
    extraEnv,
    hadActivity: () => hadActivity,
    stop: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const name of [...codexRegisteredNames].reverse()) {
        try { execFileSync('codex', ['mcp', 'remove', name], { stdio: 'pipe', timeout: MCP_TIMEOUTS.codexMcpRemove }); } catch {}
      }
      if (configPath) {
        try { fs.rmSync(configPath, { force: true }); } catch {}
      }
    },
  };
}
