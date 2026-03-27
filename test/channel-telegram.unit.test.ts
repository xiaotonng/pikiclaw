/**
 * Unit tests for TelegramChannel — standalone, no core/agent needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TelegramChannel } from '../src/channel-telegram.ts';
import { makeTmpDir } from './support/env.ts';

function createTestChannel(overrides: Record<string, any> = {}) {
  const tmpDir = makeTmpDir('tg-test-');
  const ch = new TelegramChannel({ token: 'test-token', workdir: tmpDir, ...overrides });

  const apiCalls: { method: string; payload: any }[] = [];
  let msgIdCounter = 100;

  (ch as any).api = vi.fn(async (method: string, payload?: any) => {
    apiCalls.push({ method, payload });
    if (method === 'getMe') {
      return { ok: true, result: { id: 42, username: 'test_bot', first_name: 'TestBot' } };
    }
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: msgIdCounter++ } };
    }
    if (method === 'sendMessageDraft') {
      return { ok: true, result: true };
    }
    if (method === 'editMessageText') {
      return { ok: true, result: {} };
    }
    if (method === 'deleteMessage') {
      return { ok: true, result: true };
    }
    if (method === 'answerCallbackQuery') {
      return { ok: true, result: true };
    }
    if (method === 'sendChatAction') {
      return { ok: true, result: true };
    }
    if (method === 'setMyCommands') {
      return { ok: true, result: true };
    }
    if (method === 'getUpdates') {
      return { ok: true, result: [] };
    }
    if (method === 'getFile') {
      return { ok: true, result: { file_path: 'photos/test.jpg' } };
    }
    return { ok: true, result: {} };
  });

  return { ch, apiCalls, tmpDir };
}

async function feedUpdate(ch: any, update: any) {
  await (ch as any)._dispatch(update);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TelegramChannel connect and listen', () => {
  it('fetches bot info and reports polling conflicts and HTTP failures', async () => {
    // --- Sub-scenario 1: fetches bot info via getMe ---
    {
      const { ch, apiCalls } = createTestChannel();
      const bot = await ch.connect();

      expect(bot.id).toBe(42);
      expect(bot.username).toBe('test_bot');
      expect(bot.displayName).toBe('TestBot');
      expect(apiCalls[0].method).toBe('getMe');
    }

    // --- Sub-scenario 2: reports polling conflicts plus fetch and HTTP failures with useful details ---
    {
      const conflict = createTestChannel();
      const onError = vi.fn();
      (conflict.ch as any).api = vi.fn(async (method: string, payload?: any) => {
        if (method === 'getUpdates') {
          throw new Error('Telegram polling conflict: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running');
        }
        return { ok: true, result: payload ?? {} };
      });
      conflict.ch.onError(onError);
      await conflict.ch.listen();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]?.message).toContain('Telegram polling conflict:');

      const fetchFail = new TelegramChannel({ token: 'test-token', workdir: makeTmpDir('tg-test-') });
      const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.telegram.org'), {
        code: 'ENOTFOUND',
        errno: -3008,
        syscall: 'getaddrinfo',
        hostname: 'api.telegram.org',
      });
      const fetchErr = new TypeError('fetch failed');
      (fetchErr as any).cause = cause;
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => {
        throw fetchErr;
      }) as any;

      try {
        const pending = fetchFail.api('getUpdates', { offset: 0, timeout: 45 });
        await expect(pending).rejects.toThrow(/Telegram API getUpdates request failed after 55s: TypeError: fetch failed/);
        await expect(pending).rejects.toThrow(/code=ENOTFOUND/);
        await expect(pending).rejects.toThrow(/hostname=api\.telegram\.org/);
        await expect(pending).rejects.toThrow(/cause=Error: getaddrinfo ENOTFOUND api\.telegram\.org/);
      } finally {
        globalThis.fetch = origFetch;
      }

      const badJson = new TelegramChannel({ token: 'test-token', workdir: makeTmpDir('tg-test-') });
      const origFetch2 = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => '<html>upstream failed</html>',
      })) as any;

      try {
        await expect(badJson.api('getUpdates', { offset: 0, timeout: 45 })).rejects.toThrow(
          /Telegram API getUpdates returned invalid JSON: HTTP 502 Bad Gateway; body=<html>upstream failed<\/html>/,
        );
      } finally {
        globalThis.fetch = origFetch2;
      }
    }
  });
});

describe('TelegramChannel send, media, edit, and draft helpers', () => {
  it('sends messages with retry and fallback, routes files by mime type, and edits messages', async () => {
    // --- Sub-scenario 1: passes options through and logs outgoing text verbatim ---
    {
      const { ch, apiCalls } = createTestChannel();
      const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const originalLogLevel = process.env.PIKICLAW_LOG_LEVEL;
      process.env.PIKICLAW_LOG_LEVEL = 'debug';

      try {
        const msgId = await ch.send(123, 'line 1\nline 2', {
          parseMode: 'HTML',
          replyTo: 50,
          messageThreadId: 9,
        });

        expect(msgId).toBe(100);
        expect(apiCalls[0]).toEqual({
          method: 'sendMessage',
          payload: expect.objectContaining({
            chat_id: 123,
            text: 'line 1\nline 2',
            parse_mode: 'HTML',
            reply_to_message_id: 50,
            message_thread_id: 9,
          }),
        });

        const logged = writeSpy.mock.calls.map(args => String(args[0])).join('');
        expect(logged).toContain('[send] sendMessage chat=123 chunk=1/1');
        expect(logged).toContain('line 1\nline 2');
      } finally {
        if (originalLogLevel == null) delete process.env.PIKICLAW_LOG_LEVEL;
        else process.env.PIKICLAW_LOG_LEVEL = originalLogLevel;
        writeSpy.mockRestore();
      }
    }

    // --- Sub-scenario 2: retries transient failures, falls back on parse errors, and preserves terminal transport errors ---
    {
      const retry = createTestChannel();
      let attempts = 0;
      (retry.ch as any).api = vi.fn(async (method: string, payload?: any) => {
        retry.apiCalls.push({ method, payload });
        if (method === 'sendMessage') {
          attempts++;
          if (attempts === 1) {
            const cause = Object.assign(new Error('read ECONNRESET'), {
              code: 'ECONNRESET',
              errno: -54,
              syscall: 'read',
            });
            const err = new TypeError('fetch failed');
            (err as any).cause = cause;
            throw err;
          }
          return { ok: true, result: { message_id: 100 } };
        }
        return { ok: true, result: {} };
      });
      expect(await retry.ch.send(123, 'Hello world')).toBe(100);
      expect(attempts).toBe(2);

      const fallback = createTestChannel();
      const sendPayloads: any[] = [];
      let parseAttempts = 0;
      (fallback.ch as any).api = vi.fn(async (method: string, payload?: any) => {
        if (method === 'sendMessage') sendPayloads.push({ ...payload });
        if (method === 'sendMessage') {
          parseAttempts++;
          if (parseAttempts === 1) {
            throw new Error('Telegram API sendMessage: {"ok":false,"error_code":400,"description":"Bad Request: can\'t parse entities"}');
          }
          return { ok: true, result: { message_id: 101 } };
        }
        return { ok: true, result: {} };
      });
      expect(await fallback.ch.send(123, '<b>oops', { parseMode: 'HTML' })).toBe(101);
      expect(sendPayloads[0]?.parse_mode).toBe('HTML');
      expect(sendPayloads[1]?.parse_mode).toBeUndefined();

      const terminal = createTestChannel();
      (terminal.ch as any).api = vi.fn(async (method: string) => {
        if (method === 'sendMessage') {
          const cause = Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET',
            errno: -54,
            syscall: 'read',
          });
          const err = new TypeError('fetch failed');
          (err as any).cause = cause;
          throw err;
        }
        return { ok: true, result: {} };
      });
      const pending = terminal.ch.send(123, 'Hello world');
      await expect(pending).rejects.toThrow(/sendMessage failed: TypeError: fetch failed/);
      await expect(pending).rejects.toThrow(/code=ECONNRESET/);
    }

    // --- Sub-scenario 3: preserves upload metadata and routes files by mime type ---
    {
      const photo = createTestChannel();
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ ok: true, result: { message_id: 321 } }),
        json: async () => ({ ok: true, result: { message_id: 321 } }),
      }));
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as any;

      try {
        expect(await photo.ch.sendPhoto(123, Buffer.from('png-bytes'), {
          filename: 'shot.png',
          mimeType: 'image/png',
          caption: 'png',
        })).toBe(321);
        const req = fetchMock.mock.calls[0]?.[1];
        const body = String(req?.body);
        expect(body).toContain('filename="shot.png"');
        expect(body).toContain('Content-Type: image/png');
      } finally {
        globalThis.fetch = origFetch;
      }

      const routed = createTestChannel();
      const pngPath = path.join(routed.tmpDir, 'shot.png');
      const txtPath = path.join(routed.tmpDir, 'notes.txt');
      fs.writeFileSync(pngPath, 'fake-png');
      fs.writeFileSync(txtPath, 'hello');

      const sendPhoto = vi.spyOn(routed.ch, 'sendPhoto').mockResolvedValue(555);
      const sendDocument = vi.spyOn(routed.ch, 'sendDocument').mockResolvedValue(666);

      expect(await routed.ch.sendFile(123, pngPath, { caption: 'shot', replyTo: 7 })).toBe(555);
      expect(sendPhoto).toHaveBeenCalledWith(
        123,
        expect.any(Buffer),
        expect.objectContaining({ caption: 'shot', replyTo: 7, filename: 'shot.png', mimeType: 'image/png' }),
      );

      expect(await routed.ch.sendFile(123, txtPath, { caption: 'doc', replyTo: 8 })).toBe(666);
      expect(sendDocument).toHaveBeenCalledWith(
        123,
        expect.any(Buffer),
        'notes.txt',
        expect.objectContaining({ caption: 'doc', replyTo: 8 }),
      );

      await routed.ch.setMessageReaction(123, 456, ['👍', '⚠️']);
      expect(routed.apiCalls).toContainEqual({
        method: 'setMessageReaction',
        payload: {
          chat_id: 123,
          message_id: 456,
          reaction: [
            { type: 'emoji', emoji: '👍' },
            { type: 'emoji', emoji: '⚠️' },
          ],
          is_big: false,
        },
      });
    }

    // --- Sub-scenario 4: edits messages, skips empty payloads, and keeps edit and draft logs terse ---
    {
      const { ch, apiCalls } = createTestChannel();
      const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const originalLogLevel = process.env.PIKICLAW_LOG_LEVEL;
      process.env.PIKICLAW_LOG_LEVEL = 'debug';

      try {
        await ch.editMessage(123, 99, 'Updated text');
        expect(apiCalls[0]).toEqual({
          method: 'editMessageText',
          payload: expect.objectContaining({ message_id: 99 }),
        });

        const editLog = writeSpy.mock.calls.map(args => String(args[0])).join('');
        expect(editLog).toContain('[send] editMessageText chat=123 msg_id=99 chars=12');
        expect(editLog).not.toContain('Updated text');

        apiCalls.length = 0;
        await ch.editMessage(123, 99, '   ');
        expect(apiCalls).toHaveLength(0);

        writeSpy.mockClear();
        await ch.sendMessageDraft(123, 5, 'Partial answer', { messageThreadId: 99 });
        expect(apiCalls[0]).toEqual({
          method: 'sendMessageDraft',
          payload: { chat_id: 123, draft_id: 5, text: 'Partial answer', message_thread_id: 99 },
        });

        const draftLog = writeSpy.mock.calls.map(args => String(args[0])).join('');
        expect(draftLog).toContain('[send] sendMessageDraft chat=123 draft_id=5 thread=99 chars=14');
        expect(draftLog).not.toContain('Partial answer');
      } finally {
        if (originalLogLevel == null) delete process.env.PIKICLAW_LOG_LEVEL;
        else process.env.PIKICLAW_LOG_LEVEL = originalLogLevel;
        writeSpy.mockRestore();
      }
    }
  });
});

describe('TelegramChannel dispatch flow', () => {
  it('handles commands, plain messages, photos, callbacks, filtering, menus, and drains updates', async () => {
    const flow = createTestChannel();
    await flow.ch.connect();

    const log: string[] = [];
    (flow.ch as any).downloadFile = vi.fn(async (_fileId: string, destFilename: string) => {
      const p = path.join(flow.tmpDir, destFilename);
      fs.writeFileSync(p, 'fake-image-data');
      return p;
    });

    flow.ch.onCommand(async (cmd, args, ctx) => {
      log.push(`cmd:${cmd}:${args}`);
      await ctx.reply('Help text');
    });
    flow.ch.onMessage(async (msg, ctx) => {
      log.push(`msg:${msg.text}:files=${msg.files.length}`);
      const ph = await ctx.reply('thinking...');
      await ctx.editReply(ph!, `Echo: ${msg.text}`);
    });
    flow.ch.onCallback(async (data, ctx) => {
      log.push(`cb:${data}`);
      await ctx.answerCallback('ok');
    });

    await feedUpdate(flow.ch, {
      message: {
        message_id: 1,
        chat: { id: 100, type: 'private' },
        from: { id: 200 },
        text: '/engine codex',
        entities: [{ type: 'bot_command', offset: 0, length: 7 }],
      },
    });
    await feedUpdate(flow.ch, {
      message: {
        message_id: 2,
        chat: { id: 100, type: 'group' },
        from: { id: 200 },
        text: '@test_bot Build me a website',
        reply_to_message: { from: { id: 42 } },
      },
    });
    await feedUpdate(flow.ch, {
      message: {
        message_id: 3,
        chat: { id: 100, type: 'private' },
        from: { id: 200 },
        caption: 'Analyze this',
        photo: [
          { file_id: 'small', file_size: 100 },
          { file_id: 'large', file_size: 5000 },
        ],
      },
    });
    await feedUpdate(flow.ch, {
      callback_query: {
        id: 'cq-99',
        data: 'yes',
        from: { id: 200 },
        message: { message_id: 3, chat: { id: 100 } },
      },
    });

    expect(log).toEqual([
      'cmd:engine:codex',
      'msg:Build me a website:files=0',
      'msg:Analyze this:files=1',
      'cb:yes',
    ]);
    expect(flow.apiCalls.map(call => call.method)).toEqual(expect.arrayContaining([
      'sendMessage',
      'editMessageText',
      'answerCallbackQuery',
    ]));

    const filtered = createTestChannel({ allowedChatIds: new Set([999]) });
    await filtered.ch.connect();
    const blocked = vi.fn();
    filtered.ch.onMessage(blocked);
    await feedUpdate(filtered.ch, {
      message: { message_id: 40, chat: { id: 100, type: 'private' }, from: { id: 200 }, text: 'hello' },
    });
    expect(blocked).not.toHaveBeenCalled();

    const requireMention = createTestChannel();
    await requireMention.ch.connect();
    const ignored = vi.fn();
    requireMention.ch.onMessage(ignored);
    await feedUpdate(requireMention.ch, {
      message: { message_id: 41, chat: { id: 100, type: 'group' }, from: { id: 200 }, text: 'hello' },
    });
    expect(ignored).not.toHaveBeenCalled();

    await flow.ch.setMenu([{ command: 'help', description: 'Show help' }]);
    expect(flow.apiCalls.some(call => call.method === 'setMyCommands')).toBe(true);

    (flow.ch as any).api = vi.fn(async () => ({ ok: true, result: [{ update_id: 999 }] }));
    expect(await flow.ch.drain()).toBe(1);
  });
});
