import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent/index.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/agent/index.ts')>();
  return {
    ...actual,
    doStream: vi.fn(),
  };
});

import { doStream } from '../src/agent/index.ts';
import { ensureManagedSession } from '../src/agent/index.ts';
import { Bot } from '../src/bot/bot.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';
import { makeStreamResult } from './support/stream-result.ts';

const envSnapshot = captureEnv(['PIKICLAW_CONFIG', 'PIKICLAW_WORKDIR', 'DEFAULT_AGENT']);

beforeEach(() => {
  restoreEnv(envSnapshot);
  vi.clearAllMocks();
  const tmpConfig = makeTmpDir('bot-unit-config-');
  process.env.PIKICLAW_CONFIG = `${tmpConfig}/setting.json`;
  process.env.PIKICLAW_WORKDIR = makeTmpDir('bot-unit-workdir-');
  process.env.DEFAULT_AGENT = 'codex';
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

describe('Bot.runStream', () => {
  it('manages codex cumulative totals across turns and workdir switches', async () => {
    // --- defaults to codex when DEFAULT_AGENT is unset ---
    delete process.env.DEFAULT_AGENT;

    const defaultBot = new Bot();

    expect(defaultBot.defaultAgent).toBe('codex');
    expect(defaultBot.chat(1).agent).toBe('codex');

    // --- passes prior Codex cumulative totals into resumed turns and stores updated totals ---
    process.env.DEFAULT_AGENT = 'codex';

    const doStreamMock = vi.mocked(doStream);
    doStreamMock
      .mockImplementationOnce(async opts => {
        expect(opts.codexPrevCumulative).toBeUndefined();
        return makeStreamResult('codex', {
          sessionId: 'sess-resume',
          inputTokens: 5000,
          cachedInputTokens: 4000,
          outputTokens: 300,
          codexCumulative: { input: 5000, output: 300, cached: 4000 },
        });
      })
      .mockImplementationOnce(async opts => {
        expect(opts.codexPrevCumulative).toEqual({ input: 5000, output: 300, cached: 4000 });
        return makeStreamResult('codex', {
          sessionId: 'sess-resume',
          message: 'Resumed turn',
          inputTokens: 3300,
          cachedInputTokens: 2500,
          outputTokens: 60,
          codexCumulative: { input: 8300, output: 360, cached: 6500 },
        });
      });

    const bot = new Bot();
    const cs = bot.chat(1);
    cs.agent = 'codex';

    await bot.runStream('start', cs, [], () => {});
    const result = await bot.runStream('continue', cs, [], () => {});

    expect(result.message).toBe('Resumed turn');
    expect(result.inputTokens).toBe(3300);
    expect(result.cachedInputTokens).toBe(2500);
    expect(result.outputTokens).toBe(60);
    expect(cs.codexCumulative).toEqual({ input: 8300, output: 360, cached: 6500 });

    // --- clears cached Codex cumulative totals when switching workdirs ---
    const bot2 = new Bot();
    const cs2 = bot2.chat(1);
    cs2.agent = 'codex';
    cs2.sessionId = 'sess-existing';
    cs2.codexCumulative = { input: 8300, output: 360, cached: 6500 };

    const nextWorkdir = makeTmpDir('bot-unit-next-');
    bot2.switchWorkdir(nextWorkdir);

    expect(cs2.sessionId).toBeNull();
    expect(cs2.codexCumulative).toBeUndefined();
  });

  it('uses the session workdir when continuing a session from another project', async () => {
    const doStreamMock = vi.mocked(doStream);
    const bot = new Bot();
    const sessionWorkdir = makeTmpDir('bot-unit-session-workdir-');
    const workspacePath = path.join(sessionWorkdir, '.pikiclaw', 'sessions', 'claude', 'session-1', 'workspace');
    const runtime: any = {
      key: 'claude:session-1',
      workdir: sessionWorkdir,
      agent: 'claude',
      sessionId: 'session-1',
      workspacePath,
      codexCumulative: undefined,
      modelId: null,
      runningTaskIds: new Set<string>(),
    };

    doStreamMock.mockImplementationOnce(async opts => {
      expect(opts.workdir).toBe(sessionWorkdir);
      return makeStreamResult('claude', {
        sessionId: 'session-1',
        workspacePath,
        elapsedS: 1,
        inputTokens: 1,
        outputTokens: 1,
      });
    });

    await bot.runStream('continue', runtime, [], () => {});
  });
});

describe('Bot steering handoff', () => {
  it('interrupts the running task and preserves its preview instead of using in-process steer', async () => {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-steer',
      workdir: process.env.PIKICLAW_WORKDIR!,
      workspacePath: null,
      modelId: null,
    });

    const runningAbort = vi.fn();
    const runningSteer = vi.fn(async () => true);
    bot.beginTask({
      taskId: 'run-1',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'first task',
      startedAt: Date.now() - 1000,
      sourceMessageId: 10,
    });
    bot.markTaskRunning('run-1', runningAbort);
    bot.activeTasks.get('run-1').steer = runningSteer;

    bot.beginTask({
      taskId: 'queued-1',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'name only',
      startedAt: Date.now(),
      sourceMessageId: 11,
    });

    const result = await bot.steerTaskByActionId(bot.actionIdForTask('queued-1'));

    expect(result.steered).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(runningSteer).not.toHaveBeenCalled();
    expect(runningAbort).toHaveBeenCalledTimes(1);
    expect(bot.activeTasks.get('run-1')?.freezePreviewOnAbort).toBe(true);
    expect(bot.activeTasks.get('queued-1')?.cancelled).toBe(false);
  });
});

