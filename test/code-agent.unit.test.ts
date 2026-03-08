/**
 * Unit tests for code-agent.ts
 *
 * Uses a tiny shell script that echoes JSONL to stdout, simulating codex/claude output.
 * This avoids hitting real APIs while testing all parsing and control flow.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { doStream, doCodexStream, doClaudeStream, getUsage, type StreamOpts } from '../src/code-agent.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- helpers ---

const tmpDir = path.join(os.tmpdir(), 'codeclaw-test-' + process.pid);
const fakeBin = path.join(tmpDir, 'bin');

function writeFakeScript(name: string, jsonLines: object[]) {
  const payload = jsonLines.map(j => JSON.stringify(j)).join('\n');
  const script = `#!/bin/sh\ncat <<'JSONL_EOF'\n${payload}\nJSONL_EOF\n`;
  const p = path.join(fakeBin, name);
  fs.writeFileSync(p, script, { mode: 0o755 });
}

function baseOpts(agent: 'codex' | 'claude', extra: Partial<StreamOpts> = {}): StreamOpts {
  return {
    agent,
    prompt: 'test prompt',
    workdir: tmpDir,
    timeout: 10,
    sessionId: null,
    model: null,
    thinkingEffort: 'high',
    onText: () => {},
    ...extra,
  };
}

beforeEach(() => {
  fs.mkdirSync(fakeBin, { recursive: true });
  // Prepend fake bin to PATH so our scripts shadow real codex/claude
  process.env.PATH = `${fakeBin}:${process.env.PATH}`;
});

// --- codex parsing ---

describe('codex stream', () => {
  it('parses single-turn conversation', async () => {
    writeFakeScript('codex', [
      { type: 'thread.started', thread_id: 'thread-abc', model: 'gpt-5.4' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Hello world' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 }, model: 'gpt-5.4' },
    ]);

    const result = await doCodexStream(baseOpts('codex'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Hello world');
    expect(result.sessionId).toBe('thread-abc');
    expect(result.model).toBe('gpt-5.4');
    expect(result.inputTokens).toBe(100);
    expect(result.cachedInputTokens).toBe(20);
    expect(result.outputTokens).toBe(50);
  });

  it('parses reasoning + multiple messages', async () => {
    writeFakeScript('codex', [
      { type: 'thread.started', thread_id: 'thread-r' },
      { type: 'item.completed', item: { type: 'reasoning', text: 'Let me think...' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Part 1' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Part 2' } },
      { type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 80 } },
    ]);

    const result = await doCodexStream(baseOpts('codex'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Part 1\n\nPart 2');
    expect(result.thinking).toBe('Let me think...');
  });

  it('streams onText callbacks incrementally', async () => {
    writeFakeScript('codex', [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'First' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Second' } },
      { type: 'turn.completed', usage: {} },
    ]);

    const calls: string[] = [];
    const result = await doCodexStream(baseOpts('codex', { onText: (text) => { if (text) calls.push(text); } }));
    expect(result.ok).toBe(true);
    // Should have been called at least twice with growing text
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[calls.length - 1]).toContain('Second');
  });

  it('builds resume command with sessionId', async () => {
    writeFakeScript('codex', [
      { type: 'thread.started', thread_id: 'thread-resume' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Resumed' } },
      { type: 'turn.completed', usage: {} },
    ]);

    const result = await doCodexStream(baseOpts('codex', { sessionId: 'old-thread-id' }));
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('thread-resume');
  });
});

// --- claude parsing ---

describe('claude stream', () => {
  it('parses stream-json events', async () => {
    writeFakeScript('claude', [
      { type: 'system', session_id: 'sess-123', model: 'claude-opus-4-6', thinking_level: 'high' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } },
      { type: 'result', session_id: 'sess-123', usage: { input_tokens: 150, cache_read_input_tokens: 30, output_tokens: 60 } },
    ]);

    const result = await doClaudeStream(baseOpts('claude'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Hello world');
    expect(result.sessionId).toBe('sess-123');
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.thinkingEffort).toBe('high');
    expect(result.inputTokens).toBe(150);
    expect(result.cachedInputTokens).toBe(30);
    expect(result.outputTokens).toBe(60);
    expect(result.stopReason).toBe(null);
    expect(result.error).toBe(null);
    expect(result.incomplete).toBe(false);
  });

  it('parses thinking deltas', async () => {
    writeFakeScript('claude', [
      { type: 'system', session_id: 's1' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Hmm...' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer' } } },
      { type: 'result', session_id: 's1' },
    ]);

    const result = await doClaudeStream(baseOpts('claude'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Answer');
    expect(result.thinking).toBe('Hmm...');
  });

  it('parses assistant event fallback', async () => {
    writeFakeScript('claude', [
      { type: 'system', session_id: 's2' },
      { type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'Deep thought' },
        { type: 'text', text: 'Final answer' },
      ] } },
      { type: 'result', session_id: 's2' },
    ]);

    const result = await doClaudeStream(baseOpts('claude'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Final answer');
    expect(result.thinking).toBe('Deep thought');
  });

  it('retries on expired session', async () => {
    // First call: fake claude returns session-not-found error
    // The retry will call claude again (same fake script), which returns the error again.
    // But we need to simulate: first call → error, second call → success.
    // Use a stateful script that behaves differently on second run.
    const stateFile = path.join(tmpDir, 'call_count');
    fs.writeFileSync(stateFile, '0');
    const script = `#!/bin/sh
COUNT=$(cat ${stateFile})
COUNT=$((COUNT + 1))
echo $COUNT > ${stateFile}
if [ "$COUNT" = "1" ]; then
  echo '${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'new-sess', errors: ['No conversation found with session ID: old-sess'] })}'
else
  echo '${JSON.stringify({ type: 'system', session_id: 'new-sess', model: 'claude-opus-4-6' })}'
  echo '${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fresh start' } } })}'
  echo '${JSON.stringify({ type: 'result', session_id: 'new-sess', usage: { input_tokens: 10, output_tokens: 5 } })}'
fi`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), script, { mode: 0o755 });

    const result = await doClaudeStream(baseOpts('claude', { sessionId: 'old-sess' }));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Fresh start');
    expect(result.sessionId).toBe('new-sess');
    // Verify it was called twice
    expect(fs.readFileSync(stateFile, 'utf-8').trim()).toBe('2');
  });

  it('parses result event with is_error (non-session error)', async () => {
    writeFakeScript('claude', [
      { type: 'result', is_error: true, errors: ['Rate limit exceeded'] },
    ]);

    const result = await doClaudeStream(baseOpts('claude'));
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Rate limit exceeded');
    expect(result.error).toBe('Rate limit exceeded');
    expect(result.incomplete).toBe(true);
  });

  it('captures stop_reason=max_tokens as incomplete', async () => {
    writeFakeScript('claude', [
      { type: 'system', session_id: 's-max' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Long answer...' } } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 999 } } },
      { type: 'result', session_id: 's-max' },
    ]);

    const result = await doClaudeStream(baseOpts('claude'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Long answer...');
    expect(result.stopReason).toBe('max_tokens');
    expect(result.error).toBe(null);
    expect(result.incomplete).toBe(true);
  });
});

// --- doStream unified ---

describe('doStream', () => {
  it('routes to codex', async () => {
    writeFakeScript('codex', [
      { type: 'thread.started', thread_id: 't-unified' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'via codex' } },
      { type: 'turn.completed', usage: {} },
    ]);

    const result = await doStream(baseOpts('codex'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('via codex');
  });

  it('routes to claude', async () => {
    writeFakeScript('claude', [
      { type: 'system', session_id: 's-unified' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'via claude' } } },
      { type: 'result', session_id: 's-unified' },
    ]);

    const result = await doStream(baseOpts('claude'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('via claude');
  });
});

// --- attachments ---

describe('attachments', () => {
  it('codex passes --image flags for attachments', async () => {
    const argsFile = path.join(tmpDir, 'codex-args.txt');
    const script = `#!/bin/sh
echo "$@" > ${argsFile}
echo '{"type":"thread.started","thread_id":"t-img"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'
echo '{"type":"turn.completed","usage":{}}'`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script, { mode: 0o755 });

    const result = await doCodexStream(baseOpts('codex', {
      attachments: ['/tmp/a.png', '/tmp/b.jpg'],
    }));
    expect(result.ok).toBe(true);
    const args = fs.readFileSync(argsFile, 'utf-8');
    expect(args).toContain('--image');
    expect(args).toContain('/tmp/a.png');
    expect(args).toContain('/tmp/b.jpg');
  });

  it('claude uses --input-format stream-json for attachments', async () => {
    const argsFile = path.join(tmpDir, 'claude-args.txt');
    const stdinFile = path.join(tmpDir, 'claude-stdin.txt');
    const script = `#!/bin/sh
echo "$@" > ${argsFile}
cat > ${stdinFile}
echo '{"type":"system","session_id":"s-file"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}'
echo '{"type":"result","session_id":"s-file"}'`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), script, { mode: 0o755 });

    // Create a tiny test image
    const imgPath = path.join(tmpDir, 'test.png');
    fs.writeFileSync(imgPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));

    const result = await doClaudeStream(baseOpts('claude', {
      attachments: [imgPath],
    }));
    expect(result.ok).toBe(true);
    const args = fs.readFileSync(argsFile, 'utf-8');
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    expect(args).not.toContain('--input-file');
    // Verify stdin contains the multimodal JSON message
    const stdin = fs.readFileSync(stdinFile, 'utf-8');
    const msg = JSON.parse(stdin.trim());
    expect(msg.type).toBe('user');
    expect(msg.message.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', source: expect.objectContaining({ type: 'base64', media_type: 'image/png' }) }),
        expect.objectContaining({ type: 'text' }),
      ]),
    );
  });

  it('claude includes non-image files as text references in stream-json', async () => {
    const argsFile = path.join(tmpDir, 'claude-args2.txt');
    const stdinFile = path.join(tmpDir, 'claude-stdin2.txt');
    const script = `#!/bin/sh
echo "$@" > ${argsFile}
cat > ${stdinFile}
echo '{"type":"system","session_id":"s-file2"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}'
echo '{"type":"result","session_id":"s-file2"}'`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), script, { mode: 0o755 });

    const result = await doClaudeStream(baseOpts('claude', {
      attachments: ['/tmp/doc.pdf'],
    }));
    expect(result.ok).toBe(true);
    const args = fs.readFileSync(argsFile, 'utf-8');
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    const stdin = fs.readFileSync(stdinFile, 'utf-8');
    const msg = JSON.parse(stdin.trim());
    expect(msg.type).toBe('user');
    expect(msg.message.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('/tmp/doc.pdf') }),
      ]),
    );
  });

  it('no flags when attachments is empty', async () => {
    const argsFile = path.join(tmpDir, 'claude-empty-args.txt');
    const script = `#!/bin/sh
echo "$@" > ${argsFile}
echo '{"type":"system","session_id":"s-no"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}'
echo '{"type":"result","session_id":"s-no"}'`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), script, { mode: 0o755 });

    const result = await doClaudeStream(baseOpts('claude', { attachments: [] }));
    expect(result.ok).toBe(true);
    const args = fs.readFileSync(argsFile, 'utf-8');
    expect(args).not.toContain('--input-format');
  });

  it('no flags when attachments is undefined', async () => {
    writeFakeScript('codex', [
      { type: 'thread.started', thread_id: 't-undef' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'no attach' } },
      { type: 'turn.completed', usage: {} },
    ]);

    const result = await doCodexStream(baseOpts('codex'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('no attach');
  });
});

// --- edge cases ---

describe('edge cases', () => {
  it('handles process crash (non-zero exit)', async () => {
    const script = '#!/bin/sh\necho "oops" >&2\nexit 1';
    fs.writeFileSync(path.join(fakeBin, 'codex'), script, { mode: 0o755 });

    const result = await doCodexStream(baseOpts('codex'));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Failed (exit=1)');
    expect(result.message).toContain('oops');
    expect(result.error).toBe('oops');
    expect(result.incomplete).toBe(true);
  });

  it('preserves partial text when process exits with error', async () => {
    const script = `#!/bin/sh
echo '${JSON.stringify({ type: 'system', session_id: 's-partial' })}'
echo '${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial answer' } } })}'
echo "quota exceeded" >&2
exit 1`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), script, { mode: 0o755 });

    const result = await doClaudeStream(baseOpts('claude'));
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Partial answer');
    expect(result.error).toBe('quota exceeded');
    expect(result.incomplete).toBe(true);
  });

  it('handles empty output with success exit', async () => {
    const script = '#!/bin/sh\nexit 0';
    fs.writeFileSync(path.join(fakeBin, 'claude'), script, { mode: 0o755 });

    const result = await doClaudeStream(baseOpts('claude'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('(no textual response)');
  });

  it('ignores non-JSON lines', async () => {
    const script = `#!/bin/sh
echo "some debug output"
echo '${JSON.stringify({ type: 'thread.started', thread_id: 'tt' })}'
echo "more noise"
echo '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } })}'
echo '${JSON.stringify({ type: 'turn.completed', usage: {} })}'`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script, { mode: 0o755 });

    const result = await doCodexStream(baseOpts('codex'));
    expect(result.ok).toBe(true);
    expect(result.message).toBe('OK');
  });

  it('preserves initial model/thinkingEffort when engine does not report them', async () => {
    writeFakeScript('codex', [
      { type: 'thread.started', thread_id: 'tt' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Hi' } },
      { type: 'turn.completed', usage: {} },
    ]);

    const result = await doCodexStream(baseOpts('codex', { model: 'my-model', thinkingEffort: 'xhigh' }));
    expect(result.model).toBe('my-model');
    expect(result.thinkingEffort).toBe('xhigh');
  });
});

describe('getUsage', () => {
  it('reads codex usage from session history fallback', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeclaw-home-'));
    const oldHome = process.env.HOME;

    try {
      process.env.HOME = homeDir;
      const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '03', '08');
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, 'usage.jsonl'), [
        JSON.stringify({ type: 'session_meta', payload: { id: 'sess-usage' } }),
        JSON.stringify({
          timestamp: '2026-03-08T01:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: {
              primary: {
                used_percent: 27,
                window_minutes: 300,
                reset_after_seconds: 7200,
                resets_at: 2000000000,
              },
              secondary: {
                used_percent: 61,
                window_minutes: 10080,
                reset_after_seconds: 86400,
                resets_at: 2000086400,
              },
            },
          },
        }),
      ].join('\n'));

      const result = getUsage({ agent: 'codex' });
      expect(result.ok).toBe(true);
      expect(result.source).toBe('session-history');
      expect(result.capturedAt).toBe('2026-03-08T01:00:00.000Z');
      expect(result.windows.map(w => w.label)).toEqual(['5h', '7d']);
      expect(result.windows[0].usedPercent).toBe(27);
      expect(result.windows[0].remainingPercent).toBe(73);
      expect(result.windows[0].resetAfterSeconds).toBe(7200);
      expect(result.windows[1].usedPercent).toBe(61);
      expect(result.windows[1].remainingPercent).toBe(39);
    } finally {
      if (oldHome == null) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('reads claude usage from telemetry and prefers the current model family', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeclaw-home-'));
    const oldHome = process.env.HOME;

    try {
      process.env.HOME = homeDir;
      const telemetryDir = path.join(homeDir, '.claude', 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(path.join(telemetryDir, 'events.json'), [
        JSON.stringify({
          event_type: 'ClaudeCodeInternalEvent',
          event_data: {
            event_name: 'tengu_claudeai_limits_status_changed',
            client_timestamp: '2026-03-08T04:00:00.000Z',
            model: 'claude-sonnet-4-6',
            additional_metadata: JSON.stringify({ status: 'allowed', hoursTillReset: 2 }),
          },
        }),
        JSON.stringify({
          event_type: 'ClaudeCodeInternalEvent',
          event_data: {
            event_name: 'tengu_claudeai_limits_status_changed',
            client_timestamp: '2026-03-08T03:00:00.000Z',
            model: 'claude-opus-4-6',
            additional_metadata: JSON.stringify({ status: 'allowed_warning', hoursTillReset: 39 }),
          },
        }),
      ].join('\n'));

      const result = getUsage({ agent: 'claude', model: 'claude-opus-4-6' });
      expect(result.ok).toBe(true);
      expect(result.source).toBe('telemetry');
      expect(result.capturedAt).toBe('2026-03-08T03:00:00.000Z');
      expect(result.status).toBe('allowed_warning');
      expect(result.windows).toHaveLength(1);
      expect(result.windows[0].label).toBe('Current');
      expect(result.windows[0].usedPercent).toBe(null);
      expect(result.windows[0].remainingPercent).toBe(null);
      expect(result.windows[0].resetAfterSeconds).toBe(39 * 3600);
      expect(result.windows[0].status).toBe('allowed_warning');
    } finally {
      if (oldHome == null) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});
