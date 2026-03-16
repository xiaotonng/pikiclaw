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

describe('Gemini usage resolution', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T00:00:00Z'));

    execSyncMock.mockReset();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-gemini-usage-'));
    process.env.HOME = homeDir;
    fs.mkdirSync(path.join(homeDir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.gemini', 'oauth_creds.json'), JSON.stringify({
      access_token: 'gemini-token',
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('fetches Gemini quota usage live and caches the latest successful snapshot', async () => {
    execSyncMock.mockReturnValue(JSON.stringify({
      buckets: [
        { modelId: 'gemini-2.5-flash', remainingFraction: 0.75, resetTime: '2026-03-16T00:30:00Z' },
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.7, resetTime: '2026-03-16T01:00:00Z' },
        { modelId: 'gemini-3.1-flash-lite-preview', remainingFraction: 0.4, resetTime: '2026-03-16T00:45:00Z' },
        { modelId: 'gemini-3-pro-preview', remainingFraction: 0.9, resetTime: '2026-03-16T02:00:00Z' },
      ],
    }) + '\n200');

    const { getDriver } = await import('../src/agent-driver.ts');
    const { getUsage } = await import('../src/code-agent.ts');
    const driver = getDriver('gemini');

    const usage = await driver.getUsageLive!({ agent: 'gemini', model: 'gemini-2.5-pro' });

    expect(execSyncMock).toHaveBeenCalledOnce();
    expect(String(execSyncMock.mock.calls[0]?.[0])).toContain('cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
    expect(usage.ok).toBe(true);
    expect(usage.source).toBe('quota-api');
    expect(usage.status).toBe('allowed');
    expect(usage.windows.map(window => window.label)).toEqual(['Pro', 'Flash', 'Flash Lite']);
    expect(usage.windows.find(window => window.label === 'Pro')).toMatchObject({
      usedPercent: 30,
      remainingPercent: 70,
      resetAfterSeconds: 3600,
      status: 'allowed',
    });
    expect(usage.windows.find(window => window.label === 'Flash')).toMatchObject({
      usedPercent: 25,
      remainingPercent: 75,
      resetAfterSeconds: 1800,
    });
    expect(usage.windows.find(window => window.label === 'Flash Lite')).toMatchObject({
      usedPercent: 60,
      remainingPercent: 40,
      resetAfterSeconds: 2700,
    });

    const cached = getUsage({ agent: 'gemini' });
    expect(cached.ok).toBe(true);
    expect(cached.windows.map(window => window.label)).toEqual(['Pro', 'Flash', 'Flash Lite']);
  });

  it('returns a surfaced HTTP error when the live quota query fails without cached data', async () => {
    execSyncMock.mockReturnValue(JSON.stringify({ error: { message: 'invalid token' } }) + '\n401');

    const { getDriver } = await import('../src/agent-driver.ts');
    const { getUsage } = await import('../src/code-agent.ts');
    const driver = getDriver('gemini');

    const usage = await driver.getUsageLive!({ agent: 'gemini' });

    expect(usage.ok).toBe(false);
    expect(usage.error).toContain('HTTP 401');
    expect(usage.error).toContain('invalid token');
    expect(getUsage({ agent: 'gemini' }).ok).toBe(false);
  });
});

describe('Gemini session tail', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.resetModules();
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-gemini-tail-'));
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('reads prior Gemini conversation turns from native session files', async () => {
    const workdir = '/tmp/pikiclaw';
    const geminiDir = path.join(process.env.HOME!, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, 'projects.json'), JSON.stringify({
      projects: { [workdir]: 'pikiclaw' },
    }));

    const chatsDir = path.join(geminiDir, 'tmp', 'pikiclaw', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(chatsDir, 'session-2026-03-16T00-00-abc.json'), JSON.stringify({
      sessionId: 'gemini-session-1',
      startTime: '2026-03-16T00:00:00.000Z',
      lastUpdated: '2026-03-16T00:01:00.000Z',
      messages: [
        { id: '1', timestamp: '2026-03-16T00:00:00.000Z', type: 'user', content: [{ text: 'first question' }] },
        { id: '2', timestamp: '2026-03-16T00:00:10.000Z', type: 'gemini', content: '' },
        { id: '3', timestamp: '2026-03-16T00:00:20.000Z', type: 'gemini', content: 'first answer' },
        { id: '4', timestamp: '2026-03-16T00:00:30.000Z', type: 'user', content: [{ text: 'follow up' }, { text: 'with detail' }] },
        { id: '5', timestamp: '2026-03-16T00:01:00.000Z', type: 'gemini', content: 'second answer' },
      ],
      kind: 'chat',
    }, null, 2));

    const { getSessionTail } = await import('../src/code-agent.ts');
    const tail = await getSessionTail({
      agent: 'gemini',
      sessionId: 'gemini-session-1',
      workdir,
      limit: 4,
    });

    expect(tail.ok).toBe(true);
    expect(tail.messages).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'follow up\nwith detail' },
      { role: 'assistant', text: 'second answer' },
    ]);
  });
});
