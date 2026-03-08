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
import { TelegramBot } from '../src/bot-telegram.ts';
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
  it('shows incomplete status and suppresses quick replies on agent error', async () => {
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

  it('keeps quick replies for complete responses', async () => {
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
    expect(edits[0].opts?.keyboard?.inline_keyboard).toHaveLength(1);
  });
});

describe('TelegramBot.handleMessage artifacts', () => {
  it('uploads returned artifacts and cleans up the turn directory', async () => {
    const { bot, ctx, channel, files, edits } = createBot();
    let artifactDir = '';

    vi.spyOn(bot, 'runStream').mockImplementation(async (prompt: string) => {
      const manifestMatch = prompt.match(/write this JSON manifest: (.+)\nFormat:/);
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

    // canCombine=true: placeholder deleted, text sent as photo caption
    expect(edits).toHaveLength(0);
    expect(channel.deleteMessage).toHaveBeenCalledTimes(1);
    expect(files).toHaveLength(2);
    expect(files[0].filePath).toContain('shot.png');
    // First photo gets the text response as caption instead of its own caption
    expect(files[0].opts).toMatchObject({ caption: 'Artifacts ready.', replyTo: ctx.messageId, asPhoto: true });
    expect(files[1].filePath).toContain('notes.txt');
    expect(files[1].opts).toMatchObject({ caption: 'Notes', replyTo: ctx.messageId, asPhoto: false });
    expect(channel.sendFile).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(artifactDir)).toBe(false);
  });

  it('rejects manifest entries that escape the turn directory', async () => {
    const { bot, ctx, channel, files } = createBot();
    const leakedPath = path.join(process.env.CODECLAW_WORKDIR!, 'secret.txt');
    fs.writeFileSync(leakedPath, 'do not leak');

    vi.spyOn(bot, 'runStream').mockImplementation(async (prompt: string) => {
      const manifestMatch = prompt.match(/write this JSON manifest: (.+)\nFormat:/);
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
