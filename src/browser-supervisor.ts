/**
 * Process-level singleton supervisor for the managed browser.
 *
 * Owns the lifecycle decisions for the managed Chrome instance so that all
 * agent streams in this pikiclaw process share one browser. Replaces the old
 * per-stream `prepareManagedBrowserForAutomation` call inside the MCP bridge,
 * which was relaunching Chrome at the start of every task.
 *
 * Three operations:
 *   - probe(): non-launching health check; returns the current CDP endpoint
 *     iff a managed Chrome is already reachable.
 *   - ensure(): idempotent prepare with singleflight; launches Chrome only
 *     when no healthy instance is reachable. Caches the result for re-use
 *     across streams.
 *   - invalidate(): drop the cache after a confirmed downstream failure
 *     (e.g. CDP socket closed mid-stream).
 */

import {
  forceCloseManagedBrowser,
  getManagedBrowserProfileDir,
  prepareManagedBrowserForAutomation,
} from './browser-profile.js';
import { writeScopedLog } from './core/logging.js';

export type ManagedBrowserConnectionMode = 'attach' | 'launch' | 'unavailable';

export interface ManagedBrowserSnapshot {
  cdpEndpoint: string | null;
  connectionMode: ManagedBrowserConnectionMode;
}

export interface EnsureManagedBrowserOptions {
  headless?: boolean;
  /** Skip the cache and re-prepare unconditionally. */
  force?: boolean;
}

interface CachedState {
  cdpEndpoint: string | null;
  connectionMode: ManagedBrowserConnectionMode;
  validatedAt: number;
}

const HEALTH_CACHE_MS = 30_000;
const CDP_PROBE_TIMEOUT_MS = 1_500;

let cached: CachedState | null = null;
let inflight: Promise<ManagedBrowserSnapshot> | null = null;

function log(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): void {
  writeScopedLog('browser-supervisor', message, { level, stream: 'stderr' });
}

