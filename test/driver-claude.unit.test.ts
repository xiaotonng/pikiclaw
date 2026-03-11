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
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeclaw-claude-usage-'));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('prefers explicit OAuth API errors over stale telemetry fallback', async () => {
    const telemetryDir = path.join(homeDir, '.claude', 'telemetry');
    fs.mkdirSync(telemetryDir, { recursive: true });
    fs.writeFileSync(path.join(telemetryDir, 'events.json'), JSON.stringify({
      event_type: 'ClaudeCodeInternalEvent',
      event_data: {
        event_name: 'tengu_claudeai_limits_status_changed',
        client_timestamp: '2026-03-08T03:00:00.000Z',
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

    expect(usage.ok).toBe(false);
    expect(usage.source).toBe('oauth-api');
    expect(usage.status).toBe('limit_reached');
    expect(usage.error).toBe('rate_limit_error: Rate limited. Please try again later.');
    expect(usage.windows).toEqual([]);
  });

  it('marks telemetry fallback as last seen instead of current', async () => {
    const telemetryDir = path.join(homeDir, '.claude', 'telemetry');
    fs.mkdirSync(telemetryDir, { recursive: true });
    fs.writeFileSync(path.join(telemetryDir, 'events.json'), JSON.stringify({
      event_type: 'ClaudeCodeInternalEvent',
      event_data: {
        event_name: 'tengu_claudeai_limits_status_changed',
        client_timestamp: '2026-03-08T03:00:00.000Z',
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
    expect(usage.windows[0]?.label).toBe('Last seen');
    expect(usage.windows[0]?.status).toBe('warning');
  });
});
