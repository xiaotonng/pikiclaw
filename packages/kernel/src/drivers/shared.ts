import type { ChildProcess } from 'node:child_process';

// Driver-internal helpers shared by the concrete drivers (claude/codex/gemini/acp).
// NOT part of the public API — nothing here is re-exported by any barrel. Each helper
// exists because the same code appeared verbatim in 3+ drivers.

/** Stateful newline splitter for a child process' stdout: feed chunks, get complete lines. */
export function createLineBuffer(): (chunk: Buffer | string) => string[] {
  let buf = '';
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    return lines;
  };
}

/** Parse one ndjson line; undefined for blank lines / non-JSON noise. */
export function parseJsonLine(line: string): any | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

/**
 * Run `fn` when the signal aborts (immediately if it already has). Returns an
 * unsubscribe for drivers that must detach the handler when the turn settles.
 */
export function wireAbort(signal: AbortSignal, fn: () => void): () => void {
  if (signal.aborted) { fn(); return () => {}; }
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

/** SIGTERM a child, swallowing the already-dead race. */
export function sigterm(proc: ChildProcess | null | undefined): void {
  try { proc?.kill('SIGTERM'); } catch { /* ignore */ }
}

/** How long a reaped child may take to honour stdin EOF before it earns a SIGTERM.
 *  Override with PIKILOOM_REAP_GRACE_MS. */
const REAP_GRACE_DEFAULT_MS = 15_000;
export function reapGraceMs(): number {
  const raw = Number(process.env.PIKILOOM_REAP_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : REAP_GRACE_DEFAULT_MS;
}
/** How long it may then take to honour SIGTERM before it earns a SIGKILL.
 *  Override with PIKILOOM_REAP_FORCE_MS (tests need a sub-second escalation). */
const REAP_FORCE_DEFAULT_MS = 10_000;
export function reapForceMs(): number {
  const raw = Number(process.env.PIKILOOM_REAP_FORCE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : REAP_FORCE_DEFAULT_MS;
}

/**
 * True when a child can be spawned as its own process-group leader on this platform, so the
 * whole tree it builds — an agent CLI's MCP servers, its tool subprocesses — can be signalled
 * as one unit. `detached` opens a console window on Windows, so there it stays off and the
 * group step below degrades to the single pid.
 */
export const canLeadProcessGroup = process.platform !== 'win32';

/**
 * Terminate a child FOR GOOD: end its stdin, then SIGTERM, then SIGKILL — each step only if
 * it is still alive, and the whole ladder cancelled the moment it exits.
 *
 * Why this exists rather than a bare {@link sigterm}: every teardown site used to fire one
 * signal and forget the child. A `claude -p` that ignored both stdin EOF and that single
 * SIGTERM — a large-transcript flush, an MCP server wedging its own shutdown — was then
 * unreferenced by the pool AND by its turn, so nothing would ever try again. Observed in the
 * wild as `claude` processes resident for 14 hours at ~400 MB each with no session behind them.
 *
 * `graceMs: 0` skips straight to SIGTERM (the old `kill=true` semantics — nothing is left
 * running in the background, so there is nothing to wait for). A positive grace preserves the
 * reason the graceful path exists: the CLI persists the turn into its session jsonl AFTER
 * emitting `result`, and killing it mid-write loses the reply from the transcript.
 *
 * `group: true` (for a child spawned `detached`) widens ONLY the final SIGKILL to the child's
 * process group. The ladder's earlier steps stay aimed at the child alone on purpose: stdin EOF
 * and SIGTERM both let the CLI shut its own subprocesses down in order, which it does properly.
 * SIGKILL is the case where it CANNOT, so whatever it spawned is on its own.
 *
 * Most of that tree survives a hard kill only briefly: an MCP server talks to the CLI over a
 * stdio pipe, so the pipe breaking is its own EOF and it exits — measured, with claude's four
 * default MCP servers all gone within seconds of `kill -9` on the CLI alone. This covers the
 * rest: a subprocess holding no pipe back to the CLI (`stdio: 'ignore'`), or one that ignores
 * EOF, reparents to init and then nothing in the system knows it exists. Cheap insurance, and
 * the same thing the PTY path already does deliberately when it hangs up a terminal.
 *
 * Timers are `unref`'d so a reap in flight never holds a one-shot embedder's event loop open;
 * they still fire in any live process, and the `exit` listener is what guarantees the ladder
 * stops early rather than the timers being cancelled from outside.
 */
export function reapChild(
  child: ChildProcess | null | undefined,
  opts: { graceMs?: number; forceMs?: number; group?: boolean } = {},
): void {
  if (!child) return;
  try { child.stdin?.end(); } catch { /* ignore */ }
  if (child.exitCode != null || child.signalCode != null) return;

  const graceMs = opts.graceMs ?? reapGraceMs();
  const forceMs = opts.forceMs ?? reapForceMs();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const arm = (fn: () => void, ms: number): void => {
    const t = setTimeout(fn, ms);
    if (typeof t.unref === 'function') t.unref();
    timers.push(t);
  };
  const done = (): void => { for (const t of timers) clearTimeout(t); timers.length = 0; };
  // Cancels the rest of the ladder as soon as the child is gone — the reason a normally
  // exiting child costs nothing here, and the reason SIGKILL is never sent to a dead pid.
  child.once('exit', done);

  const force = (): void => {
    if (child.exitCode != null || child.signalCode != null) return;
    // Group first, then the bare pid: a negative pid needs the child to actually BE a group
    // leader, and it is only one when the caller spawned it detached on a platform that allows
    // it. ESRCH/EPERM here just means there is no such group, so fall through.
    if (opts.group && canLeadProcessGroup && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* not a group — fall through */ }
    }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };
  const term = (): void => {
    if (child.exitCode != null || child.signalCode != null) return;
    sigterm(child);
    arm(force, forceMs);
  };
  if (graceMs > 0) arm(term, graceMs);
  else term();
}

// Attachment vocabulary lives in ../attachments.ts (the Hub also normalizes oversized
// images there); re-exported so drivers keep one import site for driver-internal helpers.
export { imageMimeForFile, attachedFileNote } from '../attachments.js';

/**
 * Context-window occupancy as a display percent (one decimal, capped at 99.9).
 * Pass `used` as null when the caller wants "no data" rather than 0%.
 */
export function contextPercent(used: number | null | undefined, window: number | null | undefined): number | null {
  return window && used != null ? Math.min(99.9, Math.round((used / window) * 1000) / 10) : null;
}