function snapshotFromCache(state: CachedState): ManagedBrowserSnapshot {
  return { cdpEndpoint: state.cdpEndpoint, connectionMode: state.connectionMode };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Two-stage health check.
 *
 * Stage 1 (`/json/version`) hits Chrome's static info handler — confirms the
 * process is alive and the debug HTTP server is bound. Stage 2 (`/json`) reads
 * from the target manager, exercising the CDP dispatch loop. Chrome can end up
 * in a state where stage 1 still answers but stage 2 hangs, typically after
 * many stale CDP sessions accumulate; treating stage-1-only responses as
 * healthy lets that state poison every subsequent agent run.
 *
 * Both stages share the same `CDP_PROBE_TIMEOUT_MS`. This probe does NOT catch
 * the case where stage 2 succeeds but the *first page target* is itself stuck
 * (e.g. a heavy SPA frozen mid-init); that has to be handled reactively from
 * the MCP-tool-error path.
 */
async function pingCdpEndpoint(endpoint: string): Promise<boolean> {
  if (!endpoint) return false;
  const versionResp = await fetchWithTimeout(`${endpoint}/json/version`, CDP_PROBE_TIMEOUT_MS);
  if (!versionResp || !versionResp.ok) return false;
  const versionPayload = await versionResp.json().catch(() => null) as { webSocketDebuggerUrl?: unknown } | null;
  if (typeof versionPayload?.webSocketDebuggerUrl !== 'string') return false;
  const targetsResp = await fetchWithTimeout(`${endpoint}/json`, CDP_PROBE_TIMEOUT_MS);
  if (!targetsResp || !targetsResp.ok) return false;
  const targets = await targetsResp.json().catch(() => null);
  return Array.isArray(targets);
}

async function freshenCacheIfPossible(now: number): Promise<ManagedBrowserSnapshot | null> {
  if (!cached?.cdpEndpoint) return null;
  if (now - cached.validatedAt < HEALTH_CACHE_MS) return snapshotFromCache(cached);
  const healthy = await pingCdpEndpoint(cached.cdpEndpoint);
  if (healthy) {
    cached.validatedAt = now;
    return snapshotFromCache(cached);
  }
  log(`cached endpoint ${cached.cdpEndpoint} no longer reachable; clearing cache`, 'warn');
  cached = null;
  return null;
}

/**
 * Non-launching probe. Returns the current CDP endpoint iff a managed Chrome
 * is already reachable. Never starts a new Chrome process.
 */
export async function probeManagedBrowser(): Promise<ManagedBrowserSnapshot> {
  const fresh = await freshenCacheIfPossible(Date.now());
  if (fresh) return fresh;
  return { cdpEndpoint: null, connectionMode: 'unavailable' };
}

/**
 * Idempotent prepare. Returns a healthy CDP endpoint, launching Chrome only
 * when no reachable managed instance is available. Concurrent callers share
 * one in-flight preparation promise (singleflight).
 */
export async function ensureManagedBrowser(
  opts: EnsureManagedBrowserOptions = {},
): Promise<ManagedBrowserSnapshot> {
  const { headless = false, force = false } = opts;
  const now = Date.now();

  if (!force) {
    const fresh = await freshenCacheIfPossible(now);
    if (fresh) return fresh;
  }

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const result = await prepareManagedBrowserForAutomation(
        getManagedBrowserProfileDir(),
        { headless },
      );
      const state: CachedState = {
        cdpEndpoint: result.cdpEndpoint,
        connectionMode: result.cdpEndpoint ? result.connectionMode : 'unavailable',
        validatedAt: Date.now(),
      };
      if (state.cdpEndpoint) {
        cached = state;
        log(`prepared managed browser: mode=${state.connectionMode} endpoint=${state.cdpEndpoint}`);
      } else {
        cached = null;
        log(`managed browser unavailable (mode=${result.connectionMode}); will fall back to upstream-managed launch`, 'warn');
      }
      return snapshotFromCache(state);
    } catch (err: any) {
      cached = null;
      log(`ensure failed: ${err?.message || err}`, 'error');
      return { cdpEndpoint: null, connectionMode: 'unavailable' };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

const RESTART_COOLDOWN_MS = 30_000;
let lastRestartAt = 0;
let restartInflight: Promise<void> | null = null;

/**
 * Reactive recovery for a confirmed CDP-layer failure: drops the supervisor
 * cache, SIGKILLs Chrome, wipes session-restore. The next `ensureManagedBrowser`
 * will detect no CDP endpoint and relaunch Chrome cold.
 *
 * The current stream is not rescued — its MCP child has already lost stdio,
 * and Claude CLI's MCP client won't reconnect mid-tool-call. The benefit lands
 * on the next agent turn, which will attach to a fresh browser instead of
 * inheriting the wedged one.
 *
 * Cooldown-throttled and singleflight: a single agent run can spit many
 * "Connection closed" lines as the MCP child stays dead; we only act once.
 */
export function restartManagedBrowser(reason: string): Promise<void> {
  const now = Date.now();
  if (restartInflight) return restartInflight;
  if (now - lastRestartAt < RESTART_COOLDOWN_MS) {
    log(`restart skipped (within ${RESTART_COOLDOWN_MS / 1000}s cooldown): ${reason}`, 'debug');
    return Promise.resolve();
  }
  lastRestartAt = now;
  log(`restarting managed browser: ${reason}`, 'warn');
  restartInflight = (async () => {
    try {
      cached = null;
      const killed = await forceCloseManagedBrowser();
      log(`forced close complete; killed pids=[${killed.join(',')}]`);
    } catch (err: any) {
      log(`force-close failed: ${err?.message || err}`, 'error');
    } finally {
      restartInflight = null;
    }
  })();
  return restartInflight;
}

/** Drop any cached endpoint, e.g. after a confirmed CDP failure mid-stream. */
export function invalidateManagedBrowser(): void {
  if (cached) log(`invalidating cached endpoint ${cached.cdpEndpoint}`);
  cached = null;
}

/** Synchronous accessor for the cached endpoint without any I/O. */
export function getCachedManagedBrowserEndpoint(): string | null {
  return cached?.cdpEndpoint || null;
}

/** Test-only: reset module state. */
export function _resetManagedBrowserSupervisor(): void {
  cached = null;
  inflight = null;
  lastRestartAt = 0;
  restartInflight = null;
}
