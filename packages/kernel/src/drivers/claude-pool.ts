import type { ChildProcess } from 'node:child_process';
import { reapChild } from './shared.js';

// ── Warm Claude process pool ─────────────────────────────────────────────────────────
// A `claude -p --input-format stream-json` process stays alive after `result` for as long
// as its stdin is open, and a user message written to that stdin runs a NEW turn in the
// same conversation (the steer path has always relied on this). Every cold spawn costs
// ~4s of CLI init before the first model request — the single largest local overhead of a
// Claude turn — so after a clean settle the driver parks the process here instead of
// killing it, and the session's next continuation turn skips the spawn entirely.
//
// Discipline (mirrors mirasim's Codex warm pool):
//  - keyed by native session id; one process per session, serial turns only.
//  - a process is reused only when its spawn-time fingerprint (model/effort/workdir/…)
//    still matches what a cold spawn would use; any drift destroys it and goes cold.
//  - idle processes are destroyed after a TTL; the pool is size-capped (oldest-idle out).
//  - only CLEAN settles pool (no error / abort / timeout / background hold); everything
//    else keeps today's kill semantics, so pooling can never leak a wedged process.

// Idle TTL before a parked process is destroyed. Override with PIKILOOM_CLAUDE_WARM_IDLE_MS.
const CLAUDE_WARM_IDLE_TTL_DEFAULT_MS = 10 * 60_000;
export function claudeWarmIdleTtlMs(): number {
  const raw = Number(process.env.PIKILOOM_CLAUDE_WARM_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CLAUDE_WARM_IDLE_TTL_DEFAULT_MS;
}
// Max parked processes (each holds a full CLI + its MCP servers — roughly 0.5–1 GB).
// Override with PIKILOOM_CLAUDE_WARM_MAX.
const CLAUDE_WARM_MAX_DEFAULT = 4;
export function claudeWarmMaxProcesses(): number {
  const raw = Number(process.env.PIKILOOM_CLAUDE_WARM_MAX);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : CLAUDE_WARM_MAX_DEFAULT;
}
// After ending a parked process's stdin, escalate to SIGTERM only if it hasn't exited on its
// own within this window — same leak-guard shape as a graceful turn settle.
const CLAUDE_WARM_DESTROY_GUARD_MS = 15_000;

interface ParkedClaude {
  child: ChildProcess;
  fingerprint: string;
  parkedAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
  onClose: () => void;
  drain: () => void;
}

/** End a no-longer-poolable process the same way a graceful settle does. */
function destroyClaudeChild(child: ChildProcess): void {
  reapChild(child, { graceMs: CLAUDE_WARM_DESTROY_GUARD_MS });
}

export class ClaudeWarmPool {
  private readonly parked = new Map<string, ParkedClaude>();

  size(): number {
    return this.parked.size;
  }

  /**
   * Reclaim the parked process for `sessionId`, or null when there is none, it died while
   * parked, or its spawn fingerprint no longer matches (that entry is destroyed — the turn
   * must go cold so the new model/effort/config actually applies).
   */
  take(sessionId: string, fingerprint: string): ChildProcess | null {
    const entry = this.parked.get(sessionId);
    if (!entry) return null;
    this.unpark(sessionId, entry);
    if (entry.child.exitCode != null || entry.child.killed) return null;
    if (entry.fingerprint !== fingerprint) {
      destroyClaudeChild(entry.child);
      return null;
    }
    return entry.child;
  }

  /** Park a process after a clean settle. The caller has already detached its turn listeners. */
  put(sessionId: string, fingerprint: string, child: ChildProcess): void {
    if (child.exitCode != null || child.killed || !child.stdin || child.stdin.destroyed) {
      destroyClaudeChild(child);
      return;
    }
    this.evictSession(sessionId); // never two processes for one session
    while (this.parked.size >= Math.max(claudeWarmMaxProcesses(), 0)) {
      const oldest = [...this.parked.entries()].sort((a, b) => a[1].parkedAt - b[1].parkedAt)[0];
      if (!oldest) break;
      this.evictSession(oldest[0]);
    }
    if (claudeWarmMaxProcesses() <= 0) {
      destroyClaudeChild(child);
      return;
    }
    const onClose = () => {
      const cur = this.parked.get(sessionId);
      if (cur?.child === child) { this.unpark(sessionId, cur); }
    };
    // Keep both pipes flowing while parked so the CLI can never block on a full pipe.
    const drain = () => { /* discard between-turn chatter */ };
    child.stdout?.on('data', drain);
    child.stderr?.on('data', drain);
    child.on('close', onClose);
    const idleTimer = setTimeout(() => {
      const cur = this.parked.get(sessionId);
      if (cur?.child === child) this.evictSession(sessionId);
    }, claudeWarmIdleTtlMs());
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
    this.parked.set(sessionId, { child, fingerprint, parkedAt: Date.now(), idleTimer, onClose, drain });
  }

  /** Destroy the parked process for a session (rewind made its in-memory context stale, TTL, cap). */
  evictSession(sessionId: string): void {
    const entry = this.parked.get(sessionId);
    if (!entry) return;
    this.unpark(sessionId, entry);
    destroyClaudeChild(entry.child);
  }

  dispose(): void {
    for (const sessionId of [...this.parked.keys()]) this.evictSession(sessionId);
  }

  /** Remove bookkeeping without deciding the child's fate. */
  private unpark(sessionId: string, entry: ParkedClaude): void {
    clearTimeout(entry.idleTimer);
    entry.child.stdout?.off('data', entry.drain);
    entry.child.stderr?.off('data', entry.drain);
    entry.child.off('close', entry.onClose);
    this.parked.delete(sessionId);
  }
}
