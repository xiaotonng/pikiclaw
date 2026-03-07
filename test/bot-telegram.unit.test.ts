import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramBot } from '../src/bot-telegram.ts';
import type { TgContext } from '../src/channel-telegram.ts';

function createBot() {
  const edits: Array<{ text: string; opts?: any }> = [];
  const sends: Array<{ text: string; opts?: any }> = [];
  const docs: Array<{ content: string | Buffer; filename: string; opts?: any }> = [];
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

  return { bot, channel, ctx, edits, sends, docs };
}

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-tg-unit-'));
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.CODECLAW_WORKDIR = tmpDir;
  process.env.DEFAULT_AGENT = 'claude';
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
