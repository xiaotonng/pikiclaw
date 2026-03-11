import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../dashboard/src/api.ts';

describe('dashboard api', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('times out hung Feishu validation requests on the client side', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    await expect(
      api.validateFeishuConfig('cli_xxx', 'secret-value', { timeoutMs: 25 }),
    ).rejects.toThrow(/timed out/i);
  });
});
