import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../dashboard/src/api.ts';

describe('dashboard api', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('times out hung Feishu validation requests and builds agent/session requests', async () => {
    // --- Feishu timeout scenario ---
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (signal?.aborted) {
        reject(abortError);
        return;
      }
      signal?.addEventListener('abort', () => reject(abortError), { once: true });
    })));

    await expect(
      api.validateFeishuConfig('cli_xxx', 'secret-value', { timeoutMs: 25 }),
    ).rejects.toThrow(/timed out/i);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    // --- Paginated session requests scenario ---
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      sessions: [],
      error: null,
      page: 2,
      limit: 6,
      total: 0,
      totalPages: 1,
      hasMore: false,
    })));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSessionsPage('codex', 2, 6);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/codex?page=2&limit=6');

    fetchMock.mockClear();
    await api.installAgent('gemini');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/agent-install');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ agent: 'gemini' }));

    fetchMock.mockClear();
    const file = new File(['image-bytes'], 'image.png', { type: 'image/png' });
    await api.sendSessionMessage('/tmp/pikiclaw', 'codex', 'session-1', 'inspect this', [file]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/session-hub/session/send');
    const sendInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(sendInit.method).toBe('POST');
    expect(sendInit.body).toBeInstanceOf(FormData);
    const form = sendInit.body as FormData;
    expect(form.get('workdir')).toBe('/tmp/pikiclaw');
    expect(form.get('agent')).toBe('codex');
    expect(form.get('sessionId')).toBe('session-1');
    expect(form.get('prompt')).toBe('inspect this');
    const attachment = form.get('attachments');
    expect(attachment).toBeInstanceOf(File);
    expect((attachment as File).name).toBe('image.png');

    fetchMock.mockClear();
    await api.getSessionMessages('/tmp/pikiclaw', 'claude', 'session-2', { turnOffset: 24, turnLimit: 12 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/session-hub/session/messages');
    const messagesInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(messagesInit.method).toBe('POST');
    expect(messagesInit.body).toBe(JSON.stringify({
      workdir: '/tmp/pikiclaw',
      agent: 'claude',
      sessionId: 'session-2',
      rich: true,
      lastNTurns: undefined,
      turnOffset: 24,
      turnLimit: 12,
    }));
  });
});
