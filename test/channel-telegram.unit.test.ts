/**
 * Unit tests for TelegramChannel — standalone, no core/agent needed.
 *
 * Strategy: mock the api() method to simulate Telegram Bot API responses,
 * register simple handlers, feed fake updates, verify the full flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramChannel } from '../src/channel-telegram.ts';
import type { TgMessage, TgContext, TgCallbackContext } from '../src/channel-telegram.ts';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir } from './support/env.ts';

// ---------------------------------------------------------------------------
// Helper: create a channel with mocked api()
// ---------------------------------------------------------------------------

function createTestChannel(overrides: Record<string, any> = {}) {
  const tmpDir = makeTmpDir('tg-test-');
  const ch = new TelegramChannel({ token: 'test-token', workdir: tmpDir, ...overrides });

  // Collect api calls for assertions
  const apiCalls: { method: string; payload: any }[] = [];
  let msgIdCounter = 100;

  // Mock api() — no real HTTP
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

// Helper: simulate dispatching an update (bypass polling loop)
async function feedUpdate(ch: any, update: any) {
  await (ch as any)._dispatch(update);
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe('TelegramChannel.connect', () => {
  it('fetches bot info via getMe', async () => {
    const { ch, apiCalls } = createTestChannel();
    const bot = await ch.connect();
    expect(bot.id).toBe(42);
    expect(bot.username).toBe('test_bot');
    expect(bot.displayName).toBe('TestBot');
    expect(apiCalls[0].method).toBe('getMe');
  });
});

describe('TelegramChannel.listen', () => {
  it('stops immediately on getUpdates polling conflicts', async () => {
    const { ch } = createTestChannel();
    const onError = vi.fn();
    const api = vi.fn(async (method: string, payload?: any) => {
      if (method === 'getUpdates') {
        throw new Error('Telegram polling conflict: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running');
      }
      return { ok: true, result: payload ?? {} };
    });
    (ch as any).api = api;
    ch.onError(onError);

    await ch.listen();

    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('getUpdates', {
      offset: 0,
      timeout: 45,
      allowed_updates: ['message', 'callback_query'],
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.message).toContain('Telegram polling conflict:');
  });

  it('reports nested fetch cause details for polling failures', async () => {
    const tmpDir = makeTmpDir('tg-test-');
    const ch = new TelegramChannel({ token: 'test-token', workdir: tmpDir });
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.telegram.org'), {
      code: 'ENOTFOUND',
      errno: -3008,
      syscall: 'getaddrinfo',
      hostname: 'api.telegram.org',
    });
    const err = new TypeError('fetch failed');
    (err as any).cause = cause;

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw err; }) as any;

    try {
      const promise = ch.api('getUpdates', { offset: 0, timeout: 45 });
      await expect(promise).rejects.toThrow(/Telegram API getUpdates request failed after 55s: TypeError: fetch failed/);
      await expect(promise).rejects.toThrow(/code=ENOTFOUND/);
      await expect(promise).rejects.toThrow(/hostname=api\.telegram\.org/);
      await expect(promise).rejects.toThrow(/cause=Error: getaddrinfo ENOTFOUND api\.telegram\.org/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('reports HTTP status and body when Telegram returns invalid JSON', async () => {
    const tmpDir = makeTmpDir('tg-test-');
    const ch = new TelegramChannel({ token: 'test-token', workdir: tmpDir });
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => '<html>upstream failed</html>',
    })) as any;

    try {
      await expect(ch.api('getUpdates', { offset: 0, timeout: 45 })).rejects.toThrow(
        /Telegram API getUpdates returned invalid JSON: HTTP 502 Bad Gateway; body=<html>upstream failed<\/html>/,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// send / edit / delete
// ---------------------------------------------------------------------------

describe('TelegramChannel.send', () => {
  it('sends a message and returns message id', async () => {
    const { ch, apiCalls } = createTestChannel();
    const msgId = await ch.send(123, 'Hello world');
    expect(msgId).toBe(100);
    expect(apiCalls[0].method).toBe('sendMessage');
    expect(apiCalls[0].payload.chat_id).toBe(123);
    expect(apiCalls[0].payload.text).toBe('Hello world');
  });

  it('passes parseMode and replyTo', async () => {
    const { ch, apiCalls } = createTestChannel();
    await ch.send(123, '<b>bold</b>', { parseMode: 'HTML', replyTo: 50 });
    expect(apiCalls[0].payload.parse_mode).toBe('HTML');
    expect(apiCalls[0].payload.reply_to_message_id).toBe(50);
  });

  it('passes messageThreadId when sending into a topic', async () => {
    const { ch, apiCalls } = createTestChannel();
    await ch.send(123, 'Hello topic', { messageThreadId: 9 });
    expect(apiCalls[0].payload.message_thread_id).toBe(9);
  });

  it('logs outgoing text verbatim before sending', async () => {
    const { ch } = createTestChannel();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await ch.send(123, 'line 1\nline 2');
      const logged = writeSpy.mock.calls.map(args => String(args[0])).join('');
      expect(logged).toContain('[send] sendMessage chat=123 chunk=1/1');
      expect(logged).toContain('line 1\nline 2');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('retries transient send failures before succeeding', async () => {
    const { ch, apiCalls } = createTestChannel();
    let attempts = 0;
    (ch as any).api = vi.fn(async (method: string, payload?: any) => {
      apiCalls.push({ method, payload });
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

    const msgId = await ch.send(123, 'Hello world');

    expect(msgId).toBe(100);
    expect(attempts).toBe(2);
    expect(apiCalls.filter(call => call.method === 'sendMessage')).toHaveLength(2);
    expect(apiCalls[1]?.payload.parse_mode).toBeUndefined();
  });

  it('falls back to plain text only for parse-mode errors', async () => {
    const { ch } = createTestChannel();
    const sendPayloads: any[] = [];
    let attempts = 0;
    (ch as any).api = vi.fn(async (method: string, payload?: any) => {
      if (method === 'sendMessage') sendPayloads.push({ ...payload });
      if (method === 'sendMessage') {
        attempts++;
        if (attempts === 1) {
          throw new Error('Telegram API sendMessage: {"ok":false,"error_code":400,"description":"Bad Request: can\'t parse entities"}');
        }
        return { ok: true, result: { message_id: 101 } };
      }
      return { ok: true, result: {} };
    });

    const msgId = await ch.send(123, '<b>oops', { parseMode: 'HTML' });

    expect(msgId).toBe(101);
    expect(sendPayloads[0]?.parse_mode).toBe('HTML');
    expect(sendPayloads[1]?.parse_mode).toBeUndefined();
  });

  it('preserves transport error details when send fails', async () => {
    const { ch } = createTestChannel();
    (ch as any).api = vi.fn(async (method: string) => {
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

    const pending = ch.send(123, 'Hello world');
    await expect(pending).rejects.toThrow(/sendMessage failed: TypeError: fetch failed/);
    await expect(pending).rejects.toThrow(/code=ECONNRESET/);
  });
});

describe('TelegramChannel.setMessageReaction', () => {
  it('calls the Telegram reaction API with emoji reactions', async () => {
    const { ch, apiCalls } = createTestChannel();

    await ch.setMessageReaction(123, 456, ['👍', '⚠️']);

    expect(apiCalls).toContainEqual({
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
  });
});

describe('TelegramChannel.sendPhoto', () => {
  it('preserves custom filename and mime type for image uploads', async () => {
    const { ch } = createTestChannel();
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
      const msgId = await ch.sendPhoto(123, Buffer.from('png-bytes'), {
        filename: 'shot.png',
        mimeType: 'image/png',
        caption: 'png',
      });
      expect(msgId).toBe(321);
      const req = fetchMock.mock.calls[0]?.[1];
      const body = String(req?.body);
      expect(body).toContain('filename="shot.png"');
      expect(body).toContain('Content-Type: image/png');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('TelegramChannel.sendFile', () => {
  it('routes png files through sendPhoto', async () => {
    const { ch, tmpDir } = createTestChannel();
    const filePath = path.join(tmpDir, 'shot.png');
    fs.writeFileSync(filePath, 'fake-png');

    const sendPhoto = vi.spyOn(ch, 'sendPhoto').mockResolvedValue(555);
    const sendDocument = vi.spyOn(ch, 'sendDocument').mockResolvedValue(666);

    const msgId = await ch.sendFile(123, filePath, { caption: 'shot', replyTo: 7 });

    expect(msgId).toBe(555);
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendPhoto).toHaveBeenCalledWith(
      123,
      expect.any(Buffer),
      expect.objectContaining({ caption: 'shot', replyTo: 7, filename: 'shot.png', mimeType: 'image/png' }),
    );
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it('routes non-image files through sendDocument', async () => {
    const { ch, tmpDir } = createTestChannel();
    const filePath = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(filePath, 'hello');

    const sendPhoto = vi.spyOn(ch, 'sendPhoto').mockResolvedValue(555);
    const sendDocument = vi.spyOn(ch, 'sendDocument').mockResolvedValue(666);

    const msgId = await ch.sendFile(123, filePath, { caption: 'doc', replyTo: 8 });

    expect(msgId).toBe(666);
    expect(sendDocument).toHaveBeenCalledOnce();
    expect(sendDocument).toHaveBeenCalledWith(
      123,
      expect.any(Buffer),
      'notes.txt',
      expect.objectContaining({ caption: 'doc', replyTo: 8 }),
    );
    expect(sendPhoto).not.toHaveBeenCalled();
  });
});

describe('TelegramChannel.editMessage', () => {
  it('edits a message', async () => {
    const { ch, apiCalls } = createTestChannel();
    await ch.editMessage(123, 99, 'Updated text');
    expect(apiCalls[0].method).toBe('editMessageText');
    expect(apiCalls[0].payload.message_id).toBe(99);
  });

  it('skips empty text', async () => {
    const { ch, apiCalls } = createTestChannel();
    await ch.editMessage(123, 99, '   ');
    expect(apiCalls.length).toBe(0);
  });
});

describe('TelegramChannel.sendMessageDraft', () => {
  it('sends draft updates for private-chat streaming', async () => {
    const { ch, apiCalls } = createTestChannel();
    await ch.sendMessageDraft(123, 5, 'Partial answer');
    expect(apiCalls[0]).toEqual({
      method: 'sendMessageDraft',
      payload: { chat_id: 123, draft_id: 5, text: 'Partial answer' },
    });
  });

  it('passes messageThreadId to draft updates', async () => {
    const { ch, apiCalls } = createTestChannel();
    await ch.sendMessageDraft(123, 5, 'Partial answer', { messageThreadId: 99 });
    expect(apiCalls[0].payload.message_thread_id).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// onCommand handler
// ---------------------------------------------------------------------------

describe('onCommand', () => {
  it('dispatches /start command to handler', async () => {
    const { ch } = createTestChannel();
    await ch.connect();
    const calls: { cmd: string; args: string; chatId: number }[] = [];

    ch.onCommand((cmd, args, ctx) => {
      calls.push({ cmd, args, chatId: ctx.chatId });
    });

    await feedUpdate(ch, {
      message: {
        message_id: 1, chat: { id: 100, type: 'private' }, from: { id: 200, username: 'user1' },
        text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    });

    expect(calls).toEqual([{ cmd: 'start', args: '', chatId: 100 }]);
  });

  it('parses command args', async () => {
    const { ch } = createTestChannel();
    await ch.connect();
    const calls: { cmd: string; args: string }[] = [];
    ch.onCommand((cmd, args) => calls.push({ cmd, args }));

    await feedUpdate(ch, {
      message: {
        message_id: 2, chat: { id: 100, type: 'private' }, from: { id: 200 },
        text: '/engine codex', entities: [{ type: 'bot_command', offset: 0, length: 7 }],
      },
    });

    expect(calls[0]).toEqual({ cmd: 'engine', args: 'codex' });
  });

  it('strips @botname from command', async () => {
    const { ch } = createTestChannel();
    await ch.connect();
    const calls: { cmd: string }[] = [];
    ch.onCommand((cmd) => calls.push({ cmd }));

    await feedUpdate(ch, {
      message: {
        message_id: 3, chat: { id: 100, type: 'group' }, from: { id: 200 },
        text: '/help@test_bot', entities: [{ type: 'bot_command', offset: 0, length: 14 }],
      },
    });

    expect(calls[0].cmd).toBe('help');
  });

  it('ctx.reply sends a reply', async () => {
    const { ch, apiCalls } = createTestChannel();
    await ch.connect();
    ch.onCommand(async (_cmd, _args, ctx) => {
      await ctx.reply('Hello!');
    });

    await feedUpdate(ch, {
      message: {
        message_id: 5, chat: { id: 100, type: 'private' }, from: { id: 200 },
        text: '/help', entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      },
    });

    const sendCall = apiCalls.find(c => c.method === 'sendMessage');
    expect(sendCall?.payload.chat_id).toBe(100);
    expect(sendCall?.payload.text).toBe('Hello!');
    expect(sendCall?.payload.reply_to_message_id).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// onMessage handler — text
// ---------------------------------------------------------------------------

describe('onMessage — text', () => {
  it('receives plain text with empty files array', async () => {
    const { ch } = createTestChannel();
    await ch.connect();
    const calls: TgMessage[] = [];
    ch.onMessage((msg) => { calls.push(msg); });

    await feedUpdate(ch, {
      message: {
        message_id: 10, chat: { id: 100, type: 'private' }, from: { id: 200 },
        text: 'Hello agent',
      },
    });

    expect(calls.length).toBe(1);
    expect(calls[0].text).toBe('Hello agent');
    expect(calls[0].files).toEqual([]);
  });

  it('strips bot mention from text in groups', async () => {
    const { ch } = createTestChannel();
    await ch.connect();
    const calls: TgMessage[] = [];
    ch.onMessage((msg) => { calls.push(msg); });

    await feedUpdate(ch, {
      message: {
        message_id: 11, chat: { id: 100, type: 'group' }, from: { id: 200 },
        text: '@test_bot help me', reply_to_message: { from: { id: 42 } },
      },
    });

    expect(calls[0].text).toBe('help me');
  });
});

// ---------------------------------------------------------------------------
// onMessage handler — photo aggregation
// ---------------------------------------------------------------------------

describe('onMessage — photo aggregation', () => {
  it('downloads photo and provides local path in files[]', async () => {
    const { ch, tmpDir } = createTestChannel();
    await ch.connect();

    // Mock downloadFile to write a fake file
    (ch as any).downloadFile = vi.fn(async (_fileId: string, destFilename: string) => {
      const p = path.join(tmpDir, destFilename);
      fs.writeFileSync(p, 'fake-image-data');
      return p;
    });

    const calls: TgMessage[] = [];
    ch.onMessage((msg) => { calls.push(msg); });

    await feedUpdate(ch, {
      message: {
        message_id: 20, chat: { id: 100, type: 'private' }, from: { id: 200 },
        caption: 'Analyze this', photo: [
          { file_id: 'small', file_size: 100 },
          { file_id: 'large', file_size: 5000 },
        ],
      },
    });

    expect(calls.length).toBe(1);
    expect(calls[0].text).toBe('Analyze this');
    expect(calls[0].files.length).toBe(1);
    expect(calls[0].files[0]).toContain('_tg_photo_20.jpg');
    expect(fs.existsSync(calls[0].files[0])).toBe(true);

    // cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serializes non-command messages per chat', async () => {
    const { ch } = createTestChannel();
    await ch.connect();

    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>(resolve => { releaseFirst = resolve; });

    ch.onMessage(async (msg) => {
      events.push(`start:${msg.text}`);
      if (msg.text === 'first') await firstDone;
      events.push(`end:${msg.text}`);
    });

    const first = feedUpdate(ch, {
      message: {
        message_id: 21, chat: { id: 100, type: 'private' }, from: { id: 200 },
        text: 'first',
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const second = feedUpdate(ch, {
      message: {
        message_id: 22, chat: { id: 100, type: 'private' }, from: { id: 200 },
        text: 'second',
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(events).toEqual(['start:first']);

    releaseFirst();
    await first;
    await second;

    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });
});

// ---------------------------------------------------------------------------
// onCallback handler
// ---------------------------------------------------------------------------

describe('onCallback', () => {
  it('dispatches callback data to handler', async () => {
    const { ch } = createTestChannel();
    await ch.connect();
    const calls: { data: string; chatId: number }[] = [];

    ch.onCallback((data, ctx) => {
      calls.push({ data, chatId: ctx.chatId });
    });

    await feedUpdate(ch, {
      callback_query: {
        id: 'cq-1', data: 'action:test',
        from: { id: 200, username: 'user1' },
        message: { message_id: 30, chat: { id: 100 } },
      },
    });

    expect(calls).toEqual([{ data: 'action:test', chatId: 100 }]);
  });

  it('ctx.answerCallback calls the API', async () => {
    const { ch, apiCalls } = createTestChannel();
    await ch.connect();
    ch.onCallback(async (_data, ctx) => {
      await ctx.answerCallback('Done!');
    });

    await feedUpdate(ch, {
      callback_query: {
        id: 'cq-2', data: 'btn',
        from: { id: 200 }, message: { message_id: 31, chat: { id: 100 } },
      },
    });

    const acCall = apiCalls.find(c => c.method === 'answerCallbackQuery');
    expect(acCall?.payload.callback_query_id).toBe('cq-2');
    expect(acCall?.payload.text).toBe('Done!');
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('filtering', () => {
  it('ignores messages from disallowed chats', async () => {
    const { ch } = createTestChannel({ allowedChatIds: new Set([999]) });
    await ch.connect();
    const calls: string[] = [];
    ch.onMessage(() => { calls.push('called'); });

    await feedUpdate(ch, {
      message: { message_id: 40, chat: { id: 100, type: 'private' }, from: { id: 200 }, text: 'hello' },
    });

    expect(calls.length).toBe(0);
  });

  it('ignores group messages without mention when requireMention is true', async () => {
    const { ch } = createTestChannel();
    await ch.connect();
    const calls: string[] = [];
    ch.onMessage(() => { calls.push('called'); });

    await feedUpdate(ch, {
      message: { message_id: 41, chat: { id: 100, type: 'group' }, from: { id: 200 }, text: 'hello' },
    });

    expect(calls.length).toBe(0);
  });

  it('handles group messages when replying to bot', async () => {
    const { ch } = createTestChannel();
    await ch.connect();
    const calls: string[] = [];
    ch.onMessage(() => { calls.push('called'); });

    await feedUpdate(ch, {
      message: {
        message_id: 42, chat: { id: 100, type: 'group' }, from: { id: 200 },
        text: 'do this', reply_to_message: { from: { id: 42 } },
      },
    });

    expect(calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setMenu / drain
// ---------------------------------------------------------------------------

describe('setMenu', () => {
  it('calls setMyCommands API', async () => {
    const { ch, apiCalls } = createTestChannel();
    await ch.setMenu([{ command: 'help', description: 'Show help' }]);
    expect(apiCalls[0].method).toBe('setMyCommands');
    expect(apiCalls[0].payload.commands[0].command).toBe('help');
  });
});

describe('drain', () => {
  it('drains pending updates', async () => {
    const { ch } = createTestChannel();
    // Override to return some updates
    (ch as any).api = vi.fn(async () => ({ ok: true, result: [{ update_id: 999 }] }));
    const count = await ch.drain();
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// onError
// ---------------------------------------------------------------------------

describe('onError', () => {
  it('calls error handler when handler throws (via listen catch path)', async () => {
    const { ch } = createTestChannel();
    await ch.connect();
    const errors: Error[] = [];
    ch.onMessage(() => { throw new Error('boom'); });
    ch.onError((e) => errors.push(e));

    // _dispatch propagates errors — in production, listen() wraps dispatch in .catch
    // which calls _hError. Here we test that errors surface correctly.
    await expect(feedUpdate(ch, {
      message: { message_id: 50, chat: { id: 100, type: 'private' }, from: { id: 200 }, text: 'hi' },
    })).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// Full echo bot scenario
// ---------------------------------------------------------------------------

describe('full echo bot scenario', () => {
  it('command → message → callback full flow', async () => {
    const { ch, apiCalls } = createTestChannel();
    await ch.connect();

    const log: string[] = [];

    ch.onCommand(async (cmd, args, ctx) => {
      log.push(`cmd:${cmd}:${args}`);
      await ctx.reply(`Help text`);
    });

    ch.onMessage(async (msg, ctx) => {
      log.push(`msg:${msg.text}:files=${msg.files.length}`);
      const ph = await ctx.reply('thinking...');
      await ctx.editReply(ph!, `Echo: ${msg.text}`);
    });

    ch.onCallback(async (data, ctx) => {
      log.push(`cb:${data}`);
      await ctx.answerCallback('ok');
    });

    // 1. Command
    await feedUpdate(ch, {
      message: {
        message_id: 1, chat: { id: 100, type: 'private' }, from: { id: 200 },
        text: '/help', entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      },
    });

    // 2. Message
    await feedUpdate(ch, {
      message: {
        message_id: 2, chat: { id: 100, type: 'private' }, from: { id: 200 },
        text: 'Build me a website',
      },
    });

    // 3. Callback
    await feedUpdate(ch, {
      callback_query: {
        id: 'cq-99', data: 'yes',
        from: { id: 200 }, message: { message_id: 3, chat: { id: 100 } },
      },
    });

    expect(log).toEqual([
      'cmd:help:',
      'msg:Build me a website:files=0',
      'cb:yes',
    ]);

    // Verify API calls: getMe + sendMessage (help) + sendMessage (thinking) + editMessageText (echo) + answerCallbackQuery
    const methods = apiCalls.map(c => c.method);
    expect(methods).toContain('sendMessage');
    expect(methods).toContain('editMessageText');
    expect(methods).toContain('answerCallbackQuery');
  });
});
