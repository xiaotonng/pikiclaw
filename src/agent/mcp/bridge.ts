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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensurePlaywrightMcpConfigFile,
  getManagedBrowserProfileDir,
  resolveManagedBrowserCdpEndpoint,
  resolveManagedBrowserMcpCommand,
} from '../../browser-profile.js';
import { loadUserConfig } from '../../core/config/user-config.js';
import { MCP_TIMEOUTS, MCP_ARTIFACT_MAX_BYTES } from '../../core/constants.js';
import type { AgentInteraction, AgentInteractionQuestion } from '../types.js';
import { mergeExtensionsForSession, getGlobalExtensionsAsServers } from './extensions.js';

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

/** Routes an `im_ask_user` MCP call into the host's human-loop pipeline. */
export type AskUserCallback = (
  request: AgentInteraction,
) => Promise<Record<string, any> | null>;

export interface McpBridgeHandle {
  /** Path to the generated MCP config JSON — pass to agent CLI via --mcp-config. */
  configPath: string;
  /** Extra environment variables required by the target agent to load the config. */
  extraEnv?: Record<string, string>;
  /**
   * Resolved MCP server map (keyed by server name) for drivers that consume
   * a structured list rather than a config-file path (e.g. Hermes ACP).
   */
  mcpServers?: Record<string, any>;
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
  /** Callback invoked when the agent calls the send_file MCP tool. Optional for dashboard sessions. */
  sendFile?: McpSendFileCallback;
  /** Callback for `im_ask_user`. When omitted, the tool isn't registered. */
  onInteraction?: AskUserCallback;
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
  peekabooEnabled: boolean;
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
  const peekabooEnabled = boolFromConfigEnv(
    config.peekabooEnabled,
    env.PIKICLAW_PEEKABOO_ENABLED,
    false,
  );
  return {
    browserEnabled,
    browserProfileDir: getManagedBrowserProfileDir(),
    browserHeadless: boolFromConfigEnv(config.browserHeadless, env.PIKICLAW_BROWSER_HEADLESS, false),
    peekabooEnabled,
  };
}

export interface BrowserSupervisorEndpoints {
  /**
   * CDP endpoint of the managed Chrome (e.g. `http://127.0.0.1:39222`),
   * resolved by the in-process `browser-supervisor`. When provided, the
   * Playwright MCP server runs in attach mode and shares the long-lived
   * managed Chrome across all streams. When null, the Playwright MCP server
   * launches its own browser via `--user-data-dir` (cold-start fallback).
   */
  cdpEndpoint?: string | null;
}

export function buildSupplementalMcpServers(
  gui: GuiIntegrationConfig = resolveGuiIntegrationConfig(),
  endpoints: BrowserSupervisorEndpoints = {},
): RegisteredMcpServer[] {
  const servers: RegisteredMcpServer[] = [];
  if (gui.browserEnabled) {
    const profileDir = gui.browserProfileDir || getManagedBrowserProfileDir();
    const cdpEndpoint = (endpoints.cdpEndpoint || '').trim() || null;
    const browserServer = resolveManagedBrowserMcpCommand(profileDir, {
      headless: gui.browserHeadless,
      cdpEndpoint,
    });
    servers.push({
      name: 'pikiclaw-browser',
      command: browserServer.command,
      args: browserServer.args,
    });
  }
  if (gui.peekabooEnabled && process.platform === 'darwin') {
    // Peekaboo — native macOS GUI automation via Accessibility + ScreenCaptureKit.
    // Run the dedicated MCP bin from the multi-bin @steipete/peekaboo package.
    servers.push({
      name: 'peekaboo',
      command: 'npx',
      args: ['-y', '-p', '@steipete/peekaboo', 'peekaboo-mcp'],
    });
  }
  return servers;
}

