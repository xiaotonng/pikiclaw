import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDriver } from '../src/drivers/claude.js';
import type { AgentTurnInput, DriverContext, DriverEvent } from '../src/contracts/driver.js';

// A fake `claude` CLI whose behaviour after the first user message is chosen by FAKE_MODE:
//   healthy — stream a real reply + result (the model is alive)
//   silent  — emit only `system/init`, then never answer (a severed model connection: the
//             INITIAL model wait that never resolves — the exact "spinner that never ends")
//   apierr  — emit `system/init` + a synthetic API-error assistant message, then go silent
//             (the model is unreachable and the CLI is "retrying" but never recovers)
// In every non-healthy mode it keeps stdin OPEN and stays alive, so the ONLY thing that can
// end the turn is the driver's model-stall watchdog — which is what we are testing.
const FAKE_CLAUDE = `#!/usr/bin/env node
const SID = 'sess-stall-1';
const MODE = process.env.FAKE_MODE || 'healthy';
let buf = '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: SID, model: 'fake-model' });
    if (MODE === 'healthy') {
      out({ type: 'stream_event', session_id: SID, event: { type: 'message_start', message: { usage: { input_tokens: 10 } } } });
      out({ type: 'stream_event', session_id: SID, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } } });
      out({ type: 'result', session_id: SID, result: 'answer', usage: { input_tokens: 10, output_tokens: 2 } });
    } else if (MODE === 'apierr') {
      out({ type: 'assistant', session_id: SID, error: 'overloaded_error', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Unable to connect to API (ConnectionRefused)' }] } });
      // then silent — the watchdog must still fire
    }
    // MODE === 'silent': emit nothing further; stay alive on the open stdin
  }
});
process.stdin.on('end', () => process.exit(0));
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

describe('ClaudeDriver model-stall watchdog (severed-connection hang)', () => {
  let tmp: string;
  let fake: string;
  let driver: ClaudeDriver | null;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-claude-stall-'));
    fake = path.join(tmp, 'fake-claude.js');
    fs.writeFileSync(fake, FAKE_CLAUDE, { mode: 0o755 });
    driver = null;
    // A short stall window so the test resolves fast instead of the 5-minute default — but safely
    // above cold `node` subprocess spawn latency (a cold fake turn is ~0.6–1.2s here), so a healthy
    // fake's reply clears the watchdog before it can misfire. Too tight and the test races the fake's
    // own startup, not the model.
    process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = '2500';
  });
  afterEach(() => {
    driver?.dispose();
    delete process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const turnInput = (mode: string): AgentTurnInput => ({ prompt: 'ping', workdir: tmp, env: { FAKE_MODE: mode } });

  it('bounds the INITIAL model wait: a model that never answers settles as stalled, not a forever spinner', async () => {
    const d = new ClaudeDriver(fake);
    driver = d;
    const r = await d.run(turnInput('silent'), ctxCollect().ctx);
    expect(r.stopReason).toBe('stalled');
    expect(r.ok).toBe(false);
  });

  it('still stalls when the CLI reports an API error then goes silent (the retry never recovers)', async () => {
    // Regression guard: the API-error assistant event must NOT clear the watchdog (previously any
    // assistant/stream event did), or a connection that fails-then-retries-silently hangs unbounded.
    const d = new ClaudeDriver(fake);
    driver = d;
    const r = await d.run(turnInput('apierr'), ctxCollect().ctx);
    expect(r.stopReason).toBe('stalled');
    expect(r.ok).toBe(false);
  });

  it('does NOT stall a healthy turn — real model output clears the watchdog', async () => {
    // This case must NOT inherit the tight window above. What it asserts is that model output
    // CLEARS the watchdog; with a 2.5 s window the pass condition also silently requires a cold
    // `node` spawn to finish inside 2.5 s, which is a race against machine load rather than
    // against the model — under a loaded suite it misfires and the turn settles 'stalled'.
    // A window that cannot misfire keeps the assertion about the watchdog, which is the point.
    process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = '60000';
    const d = new ClaudeDriver(fake);
    driver = d;
    const r = await d.run(turnInput('healthy'), ctxCollect().ctx);
    expect(r.ok).toBe(true);
    expect(r.stopReason).not.toBe('stalled');
    expect(r.text).toContain('answer');
  });
});
