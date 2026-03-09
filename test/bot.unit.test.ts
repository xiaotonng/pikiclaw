import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/code-agent.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/code-agent.ts')>();
  return {
    ...actual,
    doStream: vi.fn(),
  };
});

import { doStream } from '../src/code-agent.ts';
import { Bot } from '../src/bot.ts';

function makeResult(overrides: Partial<Awaited<ReturnType<typeof doStream>>> = {}) {
  return {
    ok: true,
    message: 'ok',
    thinking: null,
    sessionId: 'sess-1',
    model: 'gpt-5.4',
    thinkingEffort: 'high',
    elapsedS: 0.1,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: null,
    contextWindow: null,
    contextUsedTokens: null,
    contextPercent: null,
    codexCumulative: null,
    error: null,
    stopReason: null,
    incomplete: false,
    activity: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CODECLAW_WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-unit-workdir-'));
  process.env.DEFAULT_AGENT = 'codex';
});

describe('Bot.runStream', () => {
  it('passes prior Codex cumulative totals into resumed turns and stores updated totals', async () => {
    const doStreamMock = vi.mocked(doStream);
    doStreamMock
      .mockImplementationOnce(async opts => {
        expect(opts.codexPrevCumulative).toBeUndefined();
        return makeResult({
          sessionId: 'sess-resume',
          inputTokens: 5000,
          cachedInputTokens: 4000,
          outputTokens: 300,
          codexCumulative: { input: 5000, output: 300, cached: 4000 },
        });
      })
      .mockImplementationOnce(async opts => {
        expect(opts.codexPrevCumulative).toEqual({ input: 5000, output: 300, cached: 4000 });
        return makeResult({
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
  });

  it('clears cached Codex cumulative totals when switching workdirs', () => {
    const bot = new Bot();
    const cs = bot.chat(1);
    cs.agent = 'codex';
    cs.sessionId = 'sess-existing';
    cs.codexCumulative = { input: 8300, output: 360, cached: 6500 };

    const nextWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-unit-next-'));
    bot.switchWorkdir(nextWorkdir);

    expect(cs.sessionId).toBeNull();
    expect(cs.codexCumulative).toBeUndefined();
  });
});