export function buildGuiSetupHints(gui: GuiIntegrationConfig = resolveGuiIntegrationConfig()): string[] {
  const hints: string[] = [];
  if (gui.browserEnabled) {
    hints.push(
      `managed browser profile mode enabled; runtime sessions reuse ${gui.browserProfileDir || getManagedBrowserProfileDir()}; configured MCP browser mode=${gui.browserHeadless ? 'headless' : 'headed'}. This mode keeps automation isolated from your everyday browser. If the managed browser is already open, pikiclaw will try to attach to it first. When using browser_tabs, use action="new" to open a tab, not "create".`,
    );
  }
  if (gui.peekabooEnabled && process.platform === 'darwin') {
    hints.push(
      'Peekaboo enabled — native macOS GUI tools (see / click / type / scroll / window / menu / app / dock) via Accessibility + ScreenCaptureKit. Prefer element-ID interactions (call `see` first) over raw coordinates.',
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
// Stale playwright-mcp reaper
// ---------------------------------------------------------------------------

/**
 * Find and SIGTERM playwright-mcp processes that attach to the same managed
 * Chrome CDP endpoint but are NOT descendants of the current pikiclaw process.
 *
 * Background: playwright-mcp is spawned by the agent CLI (e.g. claude) as a
 * child via the mcp-config we write. When the agent CLI is killed ungracefully
 * — or worse, gets reparented to launchd/init and survives across pikiclaw
 * restarts — its playwright-mcp child stays alive too. Multiple playwright-mcp
 * instances attached to the same `--cdp-endpoint` cause backend state
 * confusion (microsoft/playwright-mcp#1299, #893) and manifest as
 * `Connection closed` errors or 2+ minute hangs the next time a tool is
 * called. The community's recommended hygiene is one playwright-mcp per
 * agent instance; this sweeper enforces that by reaping orphans from prior
 * runs at the start of every new bridge.
 *
 * Safety: a candidate is only reaped if its `ppid` chain — walked entirely in
 * memory from a single `ps` snapshot — does NOT include the current pikiclaw
 * process. In-flight playwright-mcp children of THIS pikiclaw (sibling
 * streams) are always spared.
 */
/**
 * Pure matcher for the reaper. Returns true when `command` looks like a
 * playwright-mcp process attached to the same CDP endpoint as ours.
 *
 * Accepts both invocation forms we have seen in the wild:
 *   - `node <path>/@playwright/mcp/cli.js …`   (direct, pikiclaw's preferred)
 *   - `node <path>/node_modules/.bin/playwright-mcp …`   (npm bin symlink,
 *     used by `npx @playwright/mcp` and any agent CLI that resolves via PATH)
 *
 * The CDP endpoint must also appear literally in the argv — without that
 * guard a stray `npm exec @playwright/mcp` with its own browser would be
 * killed, and unrelated `node -e <src>` processes whose inline source happens
 * to mention `@playwright/mcp` would also be misidentified.
 */
export function _matchPlaywrightMcpProcessCommand(
  command: string,
  normalizedCdpEndpoint: string,
): boolean {
  if (!command || !normalizedCdpEndpoint) return false;
  const tokens = command.split(/\s+/);
  if (tokens.length < 2) return false;
  if (!/(?:^|[\\/])node(?:\.exe)?$/.test(tokens[0])) return false;
  const isCliJs = /@playwright[\\/]mcp[\\/]cli\.js$/.test(tokens[1]);
  const isBinSymlink = /[\\/]\.bin[\\/]playwright-mcp(?:\.cmd)?$/.test(tokens[1]);
  if (!isCliJs && !isBinSymlink) return false;
  if (!command.includes(normalizedCdpEndpoint)) return false;
  return true;
}

function reapStalePlaywrightMcpProcesses(
  cdpEndpoint: string,
): { reaped: number[]; spared: number[] } {
  const reaped: number[] = [];
  const spared: number[] = [];
  if (process.platform === 'win32' || !cdpEndpoint) return { reaped, spared };

  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return { reaped, spared };

  const ppidByPid = new Map<number, number>();
  const candidates: number[] = [];
  const normalized = cdpEndpoint.replace(/\/+$/, '');
  const lines = String(result.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    ppidByPid.set(pid, ppid);
    if (pid === process.pid) continue;
    const command = m[3] || '';
    if (!_matchPlaywrightMcpProcessCommand(command, normalized)) continue;
    candidates.push(pid);
  }

  const isOurDescendant = (pid: number): boolean => {
    let cur: number | undefined = pid;
    for (let depth = 0; depth < 30 && cur != null && cur > 1; depth++) {
      if (cur === process.pid) return true;
      cur = ppidByPid.get(cur);
    }
    return false;
  };

  for (const pid of candidates) {
    if (isOurDescendant(pid)) { spared.push(pid); continue; }
    try {
      process.kill(pid, 'SIGTERM');
      reaped.push(pid);
    } catch {
      // Already dead — no-op.
    }
  }
  return { reaped, spared };
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

export async function startMcpBridge(opts: McpBridgeOpts): Promise<McpBridgeHandle | null> {
  const { sessionDir, workspacePath, stagedFiles, sendFile, onInteraction } = opts;
  let hadActivity = false;
  const gui = resolveGuiIntegrationConfig();
  for (const hint of buildGuiSetupHints(gui)) opts.onLog?.(hint);
  // Lazy browser lifecycle: probe an already-running managed Chrome via
  // <profileDir>/DevToolsActivePort and attach if reachable; otherwise leave
  // Chrome unlaunched and let playwright/mcp launch it with `--user-data-dir`
  // on the first browser_* tool call. Previously the bridge eagerly called
  // `ensureManagedBrowser`, which forced a Chrome window to open at every
  // stream start even when the agent never touched the browser.
  let browserCdpEndpoint: string | null = null;
  if (gui.browserEnabled) {
    // Write the playwright/mcp config file (referenced by --config in
    // getManagedBrowserMcpArgs) before the agent CLI spawns playwright/mcp.
    ensurePlaywrightMcpConfigFile();
    browserCdpEndpoint = await resolveManagedBrowserCdpEndpoint(gui.browserProfileDir).catch(() => null);
    if (browserCdpEndpoint) {
      opts.onLog?.(`attaching to existing managed browser at ${browserCdpEndpoint}.`);
      const { reaped, spared } = reapStalePlaywrightMcpProcesses(browserCdpEndpoint);
      if (reaped.length) {
        opts.onLog?.(`reaped ${reaped.length} stale playwright-mcp process(es) attached to ${browserCdpEndpoint}: pid=${reaped.join(',')}${spared.length ? ` (spared in-tree: ${spared.join(',')})` : ''}`);
      }
    } else {
      opts.onLog?.('no managed browser running; playwright/mcp will launch one on first browser_* tool call.');
    }
  }

  // Build allowed roots: workspace + workdir + /tmp
  const allowedRoots = [workspacePath];
  if (opts.workdir) allowedRoots.push(opts.workdir);
  allowedRoots.push('/tmp', os.tmpdir());

  // ── HTTP callback server ──
  // Started only when an IM-side callback is wired up, to serve:
  //   - `im_send_file`  → /send-file
  //   - `im_ask_user`   → /ask-user
  //   - structured tool-activity logging from the in-process MCP server → /log
  let callbackServer: http.Server | null = null;
  let port = 0;
  const needsCallbackServer = !!sendFile || !!onInteraction;

  if (needsCallbackServer) {
    callbackServer = http.createServer((req, res) => {
      const endpoint = req.url || '';
      const known = endpoint === '/send-file' || endpoint === '/log' || endpoint === '/ask-user';
      if (req.method !== 'POST' || !known) {
        res.writeHead(404);
        res.end();
        return;
      }

      // /ask-user blocks until the user replies; disable timeouts for it.
      if (endpoint === '/ask-user') {
        req.setTimeout(0);
        res.setTimeout(0);
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
          if (endpoint === '/log') {
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

          if (endpoint === '/ask-user') {
            if (!onInteraction) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'ask-user is not available for this session' }));
              return;
            }
            const data = JSON.parse(body || '{}');
            const question = typeof data.question === 'string' ? data.question.trim() : '';
            if (!question) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'question is required' }));
              return;
            }
            const header = typeof data.header === 'string' ? data.header.trim() : '';
            const hint = typeof data.hint === 'string' ? data.hint.trim() : '';
            const allowFreeform = data.allowFreeform == null ? true : !!data.allowFreeform;
            const rawOptions = Array.isArray(data.options) ? data.options : [];
            const interactionOptions = rawOptions
              .map((o: any) => {
                const label = typeof o?.label === 'string' ? o.label.trim() : '';
                const description = typeof o?.description === 'string' ? o.description.trim() : '';
                return label ? { label, description: description || null, value: label } : null;
              })
              .filter((o: any): o is { label: string; description: string | null; value: string } => !!o);

            const questionId = 'ask-user';
            const interactionQuestion: AgentInteractionQuestion = {
              id: questionId,
              header: header || 'Question',
              prompt: question,
              options: interactionOptions.length ? interactionOptions : null,
              allowFreeform: interactionOptions.length ? allowFreeform : true,
            };

            const requestId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const interaction: AgentInteraction = {
              kind: 'user-input',
              id: requestId,
              title: header || 'Pikiclaw needs your input',
              hint: hint || null,
              questions: [interactionQuestion],
              resolveWith: (answers) => {
                const values = answers[questionId] || [];
                const text = values.map(v => String(v ?? '').trim()).filter(Boolean).join(' ');
                return { answer: text };
              },
            };

            hadActivity = true;
            try {
              const response = await onInteraction(interaction);
              const answer = typeof (response as any)?.answer === 'string' ? (response as any).answer : '';
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, answer }));
            } catch (askErr: any) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: askErr?.message || 'ask-user cancelled' }));
            }
            return;
          }

          // endpoint === '/send-file'
          if (!sendFile) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'send-file is not available for this session' }));
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

    // Per-request body timers above guard against partial uploads.
    callbackServer.headersTimeout = MCP_TIMEOUTS.serverHeaders;
    // /ask-user can block indefinitely; drop the server-wide request timeout
    // when that endpoint is wired up.
    if (onInteraction) callbackServer.requestTimeout = 0;

    await new Promise<void>((resolve, reject) => {
      callbackServer!.on('error', reject);
      callbackServer!.listen(0, '127.0.0.1', () => resolve());
    });
    port = (callbackServer.address() as { port: number }).port;
  }

  // ── Register MCP server with the agent ──
  const supplementalServers = buildSupplementalMcpServers(gui, { cdpEndpoint: browserCdpEndpoint });
  const servers: RegisteredMcpServer[] = [...supplementalServers];

  // Register the pikiclaw stdio MCP server when any in-process tool needs the
  // callback channel. `MCP_TOOLS_AVAILABLE` tells the server which tool
  // families to advertise.
  if (port && (sendFile || onInteraction)) {
    const { command, args } = resolveMcpServerCommand();
    const enabledTools: string[] = [];
    if (sendFile) enabledTools.push('workspace');
    // Codex has native user-input via JSON-RPC; don't expose `im_ask_user`.
    if (onInteraction && opts.agent !== 'codex') enabledTools.push('ask-user');
    const envVars = {
      MCP_WORKSPACE_PATH: workspacePath,
      MCP_WORKDIR: opts.workdir || '',
      MCP_AGENT: opts.agent || '',
      MCP_STAGED_FILES: JSON.stringify(stagedFiles),
      MCP_CALLBACK_URL: `http://127.0.0.1:${port}`,
      MCP_LOG_URL: `http://127.0.0.1:${port}/log`,
      MCP_TOOLS_AVAILABLE: enabledTools.join(','),
    };
    servers.unshift({ name: 'pikiclaw', command, args, env: envVars });
  }

  // Nothing to register — skip bridge entirely
  if (!servers.length) {
    if (callbackServer) await new Promise<void>(resolve => callbackServer!.close(() => resolve()));
    return null;
  }

  let configPath = '';
  let extraEnv: Record<string, string> | undefined;
  let mcpServers: Record<string, any> | undefined;
  const codexRegisteredNames: string[] = [];

  if (opts.agent === 'codex') {
    // Codex: register MCP servers via `codex mcp add/remove`
    // Include global + workspace extensions alongside built-in servers
    const extServers = getGlobalExtensionsAsServers(opts.workdir);
    const allServers = [...extServers, ...servers];
    for (const server of allServers) {
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
    // Include global + workspace extensions alongside built-in servers
    const extServers = getGlobalExtensionsAsServers(opts.workdir);
    const allServers = [...extServers, ...servers];
    configPath = path.join(sessionDir, 'gemini-system-settings.json');
    const config = buildGeminiMcpConfig(allServers);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    extraEnv = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: configPath };
  } else if (opts.agent === 'hermes') {
    // Hermes consumes structured MCP server objects via ACP `session/new`,
    // not a config file path. Resolve the merged server list and expose it
    // on the bridge handle so the driver can translate to ACP's wire format.
    mcpServers = mergeExtensionsForSession(servers, opts.workdir);
  } else {
    // Claude: write MCP config JSON for --mcp-config
    // Uses centralized merge: global extensions → .mcp.json files → built-in servers
    configPath = path.join(sessionDir, 'mcp-config.json');
    mcpServers = mergeExtensionsForSession(servers, opts.workdir);

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
  }

  return {
    configPath,
    extraEnv,
    mcpServers,
    hadActivity: () => hadActivity,
    stop: async () => {
      if (callbackServer) await new Promise<void>(resolve => callbackServer!.close(() => resolve()));
      for (const name of [...codexRegisteredNames].reverse()) {
        try { execFileSync('codex', ['mcp', 'remove', name], { stdio: 'pipe', timeout: MCP_TIMEOUTS.codexMcpRemove }); } catch {}
      }
      if (configPath) {
        try { fs.rmSync(configPath, { force: true }); } catch {}
      }
    },
  };
}
