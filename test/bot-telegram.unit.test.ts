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
import os from 'node:os';
import path from 'node:path';
import { TelegramBot, buildArtifactPrompt } from '../src/bot-telegram.ts';
import type { TgContext } from '../src/channel-telegram.ts';

function createBot() {
  const edits: Array<{ text: string; opts?: any }> = [];
  const sends: Array<{ text: string; opts?: any }> = [];
  const docs: Array<{ content: string | Buffer; filename: string; opts?: any }> = [];
  const files: Array<{ filePath: string; opts?: any }> = [];
  const channel = {
    editMessage: vi.fn(async (_chatId: number, _msgId: number, text: string, opts?: any) => {
      edits.push({ text, opts });
    }),
    send: vi.fn(async (_chatId: number, text: string, opts?: any) => {
      sends.push({ text, opts });
      return 777;
    }),
    sendDocument: vi.fn(async (_chatId: number, content: string | Buffer, filename: string, opts?: any) => {
      docs.push({ content, filename, opts });
      return 778;
    }),
    sendFile: vi.fn(async (_chatId: number, filePath: string, opts?: any) => {
      files.push({ filePath, opts });
      return 779;
    }),
    setMenu: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };

  const bot = new TelegramBot();
  (bot as any).channel = channel;

  const ctx: TgContext = {
    chatId: 100,
    messageId: 200,
    from: { id: 300 },
    reply: vi.fn(async () => 1),
    editReply: vi.fn(async () => {}),
    answerCallback: vi.fn(async () => {}),
    channel: channel as any,
    raw: {},
  };

  return { bot, channel, ctx, edits, sends, docs, files };
}

beforeEach(() => {
  vi.clearAllMocks();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-tg-unit-'));
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.CODECLAW_WORKDIR = tmpDir;
  process.env.DEFAULT_AGENT = 'claude';
  delete process.env.CODECLAW_RESTART_CMD;
  delete process.env.npm_config_yes;
});

