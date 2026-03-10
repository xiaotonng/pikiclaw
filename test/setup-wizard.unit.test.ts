import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectSetupState } from '../src/onboarding.ts';
import { runSetupWizard, type PromptIO, type TelegramTokenCheckResult } from '../src/setup-wizard.ts';
import type { AgentInfo } from '../src/code-agent.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';

class FakeIO implements PromptIO {
  answers: string[];
  output = '';
  commands: Array<{ command: string; args: string[] }> = [];
  onRun?: (command: string, args: string[]) => number | Promise<number>;

  constructor(answers: string[]) {
    this.answers = [...answers];
  }

  async ask(prompt: string): Promise<string> {
    this.output += prompt;
    return this.answers.shift() ?? '';
  }

  write(text: string) {
    this.output += text;
  }

  async runCommand(command: string, args: string[] = []): Promise<number> {
    this.commands.push({ command, args });
    if (this.onRun) return await this.onRun(command, args);
    return 0;
  }

  close() {}
}

function makeState(agents: AgentInfo[], tokenProvided = false) {
  return collectSetupState({
    agents,
    channel: 'telegram',
    tokenProvided,
    nodeVersion: '20.18.1',
  });
}

describe('setup wizard', () => {
  const envSnapshot = captureEnv(['OPENAI_API_KEY', 'HOME']);

  beforeEach(() => {
    restoreEnv(envSnapshot);
    delete process.env.OPENAI_API_KEY;
    process.env.HOME = makeTmpDir('codeclaw-setup-home-');
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('walks through install, login, token validation, and config save', async () => {
    let agents: AgentInfo[] = [
      { agent: 'claude', installed: false, path: null, version: null },
      { agent: 'codex', installed: false, path: null, version: null },
    ];
    const io = new FakeIO([
      '1',
      '',
      '',
      'bad-token',
      '123:good-token',
      '',
    ]);
    io.onRun = async (command, args) => {
      if (command === 'npm' && args.includes('@openai/codex')) {
        agents = [
          { agent: 'claude', installed: false, path: null, version: null },
          { agent: 'codex', installed: true, path: '/usr/local/bin/codex', version: 'codex-cli 0.111.0' },
        ];
        return 0;
      }
      if (command === 'codex') {
        process.env.OPENAI_API_KEY = 'test-key';
        return 0;
      }
      return 0;
    };

    const saved: Array<{ config: any }> = [];
    const validate = async (token: string): Promise<TelegramTokenCheckResult> => {
      if (token === '123:good-token') {
        return {
          ok: true,
          bot: { id: 1, username: 'codeclaw_test_bot', displayName: 'Codeclaw Test' },
          error: null,
        };
      }
      return { ok: false, bot: null, error: 'Telegram rejected this token: Unauthorized' };
    };

    const result = await runSetupWizard({
      version: '0.2.22',
      channel: 'telegram',
      argsAgent: null,
      currentToken: null,
      initialState: makeState(agents, false),
      listAgents: () => agents,
      io,
      validateTelegramToken: validate,
      persistConfig(config) {
        saved.push({ config });
        return '/tmp/codeclaw-config.json';
      },
    });

    expect(result.completed).toBe(true);
    expect(result.agent).toBe('codex');
    expect(result.token).toBe('123:good-token');
    expect(result.configPath).toBe('/tmp/codeclaw-config.json');
    expect(saved[0]?.config).toMatchObject({
      channel: 'telegram',
      defaultAgent: 'codex',
      telegramBotToken: '123:good-token',
    });
    expect(io.commands).toEqual([
      { command: 'npm', args: ['install', '-g', '@openai/codex'] },
      { command: 'codex', args: [] },
    ]);
    expect(io.output).toContain('Telegram rejected this token: Unauthorized');
    expect(io.output).toContain('Telegram bot verified: @codeclaw_test_bot (Codeclaw Test)');
  });

  it('can abort before installation', async () => {
    const io = new FakeIO([
      '2',
      'n',
    ]);
    const agents: AgentInfo[] = [
      { agent: 'claude', installed: false, path: null, version: null },
      { agent: 'codex', installed: false, path: null, version: null },
    ];

    const result = await runSetupWizard({
      version: '0.2.22',
      channel: 'telegram',
      argsAgent: null,
      currentToken: null,
      initialState: makeState(agents, false),
      listAgents: () => agents,
      io,
      validateTelegramToken: async () => ({ ok: false, bot: null, error: 'should not be called' }),
      persistConfig(config) {
        return JSON.stringify(config);
      },
    });

    expect(result.completed).toBe(false);
    expect(result.agent).toBe('claude');
    expect(io.commands).toEqual([]);
  });
});
