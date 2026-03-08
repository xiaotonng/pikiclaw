/**
 * E2E tests for TelegramChannel — real Telegram Bot API, no mocking.
 *
 * Requires env:
 *   TELEGRAM_BOT_TOKEN — bot token
 *   TELEGRAM_TEST_CHAT_ID — (optional) auto-detected from recent messages
 *
 * Interactive test flow — the bot sends prompts telling you what to do,
 * then polls for your response via a shared long-polling channel.
 *
 *  ┌─ SEND (bot → user) ─────────────────────────────────────┐
 *  │  1. connect                                              │
 *  │  2. send plain text                                      │
 *  │  3. send HTML rich text (bold, italic, code, link, etc.) │
 *  │  4. send photo                                           │
 *  │  5. send file                                            │
 *  │  6. send message with inline keyboard                    │
 *  │  7. send + edit + edit (streaming simulation)            │
 *  │  8. set bottom menu commands                             │
 *  ├─ RECEIVE (user → bot) ───────────────────────────────────┤
 *  │  9. receive text                                         │
 *  │ 10. receive photo                                        │
 *  │ 11. receive file                                         │
 *  │ 12. receive inline button click (callback query)         │
 *  │ 13. receive bottom menu command                          │
 *  │ 14. batch receive (5 rapid messages)                     │
 *  └─ CLEANUP ────────────────────────────────────────────────┘
 *  │ 15. drain                                                │
 *  └──────────────────────────────────────────────────────────┘
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TelegramChannel } from '../../src/channel-telegram.ts';
import type { TgMessage, TgContext, TgCallbackContext } from '../../src/channel-telegram.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG generator
// ---------------------------------------------------------------------------

function generateTestPng(w: number, h: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    let c = 0xffffffff;
    for (const b of Buffer.concat([typeB, data])) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, typeB, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  row[0] = 0;
  for (let x = 0; x < w; x++) { row[1 + x * 3] = 255; row[2 + x * 3] = 0; row[3 + x * 3] = 0; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
let CHAT_ID = parseInt(process.env.TELEGRAM_TEST_CHAT_ID ?? '', 10);
const SKIP = !TOKEN;
const TIMEOUT = 90_000;
const WAIT_TIMEOUT = 60_000;
const PROMPT_DELAY = 2000;


if (SKIP) {
  console.warn(
    '\n⚠  TELEGRAM_BOT_TOKEN not set — all Telegram E2E tests will be SKIPPED.\n' +
    '   To run them: TELEGRAM_BOT_TOKEN=xxx vitest test/channel-telegram.e2e.test.ts\n',
  );
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shared polling channel for all receive tests
// ---------------------------------------------------------------------------

/** ch  — outbound channel (send prompts, set menu, etc.) */
let ch: TelegramChannel;
/** rx  — inbound channel (long-polling, shared across receive tests) */
let rx: TelegramChannel;
let rxListenDone: Promise<void>;
let tmpDir: string;

// Current handler slots — swapped between tests
let _onMsg: ((msg: TgMessage, ctx: TgContext) => void) | null = null;
let _onCmd: ((cmd: string, args: string, ctx: TgContext) => void) | null = null;
let _onCb: ((data: string, ctx: TgCallbackContext) => void) | null = null;

/** Track all sent message IDs for auto-cleanup. */
const sentMsgIds: number[] = [];

interface ReceivedMsg { text: string; files: string[]; chatId: number; fromId: number }
interface ReceivedCmd { cmd: string; args: string; chatId: number }
interface ReceivedCb  { data: string; chatId: number; callbackId: string }

/** Send a prompt to the user, then wait so they can read it. */
async function prompt(text: string, opts?: any) {
  const msgId = await ch.send(CHAT_ID, text, opts);
  if (msgId) sentMsgIds.push(msgId);
  await wait(PROMPT_DELAY);
}

