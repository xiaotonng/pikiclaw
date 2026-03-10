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
  it('shows incomplete status without attaching reply buttons on agent error', async () => {
    const { finalEdit } = await renderFinalReply('claude', {
      ok: false,
      message: 'Should I continue?',
      elapsedS: 17.2,
      inputTokens: 3,
      outputTokens: 178,
      error: 'Claude hit usage limit',
      incomplete: true,
    }, 99);

    expect(finalEdit.text).toContain('Incomplete Response');
    expect(finalEdit.text).toContain('Claude hit usage limit');
    expect(finalEdit.text).toContain('✗ claude · 17s');
    expect(finalEdit.opts?.keyboard).toBeUndefined();
  });

  it('shows truncation warning for stop_reason=max_tokens', async () => {
    const { finalEdit } = await renderFinalReply('claude', {
      message: 'Answer stopped mid-way',
      elapsedS: 9.4,
      inputTokens: 12,
      outputTokens: 999,
      stopReason: 'max_tokens',
      incomplete: true,
    });

    expect(finalEdit.text).toContain('Incomplete Response');
    expect(finalEdit.text).toContain('Output limit reached. Response may be truncated.');
  });

  it('shows an explicit timeout warning when the agent does not complete in time', async () => {
    const { finalEdit } = await renderFinalReply('codex', {
      ok: false,
      message: 'Timed out after 900s waiting for turn completion.',
      sessionId: 'sess-timeout',
      elapsedS: 905,
      inputTokens: 12,
      outputTokens: 34,
      cachedInputTokens: 56,
      error: 'Timed out after 900s waiting for turn completion.',
      stopReason: 'timeout',
      incomplete: true,
    });

    expect(finalEdit.text).toContain('Incomplete Response');
    expect(finalEdit.text).toContain('Timed out after 15m 5s before the agent reported completion.');
    expect(finalEdit.text).toContain('Timed out after 900s waiting for turn completion.');
  });

  it('renders a minimal final footer with agent, context percent, and elapsed time only', async () => {
    const { finalEdit } = await renderFinalReply('codex', {
      message: 'Done.',
      sessionId: 'sess-footer',
      elapsedS: 85,
      inputTokens: 120,
      outputTokens: 18,
      cachedInputTokens: 30,
      contextWindow: 200000,
      contextUsedTokens: 150,
      contextPercent: 25.7,
    });

    expect(finalEdit.text).toContain('✓ codex · 25.7% · 1m25s');
    expect(finalEdit.text).not.toContain('gpt-5.4');
    expect(finalEdit.text).not.toContain('cached:');
    expect(finalEdit.text).not.toContain('in:');
    expect(finalEdit.text).not.toContain('out:');
  });

  it('does not attach reply buttons for complete responses', async () => {
    const { finalEdit } = await renderFinalReply('claude', {
      message: 'Should I continue?',
      elapsedS: 5.1,
      inputTokens: 2,
      outputTokens: 12,
    }, 101);

    expect(finalEdit.opts?.keyboard).toBeUndefined();
  });

  it('renders command-only activity as a low-key note in the final reply', async () => {
    const { finalEdit } = await renderFinalReply('codex', {
      message: 'Build finished.',
      elapsedS: 3.2,
      inputTokens: 7,
      outputTokens: 21,
      activity: 'Ran: /bin/zsh -lc npm run build\nRan: /bin/zsh -lc npm test',
    }, 102);

    expect(finalEdit.text).toContain('<i>commands: 2 done</i>');
    expect(finalEdit.text).not.toContain('<b>Activity</b>');
    expect(finalEdit.text).not.toContain('npm run build');
    expect(finalEdit.text).not.toContain('npm test');
  });

  it('renders failed commands as part of the low-key command note', async () => {
    const { finalEdit } = await renderFinalReply('codex', {
      message: 'Build failed.',
      elapsedS: 2.4,
      inputTokens: 6,
      outputTokens: 9,
      activity: 'Command failed (1): /bin/zsh -lc npm test\nRan: /bin/zsh -lc npm run build',
    }, 103);

    expect(finalEdit.text).toContain('<i>commands: 1 failed, 1 done</i>');
    expect(finalEdit.text).not.toContain('Command failed (1)');
    expect(finalEdit.text).not.toContain('npm test');
  });

  it('renders Claude shell activity as a low-key command note in the final reply', async () => {
    const { finalEdit } = await renderFinalReply('claude', {
      message: '当前账号是 xiaotonng。',
      elapsedS: 3.1,
      inputTokens: 5,
      outputTokens: 11,
      activity: [
        'Run shell: Check current GitHub CLI authentication status',
        'Run shell: Check current GitHub CLI authentication status -> github.com',
      ].join('\n'),
    }, 104);

    expect(finalEdit.text).toContain('<i>commands: 1 done</i>');
    expect(finalEdit.text).not.toContain('<b>Activity</b>');
    expect(finalEdit.text).not.toContain('Run shell:');
    expect(finalEdit.text).not.toContain('Check current GitHub CLI authentication status');
    expect(finalEdit.text).not.toContain('github.com');
  });

  it('shows only the last thinking block in the final reply', async () => {
    const { finalEdit } = await renderFinalReply('claude', {
      message: '结论已经整理好了。',
      thinking: '先检查上下文\n再确认调用链\n\n最后定位到 Telegram 展示层把完整 thinking 透传出来了',
      elapsedS: 4.8,
      inputTokens: 10,
      outputTokens: 22,
    }, 105);

    expect(finalEdit.text).toContain('最后定位到 Telegram 展示层把完整 thinking 透传出来了');
    expect(finalEdit.text).not.toContain('先检查上下文');
    expect(finalEdit.text).not.toContain('再确认调用链');
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
      expect(onceHandlers.has('SIGINT')).toBe(true);
      expect(onHandlers.has('SIGUSR2')).toBe(true);

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

describe('TelegramBot.cmdHost', () => {
  it('shows battery percentage and charging state in host info', async () => {
    const { bot, ctx } = createBot();
    const replies: Array<{ text: string; opts?: any }> = [];
    ctx.reply = vi.fn(async (text: string, opts?: any) => {
      replies.push({ text, opts });
      return 1;
    });

    vi.spyOn(bot, 'getHostData').mockReturnValue({
      hostName: 'Xiaoxiao-MacBook-Air',
      cpuModel: 'Apple M4 Pro',
      cpuCount: 14,
      cpuUsage: { usedPercent: 31.2, userPercent: 12.5, sysPercent: 18.7, idlePercent: 68.8 },
      totalMem: 36 * 1024 * 1024 * 1024,
      freeMem: 12 * 1024 * 1024 * 1024,
      memoryUsed: 24 * 1024 * 1024 * 1024,
      memoryAvailable: 12 * 1024 * 1024 * 1024,
      memoryPercent: 66.7,
      memorySource: 'vm_stat',
      battery: { percent: '87%', state: 'charging' },
      disk: { used: '220G', total: '460G', percent: '48%' },
      topProcs: ['  PID %CPU %MEM COMMAND', '1234 12.5 1.2 node'],
      selfPid: 4321,
      selfRss: 512 * 1024 * 1024,
      selfHeap: 128 * 1024 * 1024,
    });

    await bot.handleCommand('host', '', ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain('<b>Name:</b> Xiaoxiao-MacBook-Air');
    expect(replies[0].text).toContain('<b>CPU Usage:</b> 31.2% (12.5% user, 18.7% sys, 68.8% idle)');
    expect(replies[0].text).toContain('<b>Memory:</b> 24.0GB / 36.0GB (67%)');
    expect(replies[0].text).toContain('<b>Available:</b> 12.0GB');
    expect(replies[0].text).toContain('<b>Battery:</b> 87% (charging)');
    expect(replies[0].text).toContain('<b>Disk:</b> 220G used / 460G total (48%)');
    expect(replies[0].opts?.parseMode).toBe('HTML');
  });
});

describe('TelegramBot.cmdStatus', () => {
  it('does not expose artifact system prompt in the running preview', async () => {
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
});

describe('TelegramBot.handleCallback session preview', () => {
  it('renders resumed history as a quoted user prompt plus normal assistant markdown', async () => {
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
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(sends).toHaveLength(1);
    expect(sends[0].opts).toEqual({ parseMode: 'HTML' });
    expect(sends[0].opts?.replyTo).toBeUndefined();
    expect(sends[0].text).toContain('<blockquote expandable>请总结这次修改\n第二行保留原样</blockquote>');
    expect(sends[0].text).toContain('<b>Summary</b>');
    expect(sends[0].text).toContain('Use <b>bold</b> and <code>code</code>.');
    expect(sends[0].text).toContain('<pre><code class="language-ts">const x = 1;</code></pre>');
  });
});

describe('TelegramBot.handleMessage streaming', () => {
  it('uses editMessage previews for private chats and finalizes in the same message', async () => {
    const { bot, ctx, channel, sends, edits } = createBot();
    ctx.raw = { chat: { type: 'private' }, message_thread_id: 42 };

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('**Partial** `answer`', '', 'Reading files\nRan: /bin/zsh -lc ls\n$ /bin/zsh -lc pwd');
      return claudeResult({
        message: 'Final answer.',
        sessionId: 'sess-draft',
        elapsedS: 0.6,
        inputTokens: 4,
        outputTokens: 7,
      });
    });

    await (bot as any).handleMessage({ text: 'Say final answer', files: [] }, ctx);

    expect((channel as any).sendMessageDraft).toBeUndefined();
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining('● claude · 0s'),
      expect.objectContaining({ messageThreadId: 42, parseMode: 'HTML' }),
    );
    expect(edits.some(entry => entry.text.includes('<b>Activity</b>\nReading files'))).toBe(true);
    expect(edits.every(entry => !entry.text.includes('Ran:'))).toBe(true);
    expect(edits.every(entry => !entry.text.includes('$ /bin/zsh'))).toBe(true);
    expect(sends).toHaveLength(0);
    expect(edits[edits.length - 1]?.text).toContain('Final answer.');
    expect(edits[edits.length - 1]?.opts?.parseMode).toBe('HTML');
  });

  it('refreshes elapsed time and typing state while waiting for the first model output', async () => {
    vi.useFakeTimers();
    const { bot, ctx, edits, channel } = createBot();

    vi.spyOn(bot, 'runStream').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 12_000));
      return claudeResult({
        message: 'Finally done.',
        sessionId: 'sess-waiting',
        elapsedS: 12,
        inputTokens: 4,
        outputTokens: 8,
      });
    });

    try {
      const pending = (bot as any).handleMessage({ text: 'Wait for it', files: [] }, ctx);
      await vi.advanceTimersByTimeAsync(12_000);
      await pending;

      const previews = previewTexts(edits);
      expect(previews.some(text => text.includes('Waiting for model output...'))).toBe(false);
      expect(previews.some(text => text.includes('● claude · 5s'))).toBe(true);
      expect(previews.some(text => text.includes('● claude · 10s'))).toBe(true);
      expect(channel.sendTyping).toHaveBeenCalled();
      expect(vi.mocked(channel.sendTyping).mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(edits[edits.length - 1].text).toContain('Finally done.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the streaming footer minimal even when the agent stalls', async () => {
    vi.useFakeTimers();
    const { bot, ctx, edits } = createBot();

    vi.spyOn(bot, 'runStream').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 20_000));
      return claudeResult({
        message: 'Finally done.',
        sessionId: 'sess-idle',
        elapsedS: 20,
        inputTokens: 4,
        outputTokens: 8,
      });
    });

    try {
      const pending = (bot as any).handleMessage({ text: 'Wait longer', files: [] }, ctx);
      await vi.advanceTimersByTimeAsync(20_000);
      await pending;

      const previews = previewTexts(edits);
      expect(previews.some(text => text.includes('No new output for'))).toBe(false);
      expect(previews.some(text => text.includes('idle'))).toBe(false);
      expect(previews.some(text => text.includes('● claude · 15s')) || previews.some(text => text.includes('● claude · 20s'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('injects artifact instructions into resumed codex prompts', async () => {
    const { bot, ctx } = createBot();
    const cs = bot.chat(ctx.chatId);
    cs.agent = 'codex';
    cs.sessionId = 'sess-existing';

    const runStream = vi.spyOn(bot, 'runStream').mockImplementation(async (prompt: string, _cs: any, _files: string[], _onText: any, systemPrompt?: string) => {
      expect(prompt).toContain('Inspect this repo');
      expect(prompt).not.toContain('[Telegram Artifact Return]');
      expect(prompt).not.toContain('[Session Workspace]');
      expect(systemPrompt).toBeUndefined();
      return codexResult({
        message: 'done',
        sessionId: 'sess-existing',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
      });
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    expect(runStream).toHaveBeenCalledOnce();
  });

  it('stages bare uploads and replies ok only after the files are persisted', async () => {
    const { bot, ctx, reactions } = createBot();
    const uploadDir = makeTmpDir('bot-tg-upload-');
    const uploadPath = path.join(uploadDir, 'report.pdf');
    fs.writeFileSync(uploadPath, 'pdf');
    let stagedLocalSessionId: string | null = null;
    let stagedWorkspacePath: string | null = null;

    const runStream = vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, state: any, files: string[]) => {
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

    await (bot as any).handleMessage({ text: '', files: [uploadPath] }, ctx);
    stagedLocalSessionId = bot.chat(ctx.chatId).localSessionId ?? null;
    stagedWorkspacePath = bot.chat(ctx.chatId).workspacePath ?? null;

    expect(runStream).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledOnce();
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith('ok');
    expect(reactions).toEqual([]);
    expect(stagedLocalSessionId).toBeTruthy();
    expect(stagedWorkspacePath).toBeTruthy();
    expect(fs.existsSync(path.join(stagedWorkspacePath!, 'report.pdf'))).toBe(true);

    await (bot as any).handleMessage({ text: 'Please summarize it', files: [] }, ctx);

    expect(runStream).toHaveBeenCalledOnce();
    expect(runStream.mock.calls[0]?.[2]).toEqual([]);

    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it('keeps codex commentary while hiding raw command details in the streaming preview', async () => {
    const { bot, ctx, edits } = createBot();
    bot.chat(ctx.chatId).agent = 'codex';

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('', '', '改动已经落下去了，现在跑相关单测确认结果\nRan: /bin/zsh -lc npm run build\nRan: /bin/zsh -lc npm test -- test/bot-telegram.unit.test.ts\n单测和 tsc 都过了，现在我再看一眼 diff');
      return codexResult({
        message: 'codeclaw',
        sessionId: 'sess-stream-1',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
      });
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    const preview = previewText(edits);
    expect(preview).toContain('Activity');
    expect(preview).toContain('改动已经落下去了，现在跑相关单测确认结果');
    expect(preview).toContain('单测和 tsc 都过了，现在我再看一眼 diff');
    expect(preview).not.toContain('Ran:');
    expect(preview).not.toContain('npm run build');
    expect(preview).not.toContain('npm test');
    expect(edits[edits.length - 1].text).toContain('codeclaw');
  });

  it('shows only the last reasoning block in the streaming preview and final reply', async () => {
    const { bot, ctx, edits } = createBot();
    bot.chat(ctx.chatId).agent = 'codex';

    const thinking = '先读代码路径\n再看 streaming 触发条件\n\n最后确认只需要展示 reasoning 的尾段就够了';

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('', thinking, '');
      return codexResult({
        message: 'done',
        thinking,
        sessionId: 'sess-stream-thinking',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
      });
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    const preview = previewText(edits);
    expect(preview).toContain('Reasoning');
    expect(preview).toContain('最后确认只需要展示 reasoning 的尾段就够了');
    expect(preview).not.toContain('先读代码路径');
    expect(preview).not.toContain('再看 streaming 触发条件');

    const final = edits[edits.length - 1].text;
    expect(final).toContain('最后确认只需要展示 reasoning 的尾段就够了');
    expect(final).not.toContain('先读代码路径');
    expect(final).not.toContain('再看 streaming 触发条件');
  });

  it('shows only context usage in the streaming footer', async () => {
    const { bot, ctx, edits } = createBot();
    bot.chat(ctx.chatId).agent = 'codex';

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('', '', 'Ran: /bin/zsh -lc npm run build', {
        inputTokens: 120,
        cachedInputTokens: 30,
        outputTokens: 18,
        contextPercent: 4.2,
      });
      return codexResult({
        message: 'done',
        sessionId: 'sess-stream-meta',
        elapsedS: 1.2,
        inputTokens: 120,
        outputTokens: 18,
        cachedInputTokens: 30,
        contextWindow: 200000,
        contextUsedTokens: 150,
        contextPercent: 4.2,
      });
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    const preview = previewText(edits);
    expect(preview).toContain('● codex · 4.2% · ');
    expect(preview).not.toContain('in:120');
    expect(preview).not.toContain('cached:30');
    expect(preview).not.toContain('out:18');
  });

  it('renders structured codex plan steps in the streaming preview', async () => {
    const { bot, ctx, edits } = createBot();
    bot.chat(ctx.chatId).agent = 'codex';

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('', '', '', undefined, {
        explanation: 'Investigating',
        steps: [
          { step: 'Inspect streaming paths', status: 'completed' },
          { step: 'Thread live usage into preview', status: 'inProgress' },
          { step: 'Update tests', status: 'pending' },
        ],
      });
      return codexResult({
        message: 'done',
        sessionId: 'sess-stream-plan',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
      });
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    const preview = previewText(edits);
    expect(preview).toContain('Plan 1/3');
    expect(preview).toContain('[x] Inspect streaming paths');
    expect(preview).toContain('[&gt;] Thread live usage into preview');
    expect(preview).toContain('[ ] Update tests');
  });

  it('shows an abstract command summary when codex activity only contains commands', async () => {
    const { bot, ctx, edits } = createBot();
    bot.chat(ctx.chatId).agent = 'codex';

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('', '', 'Ran: /bin/zsh -lc npm run build\nRan: /bin/zsh -lc npm test');
      return codexResult({
        message: 'done',
        sessionId: 'sess-stream-1b',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
      });
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    const preview = previewText(edits);
    expect(preview).toContain('Activity');
    expect(preview).toContain('commands: 2 done');
    expect(preview).not.toContain('Ran:');
    expect(preview).not.toContain('npm run build');
    expect(preview).not.toContain('npm test');
  });

  it('collapses Claude shell activity in the streaming preview', async () => {
    const { bot, ctx, edits } = createBot();

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('', '', [
        'Run shell: Check current GitHub CLI authentication status',
        'Run shell: Check current GitHub CLI authentication status -> github.com',
      ].join('\n'));
      return claudeResult({
        message: '当前账号是 xiaotonng。',
        sessionId: 'sess-stream-claude-shell',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
      });
    });

    await (bot as any).handleMessage({ text: '你看下我当前 gh 用的是哪个账号', files: [] }, ctx);

    const preview = previewText(edits);
    expect(preview).toContain('Activity');
    expect(preview).toContain('commands: 1 done');
    expect(preview).not.toContain('Run shell:');
    expect(preview).not.toContain('Check current GitHub CLI authentication status');
    expect(preview).not.toContain('github.com');
  });

  it('preserves early codex stage descriptions when activity becomes long', async () => {
    const { bot, ctx, edits } = createBot();
    bot.chat(ctx.chatId).agent = 'codex';

    const stages = Array.from({ length: 7 }, (_value, idx) => `阶段${idx + 1}: ${'进度'.repeat(70)}`);

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('', '', [
        ...stages,
        'Ran: /bin/zsh -lc npm run build',
        'Ran: /bin/zsh -lc npm test',
        '$ /bin/zsh -lc git diff --stat',
      ].join('\n'));
      return codexResult({
        message: 'done',
        sessionId: 'sess-stream-1c',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
      });
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    const preview = previewText(edits);
    expect(preview).toContain('阶段1:');
    expect(preview).toContain('阶段2:');
    expect(preview).toContain('commands: 2 done, 1 running');
    expect(preview).toContain('\n...\n');
    expect(preview).not.toContain('Ran:');
    expect(preview).not.toContain('git diff --stat');
  });

  it('folds failed commands into the preview summary instead of showing raw failure lines', async () => {
    const { bot, ctx, edits } = createBot();
    bot.chat(ctx.chatId).agent = 'codex';

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('', '', [
        '我先跑测试看失败点',
        'Command failed (1): /bin/zsh -lc npm test',
        '$ /bin/zsh -lc npm run build',
      ].join('\n'));
      return codexResult({
        message: 'done',
        sessionId: 'sess-stream-fail',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
      });
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    const preview = previewText(edits);
    expect(preview).toContain('我先跑测试看失败点');
    expect(preview).toContain('commands: 1 failed, 1 running');
    expect(preview).not.toContain('Command failed (1)');
    expect(preview).not.toContain('npm test');
  });

  it('waits for pending preview edits before sending the final reply', async () => {
    const { bot, ctx, channel, edits } = createBot();
    let previewCalls = 0;
    channel.editMessage = vi.fn(async (_chatId: number, _msgId: number, text: string, opts?: any) => {
      previewCalls++;
      await new Promise(resolve => setTimeout(resolve, 25));
      edits.push({ text, opts });
    });

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('Partial answer', '', 'Running...');
      return claudeResult({
        message: 'Final answer.',
        sessionId: 'sess-stream-2',
        elapsedS: 0.6,
        inputTokens: 4,
        outputTokens: 7,
      });
    });

    await (bot as any).handleMessage({ text: 'Say final answer', files: [] }, ctx);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(previewCalls).toBeGreaterThan(1);
    expect(edits[edits.length - 1].text).toContain('Final answer.');
    expect(edits[edits.length - 1].opts?.parseMode).toBe('HTML');
  });
});

describe('TelegramBot.handleMessage artifacts', () => {
  it('uploads returned artifacts from the stream result', async () => {
    const { bot, ctx, channel, files, edits } = createBot();
    const artifactDir = makeTmpDir('bot-tg-artifacts-');
    const shotPath = path.join(artifactDir, 'shot.png');
    const notesPath = path.join(artifactDir, 'notes.txt');
    fs.writeFileSync(shotPath, Buffer.from('png-bytes'));
    fs.writeFileSync(notesPath, 'hello');

    vi.spyOn(bot, 'runStream').mockImplementation(async () => {
      return claudeResult({
        message: 'Artifacts ready.',
        localSessionId: 'sess-artifacts-local',
        sessionId: 'sess-artifacts',
        workspacePath: artifactDir,
        elapsedS: 1.5,
        inputTokens: 10,
        outputTokens: 20,
        artifacts: [
          { filePath: shotPath, filename: 'shot.png', kind: 'photo', caption: 'Screenshot' },
          { filePath: notesPath, filename: 'notes.txt', kind: 'document', caption: 'Notes' },
        ],
      });
    });

    await (bot as any).handleMessage({ text: 'Take a screenshot', files: [] }, ctx);

    // Production behavior: final text remains a normal message and artifacts are uploaded separately.
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain('Artifacts ready.');
    expect(channel.deleteMessage).not.toHaveBeenCalled();
    expect(files).toHaveLength(2);
    expect(files[0].filePath).toContain('shot.png');
    expect(files[0].opts).toMatchObject({ caption: 'Screenshot', replyTo: 1, asPhoto: true });
    expect(files[1].filePath).toContain('notes.txt');
    expect(files[1].opts).toMatchObject({ caption: 'Notes', replyTo: 1, asPhoto: false });
    expect(channel.sendFile).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(artifactDir)).toBe(true);

    fs.rmSync(artifactDir, { recursive: true, force: true });
  });

  it('reports artifact upload failures without deleting the workspace files', async () => {
    const { bot, ctx, channel, sends } = createBot();
    const artifactDir = makeTmpDir('bot-tg-artifacts-fail-');
    const shotPath = path.join(artifactDir, 'shot.png');
    fs.writeFileSync(shotPath, Buffer.from('png-bytes'));

    vi.spyOn(bot, 'runStream').mockImplementation(async () => {
      return claudeResult({
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
      });
    });

    vi.mocked(channel.sendFile).mockRejectedValueOnce(new Error('telegram send failed'));

    await (bot as any).handleMessage({ text: 'Take a screenshot', files: [] }, ctx);

    expect(channel.sendFile).toHaveBeenCalledTimes(1);
    expect(sends.some(entry => entry.text.includes('Artifact upload failed'))).toBe(true);
    expect(fs.existsSync(artifactDir)).toBe(true);

    fs.rmSync(artifactDir, { recursive: true, force: true });
  });
});

describe('TelegramBot.cmdModels', () => {
  it('shows discovered sources and the resolved current Claude model', async () => {
    const { bot, ctx } = createBot();
    const replies: Array<{ text: string; opts?: any }> = [];
    ctx.reply = vi.fn(async (text: string, opts?: any) => {
      replies.push({ text, opts });
      return 1;
    });

    bot.chat(ctx.chatId).agent = 'claude';
    (bot as any).claudeModel = 'claude-opus-4-6';
    vi.spyOn(bot, 'fetchModels').mockReturnValue({
      agent: 'claude',
      models: [
        { id: 'opus', alias: null },
        { id: 'sonnet', alias: null },
      ],
      sources: ['claude --help', 'current config'],
      note: 'Claude CLI does not expose a machine-readable model list; entries are discovered from CLI help and local state.',
    });

    await (bot as any).cmdModels(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain('Source: claude --help, current config');
    expect(replies[0].text).toContain('current (claude-opus-4-6)');
    expect(replies[0].opts?.keyboard?.inline_keyboard).toHaveLength(2);
  });

  it('does not mark the Claude 1m variant as current when the base model is selected', async () => {
    const { bot, ctx } = createBot();
    const replies: Array<{ text: string; opts?: any }> = [];
    ctx.reply = vi.fn(async (text: string, opts?: any) => {
      replies.push({ text, opts });
      return 1;
    });

    bot.chat(ctx.chatId).agent = 'claude';
    (bot as any).claudeModel = 'claude-opus-4-6';
    vi.spyOn(bot, 'fetchModels').mockReturnValue({
      agent: 'claude',
      models: [
        { id: 'claude-opus-4-6', alias: 'opus' },
        { id: 'claude-opus-4-6[1m]', alias: 'opus-1m' },
      ],
      sources: [],
      note: null,
    });

    await (bot as any).cmdModels(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain('● <code>opus (claude-opus-4-6)</code> ← current');
    expect(replies[0].text).toContain('○ <code>opus-1m (claude-opus-4-6[1m])</code>');
    expect(replies[0].text).not.toContain('opus-1m (claude-opus-4-6[1m])</code> ← current');
    expect(replies[0].opts?.keyboard?.inline_keyboard).toEqual([
      [{ text: '● opus', callback_data: 'mod:claude-opus-4-6' }],
      [{ text: 'opus-1m', callback_data: 'mod:claude-opus-4-6[1m]' }],
    ]);
  });
});

describe('TelegramBot.handleCallback model selection', () => {
  it('does not reset the session when a Claude alias resolves to the current model', async () => {
    const { bot, ctx } = createBot();
    const cs = bot.chat(ctx.chatId);
    cs.agent = 'claude';
    cs.sessionId = 'sess-keep';
    (bot as any).claudeModel = 'opus';

    await bot.handleCallback('mod:claude-opus-4-6', ctx as any);

    expect(ctx.answerCallback).toHaveBeenCalledWith('Already using claude-opus-4-6');
    expect(ctx.editReply).not.toHaveBeenCalled();
    expect(cs.sessionId).toBe('sess-keep');
    expect((bot as any).claudeModel).toBe('opus');
  });
});


describe('TelegramBot.cmdStart', () => {
  it('shows the shared welcome intro before the command list', async () => {
    const { bot, ctx } = createBot();
    const replies: Array<{ text: string; opts?: any }> = [];
    ctx.reply = vi.fn(async (text: string, opts?: any) => {
      replies.push({ text, opts });
      return 1;
    });

    await (bot as any).cmdStart(ctx);

    expect(replies).toHaveLength(1);
    expect(replies[0].opts).toEqual({ parseMode: 'HTML' });
    expect(replies[0].text).toContain(`<b>Hi, I'm codeclaw</b> v`);
    expect(replies[0].text).toContain(`Send me a message to get started.`);
    expect(replies[0].text).toContain('<b>Commands</b>');
    expect(replies[0].text).toContain('/sessions — Switch sessions');
    expect(replies[0].text).toContain('/restart — Restart bot');
    expect(replies[0].text).toContain('<b>Agent:</b>');
    expect(replies[0].text).toContain('<b>Workdir:</b>');
    expect(replies[0].text).toContain('\n');
  });
});

describe('TelegramBot.sendStartupNotice', () => {
  it('uses the shared two-line welcome intro', async () => {
    const { bot, channel, ctx, sends } = createBot();
    (bot as any).allowedChatIds.clear();
    channel.knownChats.add(ctx.chatId);

    await (bot as any).sendStartupNotice();

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(sends[0].opts).toEqual({ parseMode: 'HTML' });
    expect(sends[0].text).toContain(`<b>Hi, I'm codeclaw</b> v`);
    expect(sends[0].text).toContain('Send me a message to get started.');
    expect(sends[0].text).toContain('\n');
  });
});

describe('TelegramBot skills', () => {
  it('refreshes menu commands after switching workdirs', async () => {
    const { bot, channel } = createBot();
    const oldWorkdir = process.env.CODECLAW_WORKDIR!;
    fs.mkdirSync(path.join(oldWorkdir, '.claude', 'skills', 'old-skill'), { recursive: true });
    fs.writeFileSync(path.join(oldWorkdir, '.claude', 'skills', 'old-skill', 'SKILL.md'), '# Old Skill\n');

    await bot.setupMenu();
    expect(channel.setMenu).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ command: 'sk_old_skill' }),
    ]));

    const nextWorkdir = makeTmpDir('bot-tg-skill-next-');
    fs.mkdirSync(path.join(nextWorkdir, '.claude', 'skills', 'new-skill'), { recursive: true });
    fs.writeFileSync(path.join(nextWorkdir, '.claude', 'skills', 'new-skill', 'SKILL.md'), '# New Skill\n');

    bot.switchWorkdir(nextWorkdir);
    await Promise.resolve();

    expect(channel.setMenu).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ command: 'sk_new_skill' }),
    ]));
    expect(channel.setMenu).toHaveBeenLastCalledWith(expect.not.arrayContaining([
      expect.objectContaining({ command: 'sk_old_skill' }),
    ]));
  });

  it('routes sanitized skill commands back to the original skill name', async () => {
    const { bot, ctx } = createBot();
    const workdir = process.env.CODECLAW_WORKDIR!;
    const skillDir = path.join(workdir, '.claude', 'skills', 'My-Skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill\n');

    bot.chat(ctx.chatId).agent = 'codex';
    const handleMessage = vi.spyOn(bot as any, 'handleMessage').mockResolvedValue(undefined);

    await bot.handleCommand('sk_my_skill', 'please run it', ctx);

    expect(handleMessage).toHaveBeenCalledWith({
      text: `In this project's .claude/skills/My-Skill/ directory (or .claude/commands/My-Skill.md), there is a custom skill definition. Please read and execute the instructions defined in that skill file. Additional context: please run it`,
      files: [],
    }, ctx);
  });
});

