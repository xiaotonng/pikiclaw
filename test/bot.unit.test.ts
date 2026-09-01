import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent/index.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/agent/index.ts')>();
  return {
    ...actual,
    doStream: vi.fn(),
    listAgents: () => ({
      agents: [
        { agent: 'claude', installed: false, path: null, version: null },
        { agent: 'codex', installed: true, path: '/usr/bin/codex', version: null },
        { agent: 'gemini', installed: false, path: null, version: null },
        { agent: 'hermes', installed: false, path: null, version: null },
      ],
    }),
  };
});

import { doStream } from '../src/agent/index.ts';
import { ensureManagedSession } from '../src/agent/index.ts';
import { Bot } from '../src/bot/bot.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';
import { makeStreamResult } from './support/stream-result.ts';

const envSnapshot = captureEnv(['PIKILOOM_CONFIG', 'PIKILOOM_WORKDIR', 'DEFAULT_AGENT']);

beforeEach(() => {
  restoreEnv(envSnapshot);
  vi.clearAllMocks();
  const tmpConfig = makeTmpDir('bot-unit-config-');
  process.env.PIKILOOM_CONFIG = `${tmpConfig}/setting.json`;
  process.env.PIKILOOM_WORKDIR = makeTmpDir('bot-unit-workdir-');
  process.env.DEFAULT_AGENT = 'codex';
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

describe('Bot.runStream', () => {
  it('manages codex cumulative totals across turns/workdir switches and resumes from a session workdir', async () => {
    delete process.env.DEFAULT_AGENT;

    const defaultBot = new Bot();

    expect(defaultBot.defaultAgent).toBe('codex');
    expect(defaultBot.chat(1).agent).toBe('codex');

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

    const bot2 = new Bot();
    const cs2 = bot2.chat(1);
    cs2.agent = 'codex';
    cs2.sessionId = 'sess-existing';
    cs2.codexCumulative = { input: 8300, output: 360, cached: 6500 };

    const nextWorkdir = makeTmpDir('bot-unit-next-');
    bot2.switchWorkdir(nextWorkdir);

    expect(cs2.sessionId).toBeNull();
    expect(cs2.codexCumulative).toBeUndefined();

    vi.mocked(doStream).mockReset();
    {
    const doStreamMock = vi.mocked(doStream);
    const bot = new Bot();
    const sessionWorkdir = makeTmpDir('bot-unit-session-workdir-');
    const workspacePath = path.join(sessionWorkdir, '.pikiloom', 'sessions', 'claude', 'session-1', 'workspace');
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
    }
  });
});

describe('Bot task lifecycle (steer / stop / reset)', () => {
  it('handoff-steers, stop-aborts-but-keeps-queued, and resets selection without interrupting tasks', async () => {
    {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-steer',
      workdir: process.env.PIKILOOM_WORKDIR!,
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
    }

    {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-stop',
      workdir: process.env.PIKILOOM_WORKDIR!,
      workspacePath: null,
      modelId: null,
    });

    const runningAbort = vi.fn();
    bot.beginTask({
      taskId: 'run-1',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'running task',
      startedAt: Date.now() - 1000,
      sourceMessageId: 200,
    });
    bot.markTaskRunning('run-1', runningAbort);

    bot.beginTask({
      taskId: 'queued-1',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'queued task 1',
      startedAt: Date.now(),
      sourceMessageId: 201,
    });
    bot.beginTask({
      taskId: 'queued-2',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'queued task 2',
      startedAt: Date.now(),
      sourceMessageId: 202,
    });

    const result = bot.stopAllSessionTasks(runtime.key);

    expect(result.interrupted).toBe(true);
    expect(result.cancelledQueued).toBe(0);
    expect(runningAbort).toHaveBeenCalledTimes(1);
    expect(bot.activeTasks.get('run-1')?.cancelled).toBe(true);
    expect(bot.activeTasks.get('queued-1')?.cancelled).toBeFalsy();
    expect(bot.activeTasks.get('queued-1')?.status).toBe('queued');
    expect(bot.activeTasks.get('queued-2')?.cancelled).toBeFalsy();
    expect(bot.activeTasks.get('queued-2')?.status).toBe('queued');
    }

    {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-prev',
      workdir: process.env.PIKILOOM_WORKDIR!,
      workspacePath: null,
      modelId: null,
    });
    bot.applySessionSelection(bot.chat(1), runtime);

    const runningAbort = vi.fn();
    bot.beginTask({
      taskId: 'run-prev',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'long task',
      startedAt: Date.now() - 1000,
      sourceMessageId: 100,
    });
    bot.markTaskRunning('run-prev', runningAbort);

    bot.beginTask({
      taskId: 'queued-prev',
      chatId: 1,
      agent: 'claude',
      sessionKey: runtime.key,
      prompt: 'queued task',
      startedAt: Date.now(),
      sourceMessageId: 101,
    });

    bot.resetConversationForChat(1);

    expect(runningAbort).not.toHaveBeenCalled();
    expect(bot.activeTasks.get('run-prev')?.status).toBe('running');
    expect(bot.activeTasks.get('queued-prev')?.cancelled).toBeFalsy();
    expect(bot.chat(1).activeSessionKey).toBeNull();
    expect(bot.chat(1).sessionId).toBeNull();
    }

    {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-idle',
      workdir: process.env.PIKILOOM_WORKDIR!,
      workspacePath: null,
      modelId: null,
    });
    bot.applySessionSelection(bot.chat(1), runtime);

    bot.resetConversationForChat(1);

    expect(bot.chat(1).activeSessionKey).toBeNull();
    }
  });
});

