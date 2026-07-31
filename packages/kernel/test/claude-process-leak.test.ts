import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ClaudeDriver } from '../src/drivers/claude.js';
import { reapChild } from '../src/drivers/shared.js';
import type { AgentTurnInput, DriverContext, DriverEvent } from '../src/contracts/driver.js';

// Process-leak regressions for the `claude -p` path. Two defects, both observed in the wild as
// `claude` processes resident for hours at ~400 MB with no session behind them:
//
//  1. A turn that used run_in_background settled through 'quiet-settle', which did NOT park —
//     so it TOOK the session's parked process out of the pool and never put it back. The next
//     turn always cold-spawned (78% of continuations, measured) and the taken process was
//     released unowned with a single fire-and-forget SIGTERM.
//  2. Every teardown site fired at most one signal and dropped its handle, so a CLI that
//     ignored both stdin EOF and SIGTERM could never be killed by anything afterwards.

/** A fake CLI whose turn reports a background task started AND finished, so the driver takes
 *  the 'quiet-settle' branch (sawBackground, pendingBackground 0). Pid-stamped like the
 *  warm-pool fixture so reuse is visible without OS probing. */
const FAKE_BG_CLAUDE = `#!/usr/bin/env node
const SID = process.env.FAKE_SESSION_ID || 'sess-bg-1';
let buf = '';
let turn = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'user') continue;
    turn++;
    out({ type: 'system', subtype: 'init', session_id: SID, model: 'fake-model' });
    out({ type: 'system', subtype: 'task_started', task_id: 'bg-' + turn, session_id: SID });
    out({ type: 'system', subtype: 'task_notification', task_id: 'bg-' + turn, status: 'completed', session_id: SID });
    out({ type: 'stream_event', session_id: SID, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'pid=' + process.pid + ' turn=' + turn } } });
    out({ type: 'result', session_id: SID, result: 'pid=' + process.pid + ' turn=' + turn, usage: { input_tokens: 10, output_tokens: 2 } });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

/** Ignores stdin EOF and SIGTERM entirely, and never emits a `result` — so its turn never
 *  settles. Models a CLI wedged in its post-`result` transcript flush or by an MCP server that
 *  hangs its own shutdown, which is the state only SIGKILL ends. */
const STUBBORN = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));
process.on('SIGTERM', () => {});
process.stdin.resume();
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);
`;

function ctxCollect(): { ctx: DriverContext; events: DriverEvent[]; abort: AbortController } {
  const abort = new AbortController();
  const events: DriverEvent[] = [];
  const ctx: DriverContext = {
    signal: abort.signal,
    emit: (e) => events.push(e),
    askUser: async () => ({}),
    registerSteer: () => {},
  };
  return { ctx, events, abort };
}

const pidOf = (text: string): string => /pid=(\d+)/.exec(text)?.[1] ?? '';
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const until = async (pred: () => boolean, ms = 5_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
};

