import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: execSyncMock,
  };
});

describe('Claude usage resolution', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(() => {
    vi.resetModules();
    execSyncMock.mockReset();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-claude-usage-'));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('falls through to telemetry when OAuth fails and generates age-based labels', async () => {
    // --- OAuth rate_limit_error scenario ---
    {
      const telemetryDir = path.join(homeDir, '.claude', 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(path.join(telemetryDir, 'events.json'), JSON.stringify({
        event_type: 'ClaudeCodeInternalEvent',
        event_data: {
          event_name: 'tengu_claudeai_limits_status_changed',
          client_timestamp: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
          model: 'claude-opus-4-6',
          additional_metadata: JSON.stringify({ status: 'allowed_warning', hoursTillReset: 39 }),
        },
      }));

      execSyncMock.mockImplementation((cmd: string) => {
        if (cmd.includes('security find-generic-password')) {
          return JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } });
        }
        if (cmd.includes('api/oauth/usage')) {
          return JSON.stringify({
            error: {
              type: 'rate_limit_error',
              message: 'Rate limited. Please try again later.',
            },
          });
        }
        throw new Error(`Unexpected command: ${cmd}`);
      });

      const { getUsage } = await import('../src/code-agent.ts');
      const usage = getUsage({ agent: 'claude', model: 'claude-opus-4-6' });

      // Should fall through to telemetry, not report the OAuth error
      expect(usage.ok).toBe(true);
      expect(usage.source).toBe('telemetry');
      expect(usage.status).toBe('warning');
    }

    // Reset modules and mocks for the next scenario
    vi.resetModules();
    execSyncMock.mockReset();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-claude-usage-'));
    process.env.HOME = homeDir;

    // --- Age-based labels scenario ---
    {
      const telemetryDir = path.join(homeDir, '.claude', 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      // Write a recent telemetry event (5 minutes ago) so label is deterministic
      fs.writeFileSync(path.join(telemetryDir, 'events.json'), JSON.stringify({
        event_type: 'ClaudeCodeInternalEvent',
        event_data: {
          event_name: 'tengu_claudeai_limits_status_changed',
          client_timestamp: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 minutes ago
          model: 'claude-opus-4-6',
          additional_metadata: JSON.stringify({ status: 'allowed_warning', hoursTillReset: 39 }),
        },
      }));

      execSyncMock.mockImplementation(() => {
        throw new Error('No OAuth token');
      });

      const { getUsage } = await import('../src/code-agent.ts');
      const usage = getUsage({ agent: 'claude', model: 'claude-opus-4-6' });

      expect(usage.ok).toBe(true);
      expect(usage.source).toBe('telemetry');
      expect(usage.windows[0]?.label).toMatch(/^\d+m ago$/); // e.g. "5m ago"
      expect(usage.windows[0]?.status).toBe('warning');
    }
  });
});

describe('Claude context fallback', () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it('uses 1M fallback for Opus and Sonnet base models', async () => {
    const { doClaudeStream } = await import('../src/code-agent.ts');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-claude-context-'));
    const fakeBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;

    const writeFakeScript = (jsonLines: object[]) => {
      const payload = jsonLines.map(j => JSON.stringify(j)).join('\n');
      const script = `#!/bin/sh\ncat <<'JSONL_EOF'\n${payload}\nJSONL_EOF\n`;
      fs.writeFileSync(path.join(fakeBin, 'claude'), script, { mode: 0o755 });
    };

    const baseOpts = {
      agent: 'claude' as const,
      prompt: 'test prompt',
      workdir: tmpDir,
      timeout: 10,
      sessionId: null,
      model: null,
      thinkingEffort: 'high' as const,
      onText: () => {},
    };

    writeFakeScript([
      { type: 'system', session_id: 's-ctx', model: 'claude-sonnet-4-6' },
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 25_000, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 } },
        },
      },
      { type: 'result', session_id: 's-ctx', usage: { input_tokens: 25_000, cache_read_input_tokens: 1_000, output_tokens: 1 } },
    ]);

    const result = await doClaudeStream(baseOpts);
    expect(result.contextWindow).toBe(1_000_000);
    expect(result.contextPercent).toBe(2.6);
  });
});