describe('Bot emitStream queue tracking', () => {
  it('tracks queued ids through start/cancel/done and drops the snapshot on active cancel', () => {
    {
    const bot = new Bot() as any;
    const sessionKey = 'claude:sess-multi-queue';

    bot.emitStream(sessionKey, { type: 'start', taskId: 'run-1', agent: 'claude', sessionId: 'sess-multi-queue' });
    bot.emitStream(sessionKey, { type: 'queued', taskId: 'q-1', position: 1 });
    bot.emitStream(sessionKey, { type: 'queued', taskId: 'q-2', position: 2 });
    bot.emitStream(sessionKey, { type: 'queued', taskId: 'q-3', position: 3 });

    let snap = bot.getStreamSnapshot(sessionKey);
    expect(snap?.taskId).toBe('run-1');
    expect(snap?.queuedTaskIds).toEqual(['q-1', 'q-2', 'q-3']);

    bot.emitStream(sessionKey, { type: 'cancelled', taskId: 'q-2' });
    snap = bot.getStreamSnapshot(sessionKey);
    expect(snap?.taskId).toBe('run-1');
    expect(snap?.queuedTaskIds).toEqual(['q-1', 'q-3']);

    bot.emitStream(sessionKey, { type: 'done', taskId: 'run-1', sessionId: 'sess-multi-queue' });
    snap = bot.getStreamSnapshot(sessionKey);
    expect(snap?.phase).toBe('done');
    expect(snap?.queuedTaskIds).toEqual(['q-1', 'q-3']);

    bot.emitStream(sessionKey, { type: 'start', taskId: 'q-1', agent: 'claude', sessionId: 'sess-multi-queue' });
    snap = bot.getStreamSnapshot(sessionKey);
    expect(snap?.phase).toBe('streaming');
    expect(snap?.taskId).toBe('q-1');
    expect(snap?.queuedTaskIds).toEqual(['q-3']);

    bot.emitStream(sessionKey, { type: 'done', taskId: 'q-1', sessionId: 'sess-multi-queue' });
    bot.emitStream(sessionKey, { type: 'start', taskId: 'q-3', agent: 'claude', sessionId: 'sess-multi-queue' });
    snap = bot.getStreamSnapshot(sessionKey);
    expect(snap?.taskId).toBe('q-3');
    expect(snap?.queuedTaskIds).toBeUndefined();
    }

    {
    const bot = new Bot() as any;
    const sessionKey = 'claude:sess-active-cancel';

    bot.emitStream(sessionKey, { type: 'start', taskId: 'run-1', agent: 'claude', sessionId: 'sess-active-cancel' });
    bot.emitStream(sessionKey, { type: 'queued', taskId: 'q-1', position: 1 });
    bot.emitStream(sessionKey, { type: 'cancelled', taskId: 'run-1' });

    expect(bot.getStreamSnapshot(sessionKey)).toBeNull();
    }
  });
});

