import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  querySessionsMock,
  getBotRefMock,
  sessionHubMocks,
} = vi.hoisted(() => {
  const querySessionsMock = vi.fn();
  const getBotRefMock = vi.fn();
  const sessionHubMocks = {
    querySessions: querySessionsMock,
    querySessionTail: vi.fn(),
    querySessionMessages: vi.fn(),
    getWorkspaceOverviews: vi.fn(),
    updateSession: vi.fn(),
    linkSessions: vi.fn(),
    buildMigrationContext: vi.fn(),
    exportSession: vi.fn(),
    importSession: vi.fn(),
    loadWorkspaces: vi.fn(() => []),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    resolveUserStatus: vi.fn(() => 'inbox'),
  };
  return { querySessionsMock, getBotRefMock, sessionHubMocks };
});

vi.mock('../src/session-hub.ts', () => sessionHubMocks);

vi.mock('../src/runtime.ts', () => ({
  runtime: {
    getBotRef: getBotRefMock,
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('session routes', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('enriches session hub responses with active runtime status for dashboard lists', async () => {
    querySessionsMock.mockResolvedValue({
      ok: true,
      workdir: '/tmp/pikiclaw',
      workspaceName: 'pikiclaw',
      sessions: [
        {
          sessionId: 'session-1',
          agent: 'codex',
          workdir: '/tmp/pikiclaw',
          workspacePath: '/tmp/pikiclaw/.pikiclaw/sessions/codex/session-1/workspace',
          model: 'gpt-5-codex',
          createdAt: '2026-03-27T10:00:00.000Z',
          title: 'Fix dashboard status',
          running: false,
          runState: 'completed',
          runDetail: null,
          runUpdatedAt: '2026-03-27T10:05:00.000Z',
          classification: null,
          userStatus: null,
          userNote: null,
          lastQuestion: '这里的状态还是不对，因为这个任务正在进行中。',
          lastAnswer: null,
          migratedFrom: null,
          migratedTo: null,
          linkedSessions: [],
          numTurns: 3,
        },
      ],
      statusCounts: { inbox: 1, active: 0, review: 0, done: 0, parked: 0, unknown: 0 },
      total: 1,
      errors: [],
    });

    getBotRefMock.mockReturnValue({
      sessionStates: new Map([
        ['codex:session-1', {
          key: 'codex:session-1',
          workdir: '/tmp/pikiclaw',
          agent: 'codex',
          sessionId: 'session-1',
          workspacePath: null,
          threadId: null,
          codexCumulative: undefined,
          modelId: 'gpt-5-codex',
          runningTaskIds: new Set(['task-1']),
        }],
      ]),
      chats: new Map(),
    });

    const app = (await import('../src/routes/sessions.ts')).default;
    const response = await app.request('/api/session-hub/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workdir: '/tmp/pikiclaw' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(querySessionsMock).toHaveBeenCalledWith({
      workdir: '/tmp/pikiclaw',
      agent: undefined,
      userStatus: undefined,
      limit: undefined,
    });
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      sessionId: 'session-1',
      running: true,
      runState: 'running',
      isCurrent: false,
    });
  });
});