describe('TelegramBot.performRestart', () => {
  it('uses a non-interactive default npx restart command', () => {
    const { bot, channel } = createBot();
    const spawnMock = vi.mocked(spawn);
    const unref = vi.fn();
    const oldArgv = process.argv;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const stopKeepAliveSpy = vi.spyOn(bot as any, 'stopKeepAlive').mockImplementation(() => {});

    spawnMock.mockReturnValue({ pid: 4321, unref } as any);
    process.argv = ['node', 'codeclaw', '-c', 'telegram'];

    try {
      (bot as any).performRestart();

      expect(channel.disconnect).toHaveBeenCalledTimes(1);
      expect(stopKeepAliveSpy).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(
        'npx',
        ['--yes', 'codeclaw@latest', '-c', 'telegram'],
        expect.objectContaining({
          stdio: 'inherit',
          detached: true,
          env: expect.objectContaining({ npm_config_yes: 'true' }),
        }),
      );
      expect(unref).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      process.argv = oldArgv;
      exitSpy.mockRestore();
      stopKeepAliveSpy.mockRestore();
    }
  });

  it('injects --yes for custom npx restart commands too', () => {
    const { bot } = createBot();
    const spawnMock = vi.mocked(spawn);
    const oldArgv = process.argv;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    const stopKeepAliveSpy = vi.spyOn(bot as any, 'stopKeepAlive').mockImplementation(() => {});

    process.env.CODECLAW_RESTART_CMD = 'npx tsx src/cli.ts';
    process.argv = ['node', 'codeclaw', '-c', 'telegram'];

    try {
      (bot as any).performRestart();

      expect(spawnMock).toHaveBeenCalledWith(
        'npx',
        ['--yes', 'tsx', 'src/cli.ts', '-c', 'telegram'],
        expect.objectContaining({
          env: expect.objectContaining({ npm_config_yes: 'true' }),
        }),
      );
    } finally {
      process.argv = oldArgv;
      exitSpy.mockRestore();
      stopKeepAliveSpy.mockRestore();
    }
  });
});