describe('Bot selection switching (model / effort)', () => {
  it('preserves native Codex ultra effort when selected from chat', () => {
    const bot = new Bot() as any;
    bot.chat(1).agent = 'codex';

    bot.switchEffortForChat(1, 'ultra');

    expect(bot.effortForAgent('codex')).toBe('ultra');
    expect(bot.workflowEnabledForAgent('codex')).toBe(false);
    expect(bot.effortSelectionForAgent('codex')).toBe('ultra');

    const config = JSON.parse(fs.readFileSync(process.env.PIKILOOM_CONFIG!, 'utf8'));
    expect(config.codexReasoningEffort).toBe('ultra');
  });

  it('switches model inline or as a default, and decomposes/clears the ultra effort rung', () => {
    {
    const bot = new Bot() as any;
    const runtime = bot.upsertSessionRuntime({
      agent: 'claude',
      sessionId: 'sess-active',
      workdir: process.env.PIKILOOM_WORKDIR!,
      workspacePath: null,
      modelId: 'old-model',
    });
    bot.applySessionSelection(bot.chat(1), runtime);
    bot.setModelForAgent('claude', 'old-model');

    bot.switchModelForChat(1, 'new-model');

    expect(bot.chat(1).activeSessionKey).toBe(runtime.key);
    expect(bot.chat(1).sessionId).toBe('sess-active');
    expect(bot.chat(1).modelId).toBe('new-model');
    expect(runtime.modelId).toBe('new-model');
    expect(bot.modelForAgent('claude')).toBe('new-model');
    }

    {
    const bot = new Bot() as any;
    bot.chat(1).agent = 'claude';
    bot.setModelForAgent('claude', 'old-model');

    bot.switchModelForChat(1, 'new-model');

    expect(bot.modelForAgent('claude')).toBe('new-model');
    expect(bot.chat(1).modelId).toBe('new-model');
    expect(bot.chat(1).activeSessionKey).toBeNull();
    }

    {
    const bot = new Bot() as any;
    bot.chat(1).agent = 'claude';

    bot.switchEffortForChat(1, 'ultra');

    expect(bot.effortForAgent('claude')).toBe('max');
    expect(bot.workflowEnabledForAgent('claude')).toBe(true);
    expect(bot.effortSelectionForAgent('claude')).toBe('ultra');
    }

    {
    const bot = new Bot() as any;
    bot.chat(1).agent = 'claude';

    bot.switchEffortForChat(1, 'ultra');
    expect(bot.workflowEnabledForAgent('claude')).toBe(true);

    bot.switchEffortForChat(1, 'xhigh');
    expect(bot.effortForAgent('claude')).toBe('xhigh');
    expect(bot.workflowEnabledForAgent('claude')).toBe(false);
    expect(bot.effortSelectionForAgent('claude')).toBe('xhigh');
    }
  });

  it('folds the live-stream effort to ultra from the per-turn workflow, independent of the agent-global flag', () => {
    const bot = new Bot() as any;
    const cs = {
      agent: 'claude',
      sessionId: 'sess-live',
      workdir: process.env.PIKILOOM_WORKDIR!,
      modelId: 'claude-opus-4-8',
      thinkingEffort: 'max',
    };

    expect(bot.workflowEnabledForAgent('claude')).toBe(false);
    expect(bot.resolveSessionStreamConfig(cs).effort).toBe('max');
    expect(bot.resolveSessionStreamConfig(cs, { workflowEnabled: true }).effort).toBe('ultra');

    bot.setWorkflowEnabledForAgent('claude', true);
    expect(bot.resolveSessionStreamConfig(cs).effort).toBe('ultra');
    expect(bot.resolveSessionStreamConfig(cs, { workflowEnabled: false }).effort).toBe('max');
  });
});

