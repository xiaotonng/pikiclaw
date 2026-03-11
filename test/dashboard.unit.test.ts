import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveUserConfig } from '../src/user-config.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';

const {
  listAgentsMock,
  validateTelegramConfigMock,
  validateFeishuConfigMock,
} = vi.hoisted(() => ({
  listAgentsMock: vi.fn(),
  validateTelegramConfigMock: vi.fn(),
  validateFeishuConfigMock: vi.fn(),
}));

vi.mock('../src/dashboard-ui.ts', () => ({
  getDashboardHtml: () => '<!doctype html><html><body>dashboard</body></html>',
}));

vi.mock('../src/code-agent.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/code-agent.ts')>();
  return {
    ...actual,
    listAgents: listAgentsMock,
  };
});

vi.mock('../src/config-validation.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config-validation.ts')>();
  return {
    ...actual,
    validateTelegramConfig: validateTelegramConfigMock,
    validateFeishuConfig: validateFeishuConfigMock,
  };
});

const envSnapshot = captureEnv(['CODECLAW_CONFIG_DIR', 'HOME']);

describe('dashboard state API', () => {
  beforeEach(() => {
    restoreEnv(envSnapshot);
    process.env.CODECLAW_CONFIG_DIR = makeTmpDir('dashboard-config-');
    process.env.HOME = makeTmpDir('dashboard-home-');
    vi.clearAllMocks();
    listAgentsMock.mockReturnValue({
      agents: [
        { agent: 'codex', installed: true, version: 'codex-cli 0.111.0', path: '/usr/local/bin/codex' },
      ],
    });
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('returns live channel validation state for /api/state', async () => {
    saveUserConfig({
      telegramBotToken: '123:test-token',
      feishuAppId: 'cli_xxx',
    });
    validateTelegramConfigMock.mockResolvedValue({
      state: {
        channel: 'telegram',
        configured: true,
        ready: false,
        validated: true,
        status: 'invalid',
        detail: 'Telegram rejected this token: Unauthorized',
      },
      bot: null,
      normalizedAllowedChatIds: '',
    });
    validateFeishuConfigMock.mockResolvedValue({
      state: {
        channel: 'feishu',
        configured: true,
        ready: false,
        validated: true,
        status: 'invalid',
        detail: 'Both App ID and App Secret are required.',
      },
      app: null,
    });

    const { startDashboard } = await import('../src/dashboard.ts');
    const server = await startDashboard({
      open: false,
      port: 4300 + Math.floor(Math.random() * 200),
    });

    try {
      const response = await fetch(`${server.url}/api/state`);
      expect(response.status).toBe(200);

      const body = await response.json() as {
        setupState: { channels: Array<{ channel: string; configured: boolean; ready: boolean; validated: boolean; status: string }> };
      };

      expect(body.setupState.channels).toEqual([
        expect.objectContaining({
          channel: 'telegram',
          configured: true,
          ready: false,
          validated: true,
          status: 'invalid',
        }),
        expect.objectContaining({
          channel: 'feishu',
          configured: true,
          ready: false,
          validated: true,
          status: 'invalid',
        }),
      ]);
      expect(validateTelegramConfigMock).toHaveBeenCalledWith('123:test-token', undefined);
      expect(validateFeishuConfigMock).toHaveBeenCalledWith('cli_xxx', undefined);
    } finally {
      await server.close();
    }
  });
});