describe('Bot.startKeepAlive', () => {
  it('adds periodic macOS user-activity pulses alongside the long-lived caffeinate assertion', () => {
    vi.useFakeTimers();
    const spawnMock = vi.mocked(spawn);
    const mainProc = { pid: 4321, unref: vi.fn(), kill: vi.fn() };
    const pulseProc = { pid: 4322, unref: vi.fn() };
    const fakeBin = makeTmpDir('bot-keepalive-bin-');
    const oldPath = process.env.PATH;
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');

    fs.writeFileSync(path.join(fakeBin, 'caffeinate'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${fakeBin}:${oldPath || ''}`;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    spawnMock.mockImplementationOnce(() => mainProc as any).mockImplementation(() => pulseProc as any);

    try {
      const { bot } = createBot();

      (bot as any).startKeepAlive();

      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        'caffeinate',
        ['-dis'],
        expect.objectContaining({ stdio: 'ignore', detached: true }),
      );
      expect(spawnMock).toHaveBeenNthCalledWith(
        2,
        'caffeinate',
        ['-u', '-t', '30'],
        expect.objectContaining({ stdio: 'ignore', detached: true }),
      );

      vi.advanceTimersByTime(20_000);

      expect(spawnMock).toHaveBeenNthCalledWith(
        3,
        'caffeinate',
        ['-u', '-t', '30'],
        expect.objectContaining({ stdio: 'ignore', detached: true }),
      );

      (bot as any).stopKeepAlive();
      vi.advanceTimersByTime(60_000);

      expect(mainProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(spawnMock).toHaveBeenCalledTimes(3);
    } finally {
      if (platformDesc) Object.defineProperty(process, 'platform', platformDesc);
      if (oldPath == null) delete process.env.PATH;
      else process.env.PATH = oldPath;
      vi.useRealTimers();
    }
  });
});
