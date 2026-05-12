import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prepareMock = vi.fn();
const forceCloseMock = vi.fn();

vi.mock('../src/browser-profile.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser-profile.ts')>();
  return {
    ...actual,
    prepareManagedBrowserForAutomation: (...args: unknown[]) => prepareMock(...args),
    forceCloseManagedBrowser: (...args: unknown[]) => forceCloseMock(...args),
  };
});

const supervisor = await import('../src/browser-supervisor.ts');

describe('browser-supervisor', () => {
  beforeEach(() => {
    supervisor._resetManagedBrowserSupervisor();
    prepareMock.mockReset();
    forceCloseMock.mockReset();
    forceCloseMock.mockResolvedValue([]);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coalesces concurrent ensure() calls into a single prepare invocation', async () => {
    prepareMock.mockResolvedValue({
      profileDir: '/tmp/profile',
      closedPids: [],
      cdpEndpoint: 'http://127.0.0.1:39222',
      connectionMode: 'launch',
    });
    // Make the cached endpoint look healthy so subsequent ensure() calls within
    // the cache window do not even reach the prepare path.
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) {
        return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 });
      }
      if (url.endsWith('/json')) {
        return new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 });
      }
      return new Response('', { status: 404 });
    }));

    const [a, b, c] = await Promise.all([
      supervisor.ensureManagedBrowser(),
      supervisor.ensureManagedBrowser(),
      supervisor.ensureManagedBrowser(),
    ]);

    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(a.cdpEndpoint).toBe('http://127.0.0.1:39222');
    expect(b.cdpEndpoint).toBe('http://127.0.0.1:39222');
    expect(c.cdpEndpoint).toBe('http://127.0.0.1:39222');
  });

  it('reuses the cached endpoint across calls instead of relaunching Chrome', async () => {
    prepareMock.mockResolvedValue({
      profileDir: '/tmp/profile',
      closedPids: [],
      cdpEndpoint: 'http://127.0.0.1:39222',
      connectionMode: 'launch',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) {
        return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 });
      }
      if (url.endsWith('/json')) {
        return new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 });
      }
      return new Response('', { status: 404 });
    }));

    await supervisor.ensureManagedBrowser();
    await supervisor.ensureManagedBrowser();
    await supervisor.ensureManagedBrowser();

    expect(prepareMock).toHaveBeenCalledTimes(1);
  });

  it('re-prepares after invalidate() drops the cache', async () => {
    prepareMock.mockResolvedValue({
      profileDir: '/tmp/profile',
      closedPids: [],
      cdpEndpoint: 'http://127.0.0.1:39222',
      connectionMode: 'attach',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) {
        return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 });
      }
      if (url.endsWith('/json')) {
        return new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 });
      }
      return new Response('', { status: 404 });
    }));

    await supervisor.ensureManagedBrowser();
    expect(prepareMock).toHaveBeenCalledTimes(1);

    supervisor.invalidateManagedBrowser();
    await supervisor.ensureManagedBrowser();
    expect(prepareMock).toHaveBeenCalledTimes(2);
  });

  it('probe() does not trigger Chrome launch when nothing is cached', async () => {
    const snapshot = await supervisor.probeManagedBrowser();

    expect(prepareMock).not.toHaveBeenCalled();
    expect(snapshot).toEqual({ cdpEndpoint: null, connectionMode: 'unavailable' });
  });

  it('treats /json/version alone as unhealthy when /json times out (stuck CDP dispatcher)', async () => {
    prepareMock.mockResolvedValue({
      profileDir: '/tmp/profile',
      closedPids: [],
      cdpEndpoint: 'http://127.0.0.1:39222',
      connectionMode: 'attach',
    });
    // Switch /json behaviour between calls: healthy on first ensure, then hung
    // on the post-cache-expiry revalidation.
    let jsonShouldHang = false;
    vi.stubGlobal('fetch', vi.fn((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) {
        return Promise.resolve(new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 }));
      }
      if (!jsonShouldHang) {
        return Promise.resolve(new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal: AbortSignal | undefined = init?.signal;
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await supervisor.ensureManagedBrowser();
      expect(prepareMock).toHaveBeenCalledTimes(1);

      // Step past the 30s cache window so the next ensure() re-validates.
      jsonShouldHang = true;
      vi.setSystemTime(Date.now() + 60_000);

      await supervisor.ensureManagedBrowser();
      expect(prepareMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats /json returning a non-array (e.g. error HTML) as unhealthy', async () => {
    prepareMock.mockResolvedValue({
      profileDir: '/tmp/profile',
      closedPids: [],
      cdpEndpoint: 'http://127.0.0.1:39222',
      connectionMode: 'attach',
    });
    let jsonReturnsHtml = false;
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) {
        return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 });
      }
      if (jsonReturnsHtml) {
        return new Response('<html>error</html>', { status: 200 });
      }
      return new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 });
    }));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await supervisor.ensureManagedBrowser();
      expect(prepareMock).toHaveBeenCalledTimes(1);

      jsonReturnsHtml = true;
      vi.setSystemTime(Date.now() + 60_000);

      await supervisor.ensureManagedBrowser();
      expect(prepareMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('probe() returns the cached endpoint after a successful ensure()', async () => {
    prepareMock.mockResolvedValue({
      profileDir: '/tmp/profile',
      closedPids: [],
      cdpEndpoint: 'http://127.0.0.1:39222',
      connectionMode: 'attach',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) {
        return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 });
      }
      if (url.endsWith('/json')) {
        return new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 });
      }
      return new Response('', { status: 404 });
    }));

    await supervisor.ensureManagedBrowser();
    const probe = await supervisor.probeManagedBrowser();

    expect(probe.cdpEndpoint).toBe('http://127.0.0.1:39222');
    // Probe alone should not invoke prepare again.
    expect(prepareMock).toHaveBeenCalledTimes(1);
  });

  it('restartManagedBrowser invokes forceClose and clears the cache', async () => {
    prepareMock.mockResolvedValue({
      profileDir: '/tmp/profile',
      closedPids: [],
      cdpEndpoint: 'http://127.0.0.1:39222',
      connectionMode: 'attach',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 });
      if (url.endsWith('/json')) return new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 });
      return new Response('', { status: 404 });
    }));

    await supervisor.ensureManagedBrowser();
    expect(supervisor.getCachedManagedBrowserEndpoint()).toBe('http://127.0.0.1:39222');

    await supervisor.restartManagedBrowser('test');
    expect(forceCloseMock).toHaveBeenCalledTimes(1);
    expect(supervisor.getCachedManagedBrowserEndpoint()).toBeNull();

    // Next ensure() should re-prepare since the cache was cleared.
    await supervisor.ensureManagedBrowser();
    expect(prepareMock).toHaveBeenCalledTimes(2);
  });

  it('restartManagedBrowser is throttled within the cooldown window', async () => {
    await supervisor.restartManagedBrowser('first');
    await supervisor.restartManagedBrowser('second');
    await supervisor.restartManagedBrowser('third');
    expect(forceCloseMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent restartManagedBrowser calls share a single in-flight force-close', async () => {
    let resolveForce: (() => void) | null = null;
    forceCloseMock.mockReset();
    forceCloseMock.mockImplementation(() => new Promise<number[]>(r => {
      resolveForce = () => r([]);
    }));

    const a = supervisor.restartManagedBrowser('a');
    const b = supervisor.restartManagedBrowser('b');
    const c = supervisor.restartManagedBrowser('c');
    expect(forceCloseMock).toHaveBeenCalledTimes(1);

    resolveForce!();
    await Promise.all([a, b, c]);
    expect(forceCloseMock).toHaveBeenCalledTimes(1);
  });
});
