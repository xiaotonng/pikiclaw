import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

import { exec } from 'node:child_process';

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function reserveConsecutivePorts(count: number): Promise<{ basePort: number; servers: http.Server[] }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()));
    const basePort = (probe.address() as AddressInfo).port;
    await close(probe);

    const servers: http.Server[] = [];
    try {
      for (let offset = 0; offset < count; offset++) {
        const server = http.createServer((_req, res) => res.end('blocked'));
        await listen(server, basePort + offset);
        servers.push(server);
      }
      return { basePort, servers };
    } catch {
      await Promise.all(servers.map(server => close(server)));
    }
  }

  throw new Error('Unable to reserve consecutive test ports');
}

describe('dashboard startup', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens the browser once when falling back to the next port', async () => {
    const { startDashboard } = await import('../src/dashboard.ts');
    const { basePort, servers } = await reserveConsecutivePorts(1);

    try {
      const dashboard = await startDashboard({ port: basePort, open: true });
      try {
        expect(exec).toHaveBeenCalledTimes(1);
        expect(exec).toHaveBeenCalledWith(`open http://localhost:${basePort + 1}`);
      } finally {
        await dashboard.close();
      }
    } finally {
      await Promise.all(servers.map(server => close(server)));
    }
  });

  it('keeps searching for a free port when multiple dashboard ports are occupied', async () => {
    const { startDashboard } = await import('../src/dashboard.ts');
    const { basePort, servers } = await reserveConsecutivePorts(2);

    try {
      const dashboard = await startDashboard({ port: basePort, open: true });
      try {
        expect(dashboard.port).toBe(basePort + 2);
        expect(exec).toHaveBeenCalledTimes(1);
        expect(exec).toHaveBeenCalledWith(`open http://localhost:${basePort + 2}`);
      } finally {
        await dashboard.close();
      }
    } finally {
      await Promise.all(servers.map(server => close(server)));
    }
  });
});
