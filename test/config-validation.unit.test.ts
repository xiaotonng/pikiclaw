import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateFeishuConfig, validateTelegramConfig } from '../src/config-validation.ts';

describe('config validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('rejects malformed Telegram allowed chat IDs before calling Telegram', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await validateTelegramConfig('123:test-token', 'abc,123');

    expect(result.state.ready).toBe(false);
    expect(result.state.status).toBe('invalid');
    expect(result.state.detail).toContain('Allowed Chat IDs');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies Telegram token and normalizes allowed chat IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        result: { id: 1, username: 'codeclaw_bot', first_name: 'Codeclaw' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await validateTelegramConfig('123:test-token', '1, 2,2,-3');

    expect(result.state.ready).toBe(true);
    expect(result.state.status).toBe('ready');
    expect(result.state.detail).toContain('@codeclaw_bot');
    expect(result.normalizedAllowedChatIds).toBe('1,2,-3');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires both Feishu app ID and secret', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await validateFeishuConfig('cli_xxx', '');

    expect(result.state.ready).toBe(false);
    expect(result.state.status).toBe('invalid');
    expect(result.state.detail).toContain('App ID and App Secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies Feishu credentials against the auth endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        tenant_access_token: 'tenant-token',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await validateFeishuConfig('cli_xxx', 'secret-value');

    expect(result.state.ready).toBe(true);
    expect(result.state.status).toBe('ready');
    expect(result.state.detail).toContain('cli_xxx');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out hung Feishu validation requests', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    const pending = validateFeishuConfig('cli_xxx', 'secret-value', { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    const result = await pending;

    expect(result.state.ready).toBe(false);
    expect(result.state.status).toBe('error');
    expect(result.state.detail).toContain('timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