describe('Bot thread-aware agent switching', () => {
  it('resumes the existing session for the target agent inside the same thread', () => {
    const workdir = process.env.PIKILOOM_WORKDIR!;
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
  it('projects queued/running image attachments into stream snapshots', () => {
    const bot = new Bot() as any;
    const workdir = process.env.PIKILOOM_WORKDIR!;
    const runtime = bot.upsertSessionRuntime({
      agent: 'codex',
      sessionId: 'sess-images',
      workdir,
      workspacePath: null,
      modelId: null,
    });
    const imagePath = path.join(workdir, 'queued-shot.png');
    fs.writeFileSync(imagePath, 'fake-image');

    bot.beginTask({
      taskId: 'img-task',
      chatId: 'dashboard',
      agent: 'codex',
      sessionKey: runtime.key,
      prompt: 'describe this',
      attachments: [imagePath],
      startedAt: Date.now(),
      sourceMessageId: 'img-task',
    });
    bot.emitStreamQueued(runtime.key, 'img-task');

    let snap = bot.getStreamSnapshot(runtime.key);
    expect(snap?.queuedTasks?.[0]).toMatchObject({ taskId: 'img-task', prompt: 'describe this' });
    expect(snap?.queuedTasks?.[0].attachments?.[0]).toMatchObject({
      type: 'image',
      imagePath,
      imageMime: 'image/png',
    });
    expect(snap?.queuedTasks?.[0].attachments?.[0].content).toContain('/api/sessions/codex/sess-images/attachment?p=');

    bot.markTaskRunning('img-task', () => {});
    bot.emitStreamStart('img-task', runtime, {});
    snap = bot.getStreamSnapshot(runtime.key);
    expect(snap?.question).toBe('describe this');
    expect(snap?.questionBlocks?.[0]).toMatchObject({ type: 'image', imagePath });
    expect(snap?.questionBlocks?.[0].content).toContain('/api/sessions/codex/sess-images/attachment?p=');
  });

  it('clears prior done artifacts when a new task enters the queue', () => {
    const bot = new Bot() as any;
    const workdir = process.env.PIKILOOM_WORKDIR!;
    const runtime = bot.upsertSessionRuntime({
      agent: 'codex',
      sessionId: 'sess-artifacts',
      workdir,
      workspacePath: null,
      modelId: null,
    });

    bot.emitStream(runtime.key, { type: 'start', taskId: 'old-task', agent: 'codex', sessionId: 'sess-artifacts', model: null, effort: null });
    bot.emitStream(runtime.key, { type: 'text', text: 'old reply', thinking: '' });
    bot.emitStream(runtime.key, {
      type: 'artifact',
      artifact: { url: '/old.png', fileName: 'old.png', fileSize: 10, mime: 'image/png', kind: 'photo' },
    });
    bot.emitStream(runtime.key, { type: 'done', taskId: 'old-task', sessionId: 'sess-artifacts', incomplete: false });
    expect(bot.getStreamSnapshot(runtime.key)?.artifacts).toHaveLength(1);

    bot.beginTask({
      taskId: 'new-task',
      chatId: 'dashboard',
      agent: 'codex',
      sessionKey: runtime.key,
      prompt: 'new turn',
      startedAt: Date.now(),
      sourceMessageId: 'new-task',
    });
    bot.emitStreamQueued(runtime.key, 'new-task');

    const snap = bot.getStreamSnapshot(runtime.key);
    expect(snap).toMatchObject({ phase: 'queued', taskId: 'new-task' });
    expect(snap?.artifacts).toBeUndefined();
    expect(snap?.text).toBeUndefined();
  });

  it('submits dashboard tasks/publishes stream state and migrates state on codex session-id promotion', async () => {
    {
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
      workdir: process.env.PIKILOOM_WORKDIR!,
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
    }

    vi.mocked(doStream).mockReset();

    {
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
      workdir: process.env.PIKILOOM_WORKDIR!,
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
    expect(bot.getStreamSnapshot('codex:pending_dashboard')).toMatchObject({
      sessionId: 'sess-promoted',
    });

    const runtime = bot.sessionStates.get('codex:sess-promoted');
    expect(runtime?.runningTaskIds.size ?? 0).toBe(0);
    expect(bot.activeTasks.size).toBe(0);
    expect(bot.sessionStates.has('codex:pending_dashboard')).toBe(false);
    }
  });
});

describe('Bot gitignore management', () => {
  it('keeps .pikiloom/skills tracked while ignoring managed runtime state', () => {
    const workdir = makeTmpDir('bot-unit-gitignore-');
    fs.writeFileSync(path.join(workdir, '.gitignore'), '.env\n.pikiloom/\n');
    process.env.PIKILOOM_WORKDIR = workdir;

    new Bot();

    expect(fs.readFileSync(path.join(workdir, '.gitignore'), 'utf8')).toBe([
      '.env',
      '.pikiloom/*',
      '!.pikiloom/skills/',
      '!.pikiloom/skills/**',
      '',
    ].join('\n'));
  });
});