describe('Bot thread-aware agent switching', () => {
  it('resumes the existing session for the target agent inside the same thread', () => {
    const workdir = process.env.PIKICLAW_WORKDIR!;
    ensureManagedSession({
      agent: 'codex',
      workdir,
      sessionId: 'sess-codex',
      title: 'codex side',
      threadId: 'thread-shared',
    });
    ensureManagedSession({
      agent: 'claude',
      workdir,
      sessionId: 'sess-claude',
      title: 'claude side',
      threadId: 'thread-shared',
    });

    const bot = new Bot();
    bot.adoptExistingSessionForChat(1, {
      agent: 'codex',
      sessionId: 'sess-codex',
      workdir,
      workspacePath: null,
      model: 'gpt-5.4',
      title: 'codex side',
      threadId: 'thread-shared',
    });

    const switched = bot.switchAgentForChat(1, 'claude');
    const selected = bot.selectedSession(1);

    expect(switched).toBe(true);
    expect(selected).toMatchObject({
      agent: 'claude',
      sessionId: 'sess-claude',
      threadId: 'thread-shared',
    });
    expect(bot.chat(1).activeThreadId).toBe('thread-shared');

    bot.switchAgentForChat(1, 'codex');
    expect(bot.selectedSession(1)).toMatchObject({
      agent: 'codex',
      sessionId: 'sess-codex',
      threadId: 'thread-shared',
    });
  });
});

describe('Bot external session control', () => {
  it('submits dashboard session tasks through the public API and publishes stream state', async () => {
    const doStreamMock = vi.mocked(doStream);
    doStreamMock.mockImplementationOnce(async opts => {
      opts.onText('partial reply', 'thinking...');
      return makeStreamResult('codex', {
        sessionId: 'sess-dashboard',
        message: 'done',
        elapsedS: 1,
      });
    });

    const bot = new Bot();
    const submitted = bot.submitSessionTask({
      agent: 'codex',
      sessionId: 'sess-dashboard',
      workdir: process.env.PIKICLAW_WORKDIR!,
      prompt: 'continue',
    });

    expect(submitted.ok).toBe(true);
    expect(submitted.sessionKey).toBe('codex:sess-dashboard');
    await new Promise(resolve => setImmediate(resolve));

    expect(bot.getStreamSnapshot('codex:sess-dashboard')).toMatchObject({
      phase: 'done',
      taskId: submitted.taskId,
      sessionId: 'sess-dashboard',
      text: 'partial reply',
      thinking: 'thinking...',
    });
  });

  it('migrates dashboard stream state and runtime tracking when codex promotes a pending session id', async () => {
    const doStreamMock = vi.mocked(doStream);
    doStreamMock.mockImplementationOnce(async opts => {
      opts.onSessionId?.('sess-promoted');
      opts.onText('partial reply', 'thinking...');
      return makeStreamResult('codex', {
        sessionId: 'sess-promoted',
        message: 'done',
        elapsedS: 1,
      });
    });

    const bot = new Bot();
    const submitted = bot.submitSessionTask({
      agent: 'codex',
      sessionId: 'pending_dashboard',
      workdir: process.env.PIKICLAW_WORKDIR!,
      prompt: 'continue',
    });

    expect(submitted.ok).toBe(true);
    const deadline = Date.now() + 1000;
    let promotedSnapshot = bot.getStreamSnapshot('codex:sess-promoted');
    while (!promotedSnapshot && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      promotedSnapshot = bot.getStreamSnapshot('codex:sess-promoted');
    }

    expect(promotedSnapshot).toMatchObject({
      phase: 'done',
      taskId: submitted.taskId,
      sessionId: 'sess-promoted',
      text: 'partial reply',
      thinking: 'thinking...',
    });
    // After promotion, the old key transparently redirects to the promoted snapshot
    expect(bot.getStreamSnapshot('codex:pending_dashboard')).toMatchObject({
      sessionId: 'sess-promoted',
    });

    const runtime = bot.sessionStates.get('codex:sess-promoted');
    expect(runtime?.runningTaskIds.size ?? 0).toBe(0);
    expect(bot.activeTasks.size).toBe(0);
    expect(bot.sessionStates.has('codex:pending_dashboard')).toBe(false);
  });
});

describe('Bot gitignore management', () => {
  it('keeps .pikiclaw/skills tracked while ignoring managed runtime state', () => {
    const workdir = makeTmpDir('bot-unit-gitignore-');
    fs.writeFileSync(path.join(workdir, '.gitignore'), '.env\n.pikiclaw/\n');
    process.env.PIKICLAW_WORKDIR = workdir;

    new Bot();

    expect(fs.readFileSync(path.join(workdir, '.gitignore'), 'utf8')).toBe([
      '.env',
      '.pikiclaw/*',
      '!.pikiclaw/skills/',
      '!.pikiclaw/skills/**',
      '',
    ].join('\n'));
  });
});