describe('claude -p process leak', () => {
  let tmp: string;
  let driver: ClaudeDriver | null;
  /** Pid files every fixture in this file writes. STUBBORN deliberately survives SIGTERM, so if
   *  an assertion throws before the test reaps it, nothing else ever will — an orphan that
   *  outlives the whole run. (Observed for real while running these tests against the unfixed
   *  source, where `reapChild` was undefined and `dispose()` threw.) Sweep unconditionally. */
  let pidFiles: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-claude-leak-'));
    driver = null;
    pidFiles = [];
    // Sub-second so the quiet-settle branch is reachable inside a test.
    process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS = '150';
    process.env.PIKILOOM_CLAUDE_BG_HOLD_RECHECK_MS = '50';
  });
  afterEach(() => {
    try { driver?.dispose(); } catch { /* the point of the sweep below */ }
    for (const f of pidFiles) {
      try { process.kill(Number(fs.readFileSync(f, 'utf8').trim()), 'SIGKILL'); } catch { /* gone */ }
    }
    delete process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS;
    delete process.env.PIKILOOM_CLAUDE_BG_HOLD_RECHECK_MS;
    delete process.env.PIKILOOM_CLAUDE_WARM_IDLE_MS;
    delete process.env.PIKILOOM_CLAUDE_WARM_MAX;
    delete process.env.PIKILOOM_REAP_GRACE_MS;
    delete process.env.PIKILOOM_REAP_FORCE_MS;
    delete process.env.PID_FILE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Arm PID_FILE for a STUBBORN spawn and register it for the afterEach sweep. */
  const armPidFile = (name: string): string => {
    const f = path.join(tmp, name);
    pidFiles.push(f);
    process.env.PID_FILE = f;
    return f;
  };

  const write = (body: string): string => {
    const p = path.join(tmp, `fake-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(p, body, { mode: 0o755 });
    return p;
  };
  const turnInput = (extra: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
    prompt: 'ping', workdir: tmp, ...extra,
  });

  it('re-parks the process after a background-work turn, so the next turn stays warm', async () => {
    const d = new ClaudeDriver(write(FAKE_BG_CLAUDE), { warmPool: true });
    driver = d;
    const { ctx } = ctxCollect();

    const r1 = await d.run(turnInput(), ctx);
    expect(r1.ok).toBe(true);
    expect(r1.transport).toBe('cold');
    expect(d.warmPoolSize()).toBe(1); // the leak was this being 0

    const r2 = await d.run(turnInput({ sessionId: r1.sessionId! }), ctx);
    expect(r2.ok).toBe(true);
    expect(r2.transport).toBe('warm');
    expect(pidOf(r2.text)).toBe(pidOf(r1.text)); // same process, not a respawn
    expect(d.warmPoolSize()).toBe(1);
  });

  it('does not accumulate processes across background-work turns', async () => {
    const d = new ClaudeDriver(write(FAKE_BG_CLAUDE), { warmPool: true });
    driver = d;
    const { ctx } = ctxCollect();

    let sessionId: string | null = null;
    const pids = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const r = await d.run(turnInput(sessionId ? { sessionId } : {}), ctx);
      expect(r.ok).toBe(true);
      sessionId = r.sessionId;
      pids.add(pidOf(r.text));
    }
    // One process served all four turns; previously each turn spawned and abandoned its own.
    expect(pids.size).toBe(1);
    expect(d.liveProcessCount()).toBe(1);
  });

  it('dispose() reaps a MID-TURN process — the shutdown case the pool never sees', async () => {
    // The pool only ever holds PARKED processes, so a dispose() that walked it alone left an
    // in-flight turn's CLI running: on shutdown nothing aborts running turns (Loom.stop stops
    // surfaces only), so this process got no signal at all and outlived the server.
    const pidFile = armPidFile('stubborn.pid');
    process.env.PIKILOOM_REAP_FORCE_MS = '150';
    const d = new ClaudeDriver(write(STUBBORN), { warmPool: true });
    driver = d;
    const { ctx } = ctxCollect();

    const turn = d.run(turnInput(), ctx); // never settles on its own — no `result` ever comes
    expect(await until(() => fs.existsSync(pidFile))).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(alive(pid)).toBe(true);
    expect(d.warmPoolSize()).toBe(0); // mid-turn: the pool cannot see it
    expect(d.liveProcessCount()).toBe(1); // but the driver can

    d.dispose();
    expect(await until(() => !alive(pid), 5_000)).toBe(true);
    await turn.catch(() => undefined); // the kill settles the hanging turn
  });

  it('reapChild escalates to SIGKILL when the child ignores stdin EOF and SIGTERM', async () => {
    armPidFile('reap.pid');
    const child = spawn(process.execPath, [write(STUBBORN)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const pid = child.pid!;
    await until(() => alive(pid));

    reapChild(child, { graceMs: 20, forceMs: 60 });
    expect(await until(() => child.signalCode === 'SIGKILL' || !alive(pid), 3_000)).toBe(true);
  });

  it('reapChild sends no signal to a child that exits on stdin EOF', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume();'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pid = child.pid!;
    reapChild(child, { graceMs: 2_000, forceMs: 2_000 });
    expect(await until(() => child.exitCode != null)).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull(); // exited on its own; the ladder was cancelled
    expect(alive(pid)).toBe(false);
  });
});