/** Wait for N messages from the shared polling channel. Also tracks user message IDs for cleanup. */
function waitMessages(n: number): Promise<ReceivedMsg[]> {
  const results: ReceivedMsg[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out — expected ${n} message(s), got ${results.length}`)), WAIT_TIMEOUT);
    _onMsg = (msg, ctx) => {
      sentMsgIds.push(ctx.messageId);
      results.push({ text: msg.text, files: msg.files, chatId: ctx.chatId, fromId: ctx.from.id });
      if (results.length >= n) { clearTimeout(timer); _onMsg = null; resolve(results); }
    };
  });
}

/** Wait for a single callback query. */
function waitCallback(): Promise<ReceivedCb> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for button click')), WAIT_TIMEOUT);
    _onCb = (data, ctx) => {
      clearTimeout(timer); _onCb = null;
      sentMsgIds.push(ctx.messageId);
      ctx.answerCallback('收到!');
      resolve({ data, chatId: ctx.chatId, callbackId: ctx.callbackId });
    };
  });
}

/** Wait for a single /command. */
function waitCommand(): Promise<ReceivedCmd> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for command')), WAIT_TIMEOUT);
    _onCmd = (cmd, args, ctx) => {
      clearTimeout(timer); _onCmd = null;
      sentMsgIds.push(ctx.messageId);
      resolve({ cmd, args, chatId: ctx.chatId });
    };
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (SKIP) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e2e-'));

  // Outbound channel
  ch = new TelegramChannel({ token: TOKEN, workdir: tmpDir, pollTimeout: 5, apiTimeout: 30 });
  await ch.connect();

  // Inbound polling channel — connect once, reuse for all receive tests
  rx = new TelegramChannel({ token: TOKEN, workdir: tmpDir, pollTimeout: 3, apiTimeout: 30 });
  await rx.connect();
  await rx.drain();

  // Wire handlers to dispatch to current test's slot
  rx.onMessage((msg, ctx) => { _onMsg?.(msg, ctx); });
  rx.onCommand((cmd, args, ctx) => {
    if (_onCmd) { _onCmd(cmd, args, ctx); }
    else { _onMsg?.({ text: `/${cmd} ${args}`.trim(), files: [] }, ctx); }
  });
  rx.onCallback((data, ctx) => { _onCb?.(data, ctx); });

  // Start polling in background
  rxListenDone = rx.listen();

  // Resolve chat ID: env var → getUpdates → poll for first message
  if (!CHAT_ID || isNaN(CHAT_ID)) {
    const detected = await ch.getRecentChatId();
    if (detected) {
      CHAT_ID = detected;
      console.log(`Auto-detected CHAT_ID=${CHAT_ID} from recent updates`);
    }
  }
  if (!CHAT_ID || isNaN(CHAT_ID)) {
    console.log('No recent messages — send any message to the bot to start...');
    const first = await waitMessages(1);
    CHAT_ID = first[0].chatId;
    console.log(`Auto-detected CHAT_ID=${CHAT_ID} from polling`);
  }

  // Register the resolved chat so setMenu can target it
  ch.knownChats.add(CHAT_ID);

  // Set menu commands early so they're visible by the time we test them
  await ch.setMenu([
    { command: 'help', description: '帮助信息' },
    { command: 'status', description: '查看状态' },
    { command: 'ping', description: '测试连通性' },
  ]);
}, TIMEOUT);

afterAll(async () => {
  if (!SKIP) {
    if (rx) { rx.disconnect(); await rxListenDone; }
    // Delete all messages sent during tests
    for (const id of sentMsgIds) {
      await ch?.deleteMessage(CHAT_ID, id).catch(() => {});
    }
    await ch?.clearMenu().catch(() => {});
    await ch?.send(CHAT_ID, '✅ E2E 测试全部完成!').catch(() => {});
    ch?.disconnect();
  }
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================================================
//  SEND (bot → user)
// =========================================================================

describe.skipIf(SKIP)('connect', () => {
  it('fetches bot info', () => {
    expect(ch.bot).toBeTruthy();
    expect(ch.bot!.username).toBeTruthy();
    expect(typeof ch.bot!.id).toBe('number');
    expect(ch.bot!.displayName).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('send plain text', () => {
  it('sends a plain text message', async () => {
    const msgId = await ch.send(CHAT_ID, '[e2e] 纯文本消息测试');
    expect(msgId).toBeGreaterThan(0);
    if (msgId) sentMsgIds.push(msgId);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('send HTML rich text', () => {
  it('sends bold, italic, code, pre, link, strikethrough, underline, spoiler, blockquote', async () => {
    const html = [
      '<b>粗体 Bold</b>',
      '<i>斜体 Italic</i>',
      '<u>下划线 Underline</u>',
      '<s>删除线 Strikethrough</s>',
      '<tg-spoiler>剧透内容 Spoiler</tg-spoiler>',
      '<code>行内代码 inline code</code>',
      '<pre>代码块\nmultiline\ncode block</pre>',
      '<pre><code class="language-python">def hello():\n    print("world")</code></pre>',
      '<a href="https://github.com">链接 Link</a>',
      '<blockquote>引用 Blockquote</blockquote>',
    ].join('\n\n');

    const msgId = await ch.send(CHAT_ID, html, { parseMode: 'HTML' });
    expect(msgId).toBeGreaterThan(0);
    if (msgId) sentMsgIds.push(msgId);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('send photo', () => {
  it('sends a programmatically generated PNG', async () => {
    const png = generateTestPng(100, 100);
    const msgId = await ch.sendPhoto(CHAT_ID, png, { caption: '[e2e] 🟥 100x100 红色 PNG' });
    expect(msgId).toBeGreaterThan(0);
    if (msgId) sentMsgIds.push(msgId);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('send file', () => {
  it('sends a text document', async () => {
    const content = `E2E test file\nTimestamp: ${new Date().toISOString()}\n这是一个测试文件。`;
    const msgId = await ch.sendDocument(CHAT_ID, content, 'e2e_test.txt', { caption: '[e2e] 测试文件' });
    expect(msgId).toBeGreaterThan(0);
    if (msgId) sentMsgIds.push(msgId);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('send inline keyboard', () => {
  it('sends a message with buttons and a URL button', async () => {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '👍 赞', callback_data: 'vote:up' },
          { text: '👎 踩', callback_data: 'vote:down' },
        ],
        [
          { text: '🔗 打开链接', url: 'https://github.com' },
        ],
      ],
    };
    const msgId = await ch.send(CHAT_ID, '[e2e] 带按钮的消息 — 这些按钮仅展示用', { keyboard });
    expect(msgId).toBeGreaterThan(0);
    if (msgId) sentMsgIds.push(msgId);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('streaming simulation', () => {
  it('sends placeholder, edits progressively, then final HTML result', async () => {
    const phId = await ch.send(CHAT_ID, '⏳ 思考中...');
    expect(phId).toBeGreaterThan(0);
    if (phId) sentMsgIds.push(phId);

    await wait(1200);
    await ch.editMessage(CHAT_ID, phId!, '⏳ 正在生成... 30%');
    await wait(1200);
    await ch.editMessage(CHAT_ID, phId!, '⏳ 正在生成... 70%');
    await wait(1200);
    await ch.editMessage(
      CHAT_ID, phId!,
      '<b>✅ 生成完成</b>\n\n<pre><code class="language-js">console.log("hello world");</code></pre>\n\n耗时 3.6s',
      { parseMode: 'HTML' },
    );
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('set bottom menu commands', () => {
  it('has already registered commands in beforeAll', () => {
    // setMenu was called in beforeAll so the menu is ready before receive tests.
    // If beforeAll succeeded, this is a pass.
    expect(true).toBe(true);
  });
});

// =========================================================================
//  RECEIVE (user → bot)
// =========================================================================

describe.skipIf(SKIP)('receive text', () => {
  it('receives a text message from the user', async () => {
    await prompt('📝 请发送文字: <code>hello e2e</code>', { parseMode: 'HTML' });

    const msgs = await waitMessages(1);
    expect(msgs.length).toBe(1);
    expect(msgs[0].chatId).toBe(CHAT_ID);
    expect(msgs[0].text.toLowerCase()).toContain('hello e2e');
    expect(msgs[0].files).toEqual([]);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('receive photo', () => {
  it('receives a photo and downloads it to local file', async () => {
    await prompt('🖼 请发送任意一张图片');

    const msgs = await waitMessages(1);
    expect(msgs.length).toBe(1);
    expect(msgs[0].chatId).toBe(CHAT_ID);
    expect(msgs[0].files.length).toBe(1);
    expect(fs.existsSync(msgs[0].files[0])).toBe(true);
    expect(fs.statSync(msgs[0].files[0]).size).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('receive file', () => {
  it('receives a document and downloads it to local file', async () => {
    await prompt('📎 请发送任意一个文件');

    const msgs = await waitMessages(1);
    expect(msgs.length).toBe(1);
    expect(msgs[0].chatId).toBe(CHAT_ID);
    expect(msgs[0].files.length).toBe(1);
    expect(fs.existsSync(msgs[0].files[0])).toBe(true);
    expect(fs.statSync(msgs[0].files[0]).size).toBeGreaterThan(0);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('receive inline button click', () => {
  it('receives callback data when user clicks an inline button', async () => {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🅰 选项 A', callback_data: 'pick:a' },
          { text: '🅱 选项 B', callback_data: 'pick:b' },
          { text: '🅲 选项 C', callback_data: 'pick:c' },
        ],
      ],
    };
    await prompt('👆 请点击下方任意一个按钮', { keyboard });

    const cb = await waitCallback();
    expect(cb.chatId).toBe(CHAT_ID);
    expect(cb.data).toMatch(/^pick:[abc]$/);
    expect(cb.callbackId).toBeTruthy();
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('receive bottom menu command', () => {
  it('receives a /command when user clicks the bottom menu', async () => {
    // Re-set menu right before this test to ensure it's fresh
    await ch.setMenu([
      { command: 'help', description: '帮助信息' },
      { command: 'status', description: '查看状态' },
      { command: 'ping', description: '测试连通性' },
    ]);
    await prompt(
      '⌨️ 请点击底部菜单栏，选择 <code>/ping</code> 命令\n' +
      '(点输入框左边的 <b>☰</b> 或 <b>/</b> 按钮打开菜单)\n' +
      '如果看不到菜单，请退出聊天再重新进入，或直接输入 <code>/ping</code>',
      { parseMode: 'HTML' },
    );

    const cmd = await waitCommand();
    expect(cmd.chatId).toBe(CHAT_ID);
    expect(cmd.cmd).toBe('ping');
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('batch receive', () => {
  it('receives 5 rapid messages without dropping any', async () => {
    await prompt(
      '⚡ 请快速连续发送 5 条消息，内容分别为: <code>1</code> <code>2</code> <code>3</code> <code>4</code> <code>5</code>',
      { parseMode: 'HTML' },
    );

    const msgs = await waitMessages(5);
    expect(msgs.length).toBe(5);
    for (const m of msgs) {
      expect(m.chatId).toBe(CHAT_ID);
    }
    const texts = msgs.map(m => m.text.trim());
    for (const n of ['1', '2', '3', '4', '5']) {
      expect(texts).toContain(n);
    }
  }, TIMEOUT);
});

// =========================================================================
//  CLEANUP
// =========================================================================

describe.skipIf(SKIP)('drain', () => {
  it('drains pending updates', async () => {
    const count = await ch.drain();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  }, TIMEOUT);
});