describe('TelegramBot.sendFinalReply', () => {
  it('shows incomplete status without attaching reply buttons on agent error', async () => {
    const { bot, ctx, edits } = createBot();

    await (bot as any).sendFinalReply(ctx, 99, 'claude', {
      ok: false,
      message: 'Should I continue?',
      thinking: null,
      sessionId: 'sess-1',
      model: 'claude-opus-4-6',
      thinkingEffort: 'high',
      elapsedS: 17.2,
      inputTokens: 3,
      outputTokens: 178,
      cachedInputTokens: null,
      error: 'Claude hit usage limit',
      stopReason: null,
      incomplete: true,
    });

    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain('Incomplete Response');
    expect(edits[0].text).toContain('Claude hit usage limit');
    expect(edits[0].opts?.keyboard).toBeUndefined();
  });

  it('shows truncation warning for stop_reason=max_tokens', async () => {
    const { bot, ctx, edits } = createBot();

    await (bot as any).sendFinalReply(ctx, 100, 'claude', {
      ok: true,
      message: 'Answer stopped mid-way',
      thinking: null,
      sessionId: 'sess-2',
      model: 'claude-opus-4-6',
      thinkingEffort: 'high',
      elapsedS: 9.4,
      inputTokens: 12,
      outputTokens: 999,
      cachedInputTokens: null,
      error: null,
      stopReason: 'max_tokens',
      incomplete: true,
    });

    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain('Incomplete Response');
    expect(edits[0].text).toContain('Output limit reached. Response may be truncated.');
  });

  it('shows an explicit timeout warning when the agent does not complete in time', async () => {
    const { bot, ctx, edits } = createBot();

    await (bot as any).sendFinalReply(ctx, 100, 'codex', {
      ok: false,
      message: 'Timed out after 900s waiting for turn completion.',
      thinking: null,
      sessionId: 'sess-timeout',
      model: 'gpt-5.4',
      thinkingEffort: 'high',
      elapsedS: 905,
      inputTokens: 12,
      outputTokens: 34,
      cachedInputTokens: 56,
      cacheCreationInputTokens: null,
      contextWindow: null,
      contextUsedTokens: null,
      contextPercent: null,
      codexCumulative: null,
      error: 'Timed out after 900s waiting for turn completion.',
      stopReason: 'timeout',
      incomplete: true,
      activity: null,
    });

    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain('Incomplete Response');
    expect(edits[0].text).toContain('Timed out after 15m 5s before the agent reported completion.');
    expect(edits[0].text).toContain('Timed out after 900s waiting for turn completion.');
  });

  it('does not attach reply buttons for complete responses', async () => {
    const { bot, ctx, edits } = createBot();

    await (bot as any).sendFinalReply(ctx, 101, 'claude', {
      ok: true,
      message: 'Should I continue?',
      thinking: null,
      sessionId: 'sess-3',
      model: 'claude-opus-4-6',
      thinkingEffort: 'high',
      elapsedS: 5.1,
      inputTokens: 2,
      outputTokens: 12,
      cachedInputTokens: null,
      error: null,
      stopReason: null,
      incomplete: false,
    });

    expect(edits).toHaveLength(1);
    expect(edits[0].opts?.keyboard).toBeUndefined();
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

describe('TelegramBot.handleMessage streaming', () => {
  it('keeps artifact instructions out of the user prompt for resumed codex sessions', async () => {
    const { bot, ctx } = createBot();
    const cs = bot.chat(ctx.chatId);
    cs.agent = 'codex';
    cs.sessionId = 'sess-existing';

    const runStream = vi.spyOn(bot, 'runStream').mockImplementation(async (prompt: string, _cs: any, _files: string[], _onText: any, systemPrompt?: string) => {
      expect(prompt).toBe('Inspect this repo');
      expect(prompt).not.toContain('[Telegram Artifact Return]');
      expect(systemPrompt).toContain('[Telegram Artifact Return]');
      return {
        ok: true,
        message: 'done',
        thinking: null,
        sessionId: 'sess-existing',
        model: 'gpt-5.4',
        thinkingEffort: 'high',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
        cachedInputTokens: null,
        error: null,
        stopReason: null,
        incomplete: false,
      };
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    expect(runStream).toHaveBeenCalledOnce();
  });

  it('keeps codex commentary while hiding raw command details in the streaming preview', async () => {
    const { bot, ctx, edits } = createBot();
    bot.chat(ctx.chatId).agent = 'codex';

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('', '', '改动已经落下去了，现在跑相关单测确认结果\nRan: /bin/zsh -lc npm run build\nRan: /bin/zsh -lc npm test -- test/bot-telegram.unit.test.ts\n单测和 tsc 都过了，现在我再看一眼 diff');
      return {
        ok: true,
        message: 'codeclaw',
        thinking: null,
        sessionId: 'sess-stream-1',
        model: 'gpt-5.4',
        thinkingEffort: 'high',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
        cachedInputTokens: null,
        error: null,
        stopReason: null,
        incomplete: false,
      };
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    const preview = edits.find(e => !e.opts?.parseMode)?.text || '';
    expect(preview).toContain('Activity');
    expect(preview).toContain('改动已经落下去了，现在跑相关单测确认结果');
    expect(preview).toContain('单测和 tsc 都过了，现在我再看一眼 diff');
    expect(preview).not.toContain('Ran:');
    expect(preview).not.toContain('npm run build');
    expect(preview).not.toContain('npm test');
    expect(edits[edits.length - 1].text).toContain('codeclaw');
  });

  it('shows an abstract command summary when codex activity only contains commands', async () => {
    const { bot, ctx, edits } = createBot();
    bot.chat(ctx.chatId).agent = 'codex';

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('', '', 'Ran: /bin/zsh -lc npm run build\nRan: /bin/zsh -lc npm test');
      return {
        ok: true,
        message: 'done',
        thinking: null,
        sessionId: 'sess-stream-1b',
        model: 'gpt-5.4',
        thinkingEffort: 'high',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
        cachedInputTokens: null,
        error: null,
        stopReason: null,
        incomplete: false,
      };
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    const preview = edits.find(e => !e.opts?.parseMode)?.text || '';
    expect(preview).toContain('Activity');
    expect(preview).toContain('Executed 2 commands.');
    expect(preview).not.toContain('Ran:');
    expect(preview).not.toContain('npm run build');
    expect(preview).not.toContain('npm test');
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
      return {
        ok: true,
        message: 'done',
        thinking: null,
        sessionId: 'sess-stream-1c',
        model: 'gpt-5.4',
        thinkingEffort: 'high',
        elapsedS: 1.2,
        inputTokens: 9,
        outputTokens: 3,
        cachedInputTokens: null,
        error: null,
        stopReason: null,
        incomplete: false,
      };
    });

    await (bot as any).handleMessage({ text: 'Inspect this repo', files: [] }, ctx);

    const preview = edits.find(e => !e.opts?.parseMode)?.text || '';
    expect(preview).toContain('阶段1:');
    expect(preview).toContain('阶段2:');
    expect(preview).toContain('Executed 2 commands.');
    expect(preview).toContain('Running 1 command...');
    expect(preview).toContain('\n...\n');
    expect(preview).not.toContain('Ran:');
    expect(preview).not.toContain('git diff --stat');
  });

  it('waits for pending preview edits before sending the final reply', async () => {
    const { bot, ctx, channel, edits } = createBot();
    let previewCalls = 0;
    channel.editMessage = vi.fn(async (_chatId: number, _msgId: number, text: string, opts?: any) => {
      if (!opts?.parseMode) {
        previewCalls++;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      edits.push({ text, opts });
    });

    vi.spyOn(bot, 'runStream').mockImplementation(async (_prompt: string, _cs: any, _files: string[], onText: any) => {
      onText('Partial answer', '', 'Running...');
      return {
        ok: true,
        message: 'Final answer.',
        thinking: null,
        sessionId: 'sess-stream-2',
        model: 'claude-opus-4-6',
        thinkingEffort: 'high',
        elapsedS: 0.6,
        inputTokens: 4,
        outputTokens: 7,
        cachedInputTokens: null,
        error: null,
        stopReason: null,
        incomplete: false,
      };
    });

    await (bot as any).handleMessage({ text: 'Say final answer', files: [] }, ctx);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(previewCalls).toBeGreaterThan(0);
    expect(edits[edits.length - 1].text).toContain('Final answer.');
    expect(edits[edits.length - 1].opts?.parseMode).toBe('HTML');
  });
});

describe('TelegramBot.handleMessage artifacts', () => {
  it('uploads returned artifacts and cleans up the turn directory', async () => {
    const { bot, ctx, channel, files, edits } = createBot();
    let artifactDir = '';

    vi.spyOn(bot, 'runStream').mockImplementation(async (prompt: string, _cs: any, _files: string[], _onText: any, systemPrompt?: string) => {
      const manifestSource = systemPrompt ?? prompt;
      const manifestMatch = manifestSource.match(/write this JSON manifest: (.+)\nFormat:/);
      expect(manifestMatch?.[1]).toBeTruthy();
      const manifestPath = manifestMatch![1];
      artifactDir = path.dirname(manifestPath);

      fs.writeFileSync(path.join(artifactDir, 'shot.png'), Buffer.from('png-bytes'));
      fs.writeFileSync(path.join(artifactDir, 'notes.txt'), 'hello');
      fs.writeFileSync(manifestPath, JSON.stringify({
        files: [
          { path: 'shot.png', kind: 'photo', caption: 'Screenshot' },
          { path: 'notes.txt', kind: 'document', caption: 'Notes' },
        ],
      }));

      return {
        ok: true,
        message: 'Artifacts ready.',
        thinking: null,
        sessionId: 'sess-artifacts',
        model: 'claude-opus-4-6',
        thinkingEffort: 'high',
        elapsedS: 1.5,
        inputTokens: 10,
        outputTokens: 20,
        cachedInputTokens: null,
        error: null,
        stopReason: null,
        incomplete: false,
      };
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
    expect(fs.existsSync(artifactDir)).toBe(false);
  });

  it('rejects manifest entries that escape the turn directory', async () => {
    const { bot, ctx, channel, files } = createBot();
    const leakedPath = path.join(process.env.CODECLAW_WORKDIR!, 'secret.txt');
    fs.writeFileSync(leakedPath, 'do not leak');

    vi.spyOn(bot, 'runStream').mockImplementation(async (prompt: string, _cs: any, _files: string[], _onText: any, systemPrompt?: string) => {
      const manifestSource = systemPrompt ?? prompt;
      const manifestMatch = manifestSource.match(/write this JSON manifest: (.+)\nFormat:/);
      const manifestPath = manifestMatch![1];
      fs.writeFileSync(manifestPath, JSON.stringify({
        files: [
          { path: '../secret.txt', kind: 'document', caption: 'Leak' },
        ],
      }));

      return {
        ok: true,
        message: 'Done.',
        thinking: null,
        sessionId: 'sess-no-leak',
        model: 'claude-opus-4-6',
        thinkingEffort: 'high',
        elapsedS: 0.8,
        inputTokens: 5,
        outputTokens: 6,
        cachedInputTokens: null,
        error: null,
        stopReason: null,
        incomplete: false,
      };
    });

    await (bot as any).handleMessage({ text: 'Try to leak a file', files: [] }, ctx);

    expect(files).toHaveLength(0);
    expect(channel.sendFile).not.toHaveBeenCalled();
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

    const nextWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-tg-skill-next-'));
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
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-keepalive-bin-'));
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
