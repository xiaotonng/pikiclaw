import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ pid: 4321, unref: vi.fn() })),
  };
});

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TelegramBot, buildArtifactPrompt } from '../src/bot-telegram.ts';
import { TelegramChannel } from '../src/channel-telegram.ts';
import type { Agent, StreamResult } from '../src/code-agent.ts';
import { makeTmpDir } from './support/env.ts';
import { makeStreamResult } from './support/stream-result.ts';
import { createTelegramBotHarness } from './support/telegram-bot-harness.ts';

function createBot() {
  return createTelegramBotHarness();
}

const claudeResult = (overrides: Partial<StreamResult> = {}) => makeStreamResult('claude', overrides);
const codexResult = (overrides: Partial<StreamResult> = {}) => makeStreamResult('codex', overrides);

async function renderFinalReply(
  agent: Agent,
  overrides: Partial<StreamResult>,
  messageId = 100,
) {
  const harness = createBot();
  await (harness.bot as any).sendFinalReply(harness.ctx, messageId, agent, makeStreamResult(agent, overrides));
  expect(harness.edits).toHaveLength(1);
  return { ...harness, finalEdit: harness.edits[0] };
}

function previewTexts(edits: Array<{ text: string; opts?: any }>): string[] {
  return edits.slice(0, -1).map(entry => entry.text);
}

function previewText(edits: Array<{ text: string; opts?: any }>): string {
  return previewTexts(edits).join('\n\n');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  const tmpDir = makeTmpDir('bot-tg-unit-');
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.CODECLAW_WORKDIR = tmpDir;
  process.env.DEFAULT_AGENT = 'claude';
  delete process.env.CODECLAW_RESTART_CMD;
  delete process.env.npm_config_yes;
});

describe('TelegramBot.sendFinalReply', () => {
  it('compresses warnings, footers, and command activity into a minimal final reply', async () => {
    const failed = await renderFinalReply('claude', {
      ok: false,
      message: 'Should I continue?',
      elapsedS: 17.2,
      inputTokens: 3,
      outputTokens: 178,
      error: 'Claude hit usage limit',
      incomplete: true,
    }, 99);
    expect(failed.finalEdit.text).toContain('Incomplete Response');
    expect(failed.finalEdit.text).toContain('Claude hit usage limit');
    expect(failed.finalEdit.text).toContain('✗ claude · 17s');
    expect(failed.finalEdit.opts?.keyboard).toBeUndefined();

    const truncated = await renderFinalReply('claude', {
      message: 'Answer stopped mid-way',
      elapsedS: 9.4,
      inputTokens: 12,
      outputTokens: 999,
      stopReason: 'max_tokens',
      incomplete: true,
    });
    expect(truncated.finalEdit.text).toContain('Output limit reached. Response may be truncated.');

    const summarized = await renderFinalReply('codex', {
      message: 'Build finished.',
      elapsedS: 85,
      inputTokens: 120,
      outputTokens: 18,
      cachedInputTokens: 30,
      contextWindow: 200000,
      contextUsedTokens: 150,
      contextPercent: 25.7,
      activity: 'Ran: /bin/zsh -lc npm run build\nRan: /bin/zsh -lc npm test',
    });
    expect(summarized.finalEdit.text).toContain('✓ codex · 25.7% · 1m25s');
    expect(summarized.finalEdit.text).toContain('<i>commands: 2 done</i>');
    expect(summarized.finalEdit.text).not.toContain('cached:');
    expect(summarized.finalEdit.text).not.toContain('npm run build');
    expect(summarized.finalEdit.text).not.toContain('npm test');
  });
});

