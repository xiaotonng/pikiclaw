import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getBotRefMock,
  runtimeMock,
} = vi.hoisted(() => {
  const getBotRefMock = vi.fn();
  return {
    getBotRefMock,
    runtimeMock: {
      getBotRef: getBotRefMock,
    },
  };
});

vi.mock('../src/dashboard/runtime.ts', () => ({
  runtime: runtimeMock,
}));

describe('session-control', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('queues dashboard tasks through the public bot API', async () => {
    const submitSessionTask = vi.fn(() => ({ ok: true, queued: true, taskId: 'task-1', sessionKey: 'codex:sess-1' }));
    getBotRefMock.mockReturnValue({ submitSessionTask });

    const { queueDashboardSessionTask } = await import('../src/dashboard/session-control.ts');
    const result = await queueDashboardSessionTask({
      workdir: '/tmp/pikiclaw',
      agent: 'codex',
      sessionId: 'sess-1',
      prompt: 'check',
      attachments: ['/tmp/a.png'],
    });

    expect(submitSessionTask).toHaveBeenCalledWith({
      workdir: '/tmp/pikiclaw',
      agent: 'codex',
      sessionId: 'sess-1',
      prompt: 'check',
      attachments: ['/tmp/a.png'],
    });
    expect(result).toEqual({ ok: true, queued: true, taskId: 'task-1', sessionKey: 'codex:sess-1' });
  });

  it('surfaces stream state, cancel, and steer through public bot methods', async () => {
    const cancelTask = vi.fn(() => ({ cancelled: true, interrupted: false, task: {} }));
    const steerTask = vi.fn(async () => ({ steered: true, interrupted: true, task: {} }));
    getBotRefMock.mockReturnValue({
      getStreamSnapshot: vi.fn(() => ({ phase: 'queued', taskId: 'task-1', updatedAt: 1 })),
      cancelTask,
      steerTask,
    });

    const {
      cancelSessionTask,
      getSessionStreamState,
      steerSessionTask,
    } = await import('../src/dashboard/session-control.ts');

    expect(getSessionStreamState('codex', 'sess-1')).toEqual({
      ok: true,
      state: { phase: 'queued', taskId: 'task-1', updatedAt: 1 },
    });
    expect(cancelSessionTask('task-1')).toEqual({ ok: true, recalled: true });
    expect(await steerSessionTask('task-1')).toEqual({ ok: true, steered: true });
  });
});