describe('TelegramBot.run shutdown handling', () => {
  it('exits after SIGINT and treats shutdown as idempotent', async () => {
    const bot = new TelegramBot();
    const logLines: string[] = [];
    const onceHandlers = new Map<string, () => void>();
    const onHandlers = new Map<string, () => void>();
    let releaseListen: (() => void) | null = null;

    const connectSpy = vi.spyOn(TelegramChannel.prototype, 'connect').mockResolvedValue({
      id: 1,
      username: 'codeclaw_test_bot',
      displayName: 'Codeclaw Test Bot',
    });
    const drainSpy = vi.spyOn(TelegramChannel.prototype, 'drain').mockResolvedValue(0);
    const listenSpy = vi.spyOn(TelegramChannel.prototype, 'listen').mockImplementation(async () => {
      await new Promise<void>(resolve => {
        releaseListen = resolve;
      });
    });
    const disconnectSpy = vi.spyOn(TelegramChannel.prototype, 'disconnect').mockImplementation(() => {
      releaseListen?.();
    });
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
      onceHandlers.set(event, handler);
      return process;
    }) as any);
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
      onHandlers.set(event, handler);
      return process;
    }) as any);
    const offSpy = vi.spyOn(process, 'off').mockImplementation(((event: string, _handler: () => void) => process) as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const setupMenuSpy = vi.spyOn(bot as any, 'setupMenu').mockResolvedValue(undefined);
    const startupSpy = vi.spyOn(bot as any, 'sendStartupNotice').mockResolvedValue(undefined);
    const startKeepAliveSpy = vi.spyOn(bot as any, 'startKeepAlive').mockImplementation(() => {});
    const stopKeepAliveSpy = vi.spyOn(bot as any, 'stopKeepAlive').mockImplementation(() => {});
    const logSpy = vi.spyOn(bot, 'log').mockImplementation((msg: string) => {
      logLines.push(msg);
    });

    try {
      const runPromise = bot.run();
      await new Promise(resolve => setImmediate(resolve));

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(drainSpy).toHaveBeenCalledTimes(1);
      expect(listenSpy).toHaveBeenCalledTimes(1);
      expect(setupMenuSpy).toHaveBeenCalledTimes(1);
      expect(startupSpy).toHaveBeenCalledTimes(1);
      expect(startKeepAliveSpy).toHaveBeenCalledTimes(1);
      expect(onceSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(onceSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith('SIGUSR2', expect.any(Function));

      onceHandlers.get('SIGINT')?.();
      onceHandlers.get('SIGINT')?.();
      await runPromise;

      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      expect(stopKeepAliveSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(logLines.filter(line => line === 'SIGINT, shutting down...')).toHaveLength(1);
      expect(offSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(offSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(offSpy).toHaveBeenCalledWith('SIGUSR2', expect.any(Function));
    } finally {
      logSpy.mockRestore();
      stopKeepAliveSpy.mockRestore();
      startKeepAliveSpy.mockRestore();
      startupSpy.mockRestore();
      setupMenuSpy.mockRestore();
      exitSpy.mockRestore();
      offSpy.mockRestore();
      onSpy.mockRestore();
      onceSpy.mockRestore();
      disconnectSpy.mockRestore();
      listenSpy.mockRestore();
      drainSpy.mockRestore();
      connectSpy.mockRestore();
    }
  });
});

describe('TelegramBot status and session previews', () => {
  it('hides artifact system prompts from status output', async () => {
    const { bot, ctx } = createBot();
    const replies: Array<{ text: string; opts?: any }> = [];
    ctx.reply = vi.fn(async (text: string, opts?: any) => {
      replies.push({ text, opts });
      return 1;
    });

    bot.activeTasks.set(ctx.chatId, {
      prompt: buildArtifactPrompt('进度怎么样\n第二行', '/tmp/codeclaw-artifacts/turn-1', '/tmp/codeclaw-artifacts/turn-1/manifest.json'),
      startedAt: Date.now() - 65_000,
    });

    await (bot as any).cmdStatus(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain('<b>Running:</b>');
    expect(replies[0].text).toContain('进度怎么样 第二行');
    expect(replies[0].text).not.toContain('[Telegram Artifact Return]');
    expect(replies[0].text).not.toContain('manifest.json');
  });

  it('renders resumed history as quoted user text plus normal assistant markdown', async () => {
    const { bot, ctx, sends } = createBot();
    const localSessionId = 'sess-history-preview';
    const engineSessionId = 'engine-history-preview';

    vi.spyOn(bot, 'fetchSessions').mockResolvedValue({
      ok: true,
      sessions: [{
        sessionId: engineSessionId,
        localSessionId,
        engineSessionId,
        agent: 'claude',
        workdir: process.env.CODECLAW_WORKDIR!,
        workspacePath: path.join(process.env.CODECLAW_WORKDIR!, '.codeclaw', 'sessions', 'claude', localSessionId, 'workspace'),
        model: 'claude-opus-4-6',
        createdAt: new Date().toISOString(),
        title: 'history preview',
        running: false,
      }],
      error: null,
    });

    vi.spyOn(bot, 'fetchSessionTail').mockResolvedValue({
      ok: true,
      messages: [
        { role: 'user', text: '请总结这次修改\n第二行保留原样' },
        { role: 'assistant', text: '# Summary\nUse **bold** and `code`.\n\n```ts\nconst x = 1;\n```' },
      ],
      error: null,
    });

    await bot.handleCallback(`sess:${localSessionId}`, ctx as any);

    expect(ctx.editReply).toHaveBeenCalledWith(
      ctx.messageId,
      `Switched to session: <code>${localSessionId.slice(0, 16)}</code>`,
      { parseMode: 'HTML' },
    );
    expect(bot.chat(ctx.chatId).sessionId).toBe(engineSessionId);
    expect(bot.chat(ctx.chatId).localSessionId).toBe(localSessionId);
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('<blockquote expandable>请总结这次修改\n第二行保留原样</blockquote>');
    expect(sends[0].text).toContain('<b>Summary</b>');
    expect(sends[0].text).toContain('<pre><code class="language-ts">const x = 1;</code></pre>');
  });
});

describe('TelegramBot.handleMessage streaming', () => {
  it('streams sanitized previews, keeps elapsed updates alive, and finalizes in place', async () => {
    vi.useFakeTimers();
    const { bot, ctx, channel, sends, edits } = createBot();
    ctx.raw = { chat: { type: 'private' }, message_thread_id: 42 };
    bot.chat(ctx.chatId).agent = 'codex';

    const thinking = '先读代码路径\n再看 streaming 触发条件\n\n最后确认只需要展示 reasoning 的尾段就够了';

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('**Partial** `answer`', '', '改动已经落下去了，现在跑相关单测确认结果\nRan: /bin/zsh -lc npm run build\n$ /bin/zsh -lc pwd');
      await new Promise(resolve => setTimeout(resolve, 12_000));
      onText('', thinking, '', {
        inputTokens: 120,
        cachedInputTokens: 30,
        outputTokens: 18,
        contextPercent: 4.2,
      }, {
        explanation: 'Investigating',
        steps: [
          { step: 'Inspect streaming paths', status: 'completed' },
          { step: 'Keep previews terse', status: 'inProgress' },
        ],
      });
      return codexResult({
        message: 'Final answer.',
        thinking,
        sessionId: 'sess-streaming',
        elapsedS: 12,
        inputTokens: 120,
        outputTokens: 18,
        cachedInputTokens: 30,
        contextWindow: 200000,
        contextUsedTokens: 150,
        contextPercent: 4.2,
      });
    });

    try {
      const pending = (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);
      await vi.advanceTimersByTimeAsync(12_000);
      await pending;

      expect((channel as any).sendMessageDraft).toBeUndefined();
      expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
        expect.stringContaining('● codex · 0s'),
        expect.objectContaining({ messageThreadId: 42, parseMode: 'HTML' }),
      );
      expect(sends).toHaveLength(0);

      const previews = previewText(edits);
      expect(previews).toContain('改动已经落下去了，现在跑相关单测确认结果');
      expect(previews).toContain('最后确认只需要展示 reasoning 的尾段就够了');
      expect(previews).toContain('Plan 1/2');
      expect(previews).toContain('● codex · 4.2% · ');
      expect(previews).toContain('● codex · 5s');
      expect(previews).toContain('● codex · 10s');
      expect(previews).not.toContain('Ran:');
      expect(previews).not.toContain('npm run build');
      expect(previews).not.toContain('pwd');
      expect(previews).not.toContain('先读代码路径');
      expect(vi.mocked(channel.sendTyping).mock.calls.length).toBeGreaterThanOrEqual(3);

      const final = edits[edits.length - 1];
      expect(final.text).toContain('Final answer.');
      expect(final.text).toContain('最后确认只需要展示 reasoning 的尾段就够了');
      expect(final.text).not.toContain('先读代码路径');
      expect(final.opts?.parseMode).toBe('HTML');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stages bare uploads before the next prompt and reports artifact upload failures', async () => {
    const uploadDir = makeTmpDir('bot-tg-upload-');
    const uploadPath = path.join(uploadDir, 'report.pdf');
    fs.writeFileSync(uploadPath, 'pdf');

    const stagedHarness = createBot();
    let stagedLocalSessionId: string | null = null;
    let stagedWorkspacePath: string | null = null;

    const stagedRunStream = vi.spyOn(stagedHarness.bot, 'runStream').mockImplementation(async (_prompt: string, state: any, files: string[]) => {
      expect(files).toEqual([]);
      expect(state.localSessionId).toBe(stagedLocalSessionId);
      expect(state.workspacePath).toBe(stagedWorkspacePath);
      expect(stagedWorkspacePath && fs.existsSync(path.join(stagedWorkspacePath, 'report.pdf'))).toBe(true);
      return claudeResult({
        message: 'done',
        sessionId: 'sess-pending-file',
        elapsedS: 1,
        inputTokens: 3,
        outputTokens: 2,
      });
    });

    await (stagedHarness.bot as any).handleMessage({ text: '', files: [uploadPath] }, stagedHarness.ctx);
    stagedLocalSessionId = stagedHarness.bot.chat(stagedHarness.ctx.chatId).localSessionId ?? null;
    stagedWorkspacePath = stagedHarness.bot.chat(stagedHarness.ctx.chatId).workspacePath ?? null;

    expect(stagedRunStream).not.toHaveBeenCalled();
    expect(vi.mocked(stagedHarness.ctx.reply)).not.toHaveBeenCalled();
    expect(stagedHarness.reactions).toEqual([
      { chatId: stagedHarness.ctx.chatId, messageId: stagedHarness.ctx.messageId, reactions: ['👌'] },
    ]);
    expect(stagedLocalSessionId).toBeTruthy();
    expect(stagedWorkspacePath).toBeTruthy();
    expect(fs.existsSync(path.join(stagedWorkspacePath!, 'report.pdf'))).toBe(true);

    await (stagedHarness.bot as any).handleMessage({ text: 'Please summarize it', files: [] }, stagedHarness.ctx);
    await vi.waitFor(() => {
      expect(stagedRunStream).toHaveBeenCalledOnce();
    });

    const artifactDir = makeTmpDir('bot-tg-artifacts-fail-');
    const shotPath = path.join(artifactDir, 'shot.png');
    fs.writeFileSync(shotPath, Buffer.from('png-bytes'));

    const artifactHarness = createBot();
    vi.spyOn(artifactHarness.bot, 'runStream').mockResolvedValue(claudeResult({
      message: 'Artifacts ready.',
      localSessionId: 'sess-artifacts-fail-local',
      sessionId: 'sess-artifacts-fail',
      workspacePath: artifactDir,
      elapsedS: 1.5,
      inputTokens: 10,
      outputTokens: 20,
      artifacts: [
        { filePath: shotPath, filename: 'shot.png', kind: 'photo', caption: 'Screenshot' },
      ],
    }));
    vi.mocked(artifactHarness.channel.sendFile).mockRejectedValueOnce(new Error('telegram send failed'));

    await (artifactHarness.bot as any).handleMessage({ text: 'Take a screenshot', files: [] }, artifactHarness.ctx);

    await vi.waitFor(() => {
      expect(artifactHarness.channel.sendFile).toHaveBeenCalledTimes(1);
    });
    expect(artifactHarness.sends.some(entry => entry.text.includes('Artifact upload failed'))).toBe(true);
    expect(fs.existsSync(artifactDir)).toBe(true);

    fs.rmSync(uploadDir, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  });

  it('runs different sessions concurrently in the same chat', async () => {
    const { bot, ctx } = createBot();
    let nextReplyId = 1000;
    ctx.reply = vi.fn(async () => nextReplyId++);
    ctx.raw = { chat: { type: 'private' } };

    const first = deferred<StreamResult>();
    const second = deferred<StreamResult>();
    const states: any[] = [];
    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, state: any) => {
      states.push(state);
      if (states.length === 1) return first.promise;
      return second.promise;
    });

    const ctx1 = { ...ctx, messageId: 11, raw: { chat: { type: 'private' } } };
    const callbackCtx = {
      ...ctx,
      messageId: 12,
      answerCallback: vi.fn(async () => {}),
      raw: { chat: { type: 'private' } },
    };
    const ctx2 = { ...ctx, messageId: 13, raw: { chat: { type: 'private' } } };

    await (bot as any).handleMessage({ text: 'session a', files: [] }, ctx1);
    await Promise.resolve();
    await bot.handleCallback('sess:new', callbackCtx as any);
    await (bot as any).handleMessage({ text: 'session b', files: [] }, ctx2);
    await Promise.resolve();

    expect(states).toHaveLength(2);
    expect(states[0].localSessionId).toBeTruthy();
    expect(states[1].localSessionId).toBeTruthy();
    expect(states[0].localSessionId).not.toBe(states[1].localSessionId);
    expect(bot.activeTasks.size).toBe(2);

    first.resolve(claudeResult({
      message: 'done a',
      localSessionId: states[0].localSessionId,
      sessionId: `engine-${states[0].localSessionId}`,
      workspacePath: states[0].workspacePath,
      elapsedS: 1,
      inputTokens: 1,
      outputTokens: 1,
    }));
    second.resolve(claudeResult({
      message: 'done b',
      localSessionId: states[1].localSessionId,
      sessionId: `engine-${states[1].localSessionId}`,
      workspacePath: states[1].workspacePath,
      elapsedS: 1,
      inputTokens: 1,
      outputTokens: 1,
    }));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('keeps a single session serialized even when follow-ups arrive before completion', async () => {
    const { bot, ctx } = createBot();
    let nextReplyId = 2000;
    ctx.reply = vi.fn(async () => nextReplyId++);
    ctx.raw = { chat: { type: 'private' } };

    const first = deferred<StreamResult>();
    const second = deferred<StreamResult>();
    const states: any[] = [];
    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, state: any) => {
      states.push(state);
      if (states.length === 1) return first.promise;
      return second.promise;
    });

    const ctx1 = { ...ctx, messageId: 21, raw: { chat: { type: 'private' } } };
    await (bot as any).handleMessage({ text: 'first turn', files: [] }, ctx1);
    await Promise.resolve();
    expect(states).toHaveLength(1);

    const firstPlaceholderId = 2000;
    const ctx2 = {
      ...ctx,
      messageId: 22,
      raw: {
        chat: { type: 'private' },
        reply_to_message: { message_id: firstPlaceholderId },
      },
    };
    await (bot as any).handleMessage({ text: 'follow up', files: [] }, ctx2);
    await Promise.resolve();

    expect(states).toHaveLength(1);
    expect(bot.activeTasks.size).toBe(2);

    first.resolve(claudeResult({
      message: 'done first',
      localSessionId: states[0].localSessionId,
      sessionId: `engine-${states[0].localSessionId}`,
      workspacePath: states[0].workspacePath,
      elapsedS: 1,
      inputTokens: 1,
      outputTokens: 1,
    }));
    await vi.waitFor(() => {
      expect(states).toHaveLength(2);
    });
    expect(states[1].localSessionId).toBe(states[0].localSessionId);

    second.resolve(claudeResult({
      message: 'done second',
      localSessionId: states[1].localSessionId,
      sessionId: `engine-${states[1].localSessionId}`,
      workspacePath: states[1].workspacePath,
      elapsedS: 1,
      inputTokens: 1,
      outputTokens: 1,
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('TelegramBot.performRestart', () => {
  it('uses non-interactive npx restarts for both default and custom commands', () => {
    const spawnMock = vi.mocked(spawn);
    const oldArgv = process.argv;
    process.argv = ['node', 'codeclaw', '-c', 'telegram'];

    const defaultBot = createBot().bot;
    const defaultExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const defaultStopKeepAliveSpy = vi.spyOn(defaultBot as any, 'stopKeepAlive').mockImplementation(() => {});
    spawnMock.mockClear();
    spawnMock.mockReturnValue({ pid: 4321, unref: vi.fn() } as any);

    try {
      (defaultBot as any).performRestart();
      expect(spawnMock).toHaveBeenCalledWith(
        'npx',
        ['--yes', 'codeclaw@latest', '-c', 'telegram'],
        expect.objectContaining({
          stdio: 'inherit',
          detached: true,
          env: expect.objectContaining({ npm_config_yes: 'true' }),
        }),
      );

      process.env.CODECLAW_RESTART_CMD = 'npx tsx src/cli.ts';
      const customBot = createBot().bot;
      const customExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
      const customStopKeepAliveSpy = vi.spyOn(customBot as any, 'stopKeepAlive').mockImplementation(() => {});

      try {
        spawnMock.mockClear();
        (customBot as any).performRestart();
        expect(spawnMock).toHaveBeenCalledWith(
          'npx',
          ['--yes', 'tsx', 'src/cli.ts', '-c', 'telegram'],
          expect.objectContaining({
            env: expect.objectContaining({ npm_config_yes: 'true' }),
          }),
        );
      } finally {
        customExitSpy.mockRestore();
        customStopKeepAliveSpy.mockRestore();
      }
    } finally {
      process.argv = oldArgv;
      defaultExitSpy.mockRestore();
      defaultStopKeepAliveSpy.mockRestore();
    }
  });
});
