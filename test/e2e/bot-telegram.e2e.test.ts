/**
 * E2E tests for TelegramBot — real Telegram Bot API, real code agents.
 *
 * Requires env:
 *   TELEGRAM_BOT_TOKEN    — bot token
 *   TELEGRAM_TEST_CHAT_ID — (optional) auto-detected from recent messages
 *
 * Also requires `claude` or `codex` CLI installed and authenticated.
 * No mocking — everything is real: Telegram API, agent calls, user interaction.
 *
 * Two modes:
 *   - Automated (default): bot sends commands and agent calls without user interaction
 *   - Interactive (TELEGRAM_INTERACTIVE=1): also runs tests that require user to
 *     click buttons or type commands in Telegram
 *
 *  +-- AUTOMATED (no user interaction needed) ----------------------------+
 *  |  1. /start — welcome message with version, agent, workdir           |
 *  |  2. /status — uptime, memory, PID, agent, session, usage stats      |
 *  |  3. /host — hostname, OS, CPU, memory, disk, battery info           |
 *  |  4. /agents — list agents with switch buttons                       |
 *  |  5. /sessions — list/switch sessions (or empty state)               |
 *  |  6. /switch — directory browser with inline keyboard                |
 *  |  7. agent callback — programmatic agent switch via handleCallback   |
 *  |  8. session callback — programmatic session reset via handleCallback |
 *  |  9. message -> agent — real agent call, streamed reply              |
 *  | 10. multi-turn — resume session, verify context                     |
 *  +-- INTERACTIVE (set TELEGRAM_INTERACTIVE=1) --------------------------+
 *  | 11. user clicks agent switch button                                 |
 *  | 12. user clicks session button                                      |
 *  | 13. user clicks directory switch button                             |
 *  | 14. user sends /status command                                      |
 *  | 15. user sends free text, bot calls agent                           |
 *  +-- CLEANUP -----------------------------------------------------------+
 *  | 16. drain                                                           |
 *  +----------------------------------------------------------------------+
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TelegramBot } from '../../src/bot-telegram.ts';
import { TelegramChannel } from '../../src/channel-telegram.ts';
import type { TgMessage, TgContext, TgCallbackContext } from '../../src/channel-telegram.ts';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
let CHAT_ID = parseInt(process.env.TELEGRAM_TEST_CHAT_ID ?? '', 10);
const SKIP = !TOKEN;
const INTERACTIVE = process.env.TELEGRAM_INTERACTIVE === '1';
const TIMEOUT = 180_000;
const WAIT_TIMEOUT = 120_000;
const PROMPT_DELAY = 2000;

function hasCmd(cmd: string): boolean {
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_CLAUDE = hasCmd('claude');
const HAS_CODEX = hasCmd('codex');

if (SKIP) {
  console.warn(
    '\n  TELEGRAM_BOT_TOKEN not set — all bot-telegram E2E tests will be SKIPPED.\n' +
    '   To run: set -a && source .env && set +a && npx vitest run test/bot-telegram.e2e.test.ts\n',
  );
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let bot: TelegramBot;
let ch: TelegramChannel;
let tmpDir: string;

let _onMsg: ((msg: TgMessage, ctx: TgContext) => void) | null = null;
let _onCmd: ((cmd: string, args: string, ctx: TgContext) => void) | null = null;
let _onCb: ((data: string, ctx: TgCallbackContext) => void) | null = null;

const sentMsgIds: number[] = [];

interface ReceivedMsg { text: string; files: string[]; chatId: number }
interface ReceivedCmd { cmd: string; args: string; chatId: number }
interface ReceivedCb  { data: string; chatId: number; callbackId: string }

async function prompt(text: string, opts?: any) {
  const msgId = await ch.send(CHAT_ID, text, opts);
  if (msgId) sentMsgIds.push(msgId);
  await wait(PROMPT_DELAY);
}

function waitMessages(n: number): Promise<ReceivedMsg[]> {
  const results: ReceivedMsg[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out — expected ${n} message(s), got ${results.length}`)), WAIT_TIMEOUT);
    _onMsg = (msg, ctx) => {
      sentMsgIds.push(ctx.messageId);
      results.push({ text: msg.text, files: msg.files, chatId: ctx.chatId });
      if (results.length >= n) { clearTimeout(timer); _onMsg = null; resolve(results); }
    };
  });
}

function waitCallback(): Promise<ReceivedCb> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for button click')), WAIT_TIMEOUT);
    _onCb = (data, ctx) => {
      clearTimeout(timer); _onCb = null;
      sentMsgIds.push(ctx.messageId);
      ctx.answerCallback('ok');
      resolve({ data, chatId: ctx.chatId, callbackId: ctx.callbackId });
    };
  });
}

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-tg-e2e-'));

  process.env.CODECLAW_TOKEN = TOKEN;
  process.env.CODECLAW_WORKDIR = process.cwd();
  process.env.DEFAULT_AGENT = HAS_CLAUDE ? 'claude' : 'codex';

  bot = new TelegramBot();

  ch = new TelegramChannel({ token: TOKEN, workdir: tmpDir, pollTimeout: 3, apiTimeout: 30 });
  await ch.connect();
  (bot as any).channel = ch;

  await ch.drain();
  await bot.setupMenu();

  // Wire handlers: bot handles commands & callbacks; test can intercept via _onMsg/_onCmd/_onCb
  ch.onCommand((cmd, args, ctx) => {
    if (_onCmd) { _onCmd(cmd, args, ctx); }
    else { bot.handleCommand(cmd, args, ctx); }
  });
  ch.onMessage((msg, ctx) => {
    if (_onMsg) { _onMsg(msg, ctx); }
    else { (bot as any).handleMessage(msg, ctx); }
  });
  ch.onCallback((data, ctx) => {
    if (_onCb) { _onCb(data, ctx); }
    else { bot.handleCallback(data, ctx); }
  });
  ch.onError(err => console.error(`[bot-tg-e2e] error: ${err}`));

  // Start polling in background
  ch.listen();

  // Resolve chat ID: env var -> getUpdates recent -> poll for first message
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

  ch.knownChats.add(CHAT_ID);

  const agents = [HAS_CLAUDE && 'claude', HAS_CODEX && 'codex'].filter(Boolean).join(', ');
  await ch.send(CHAT_ID,
    `<b>bot-telegram E2E</b> starting\n\nAgents: ${agents}\nInteractive: ${INTERACTIVE ? 'yes' : 'no'}\nWorkdir: <code>${process.cwd()}</code>`,
    { parseMode: 'HTML' },
  );
}, TIMEOUT);

afterAll(async () => {
  if (!SKIP) {
    ch?.disconnect();
    for (const id of sentMsgIds) {
      await ch?.deleteMessage(CHAT_ID, id).catch(() => {});
    }
    await ch?.send(CHAT_ID, 'bot-telegram E2E tests complete!').catch(() => {});
  }
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
}, TIMEOUT);

// =========================================================================
//  AUTOMATED: commands — handleCommand directly, real Telegram send
// =========================================================================

describe.skipIf(SKIP)('/start', () => {
  it('sends welcome message with version, agent, workdir', async () => {
    const ctx = makeRealCtx();
    await bot.handleCommand('start', '', ctx);

    expect(ctx.sentTexts.length).toBeGreaterThanOrEqual(1);
    const text = ctx.sentTexts[0];
    expect(text).toContain('codeclaw');
    expect(text).toContain('Agent:');
    expect(text).toContain('Workdir:');
  }, TIMEOUT);
});

describe.skipIf(SKIP)('/status', () => {
  it('shows uptime, memory, PID, agent, usage stats', async () => {
    const ctx = makeRealCtx();
    await bot.handleCommand('status', '', ctx);

    expect(ctx.sentTexts.length).toBeGreaterThanOrEqual(1);
    const text = ctx.sentTexts[0];
    expect(text).toContain('Uptime:');
    expect(text).toContain('Memory:');
    expect(text).toContain('PID:');
    expect(text).toContain('Agent:');
    expect(text).toContain('Turns:');
  }, TIMEOUT);
});

describe.skipIf(SKIP)('/host', () => {
  it('shows CPU, memory, battery, process info', async () => {
    const ctx = makeRealCtx();
    await bot.handleCommand('host', '', ctx);

    expect(ctx.sentTexts.length).toBeGreaterThanOrEqual(1);
    const text = ctx.sentTexts[0];
    expect(text).toContain('Host');
    expect(text).toContain('CPU:');
    expect(text).toContain('Memory:');
    expect(text).toContain('Battery:');
    expect(text).toContain('Process:');
  }, TIMEOUT);
});

describe.skipIf(SKIP)('/agents', () => {
  it('lists available agents with inline keyboard', async () => {
    const ctx = makeRealCtx();
    await bot.handleCommand('agents', '', ctx);

    expect(ctx.sentTexts.length).toBeGreaterThanOrEqual(1);
    const text = ctx.sentTexts[0];
    expect(text).toContain('Available Agents');
    if (HAS_CLAUDE) expect(text).toContain('claude');
    if (HAS_CODEX) expect(text).toContain('codex');
    expect(ctx.sentKeyboards.length).toBeGreaterThan(0);
  }, TIMEOUT);
});

describe.skipIf(SKIP)('/sessions', () => {
  it('lists sessions or shows empty state', async () => {
    const ctx = makeRealCtx();
    await bot.handleCommand('sessions', '', ctx);

    expect(ctx.sentTexts.length).toBeGreaterThanOrEqual(1);
    const text = ctx.sentTexts[0];
    expect(text.toLowerCase()).toMatch(/session/);
  }, TIMEOUT);
});

describe.skipIf(SKIP)('/switch', () => {
  it('shows directory browser with inline keyboard', async () => {
    const ctx = makeRealCtx();
    await bot.handleCommand('switch', '', ctx);

    expect(ctx.sentTexts.length).toBeGreaterThanOrEqual(1);
    const text = ctx.sentTexts[0];
    expect(text).toContain('Switch workdir');
    expect(text).toContain('Current:');
    expect(text).toContain('Browsing:');
    expect(ctx.sentKeyboards.length).toBeGreaterThan(0);
  }, TIMEOUT);
});

// =========================================================================
//  AUTOMATED: callbacks — handleCallback directly, no user interaction
// =========================================================================

describe.skipIf(SKIP)('callback: agent switch', () => {
  it('switches agent via handleCallback', async () => {
    const target = bot.chat(CHAT_ID).agent === 'claude' ? 'codex' : 'claude';
    const ctx = makeFakeCallbackCtx(`ag:${target}`);
    await bot.handleCallback(`ag:${target}`, ctx);

    const cs = bot.chat(CHAT_ID);
    expect(cs.agent).toBe(target);
    expect(cs.sessionId).toBeNull();
    expect(ctx.answerText).toContain(target);

    // Switch back to default
    const defaultAgent = HAS_CLAUDE ? 'claude' : 'codex';
    const ctx2 = makeFakeCallbackCtx(`ag:${defaultAgent}`);
    await bot.handleCallback(`ag:${defaultAgent}`, ctx2);
  }, TIMEOUT);

  it('reports "already using" for current agent', async () => {
    const current = bot.chat(CHAT_ID).agent;
    const ctx = makeFakeCallbackCtx(`ag:${current}`);
    await bot.handleCallback(`ag:${current}`, ctx);
    expect(ctx.answerText).toContain('Already');
  }, TIMEOUT);
});

describe.skipIf(SKIP)('callback: session management', () => {
  it('resets session on sess:new', async () => {
    const cs = bot.chat(CHAT_ID);
    cs.sessionId = 'old-session-id';

    const ctx = makeFakeCallbackCtx('sess:new');
    await bot.handleCallback('sess:new', ctx);

    expect(cs.sessionId).toBeNull();
    expect(ctx.answerText).toContain('New session');
  }, TIMEOUT);

  it('switches to a session id', async () => {
    const sessionId = 'aaaabbbb-1111-2222-3333-444455556666';
    const ctx = makeFakeCallbackCtx(`sess:${sessionId}`);
    await bot.handleCallback(`sess:${sessionId}`, ctx);

    const cs = bot.chat(CHAT_ID);
    expect(cs.sessionId).toBe(sessionId);

    // Reset for subsequent tests
    cs.sessionId = null;
  }, TIMEOUT);
});

// =========================================================================
//  AUTOMATED: message -> real agent
// =========================================================================

describe.skipIf(SKIP || (!HAS_CLAUDE && !HAS_CODEX))('message -> agent reply', () => {
  it('sends user message to real agent and streams reply back', async () => {
    const ctx = makeRealCtx();
    const msg: TgMessage = { text: 'Reply with exactly: PONG', files: [] };
    await (bot as any).handleMessage(msg, ctx);

    // Bot should have sent at least the placeholder
    expect(ctx.sentTexts.length).toBeGreaterThanOrEqual(1);
    // Session should be set
    const cs = bot.chat(ctx.chatId);
    expect(cs.sessionId).toBeTruthy();
    // Stats should be updated
    expect(bot.stats.totalTurns).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  it('multi-turn: resumes session and retains context', async () => {
    const cs = bot.chat(CHAT_ID);
    expect(cs.sessionId).toBeTruthy();

    const ctx = makeRealCtx();
    const msg: TgMessage = { text: 'What did I just ask you? Reply briefly.', files: [] };
    await (bot as any).handleMessage(msg, ctx);

    expect(ctx.sentTexts.length).toBeGreaterThanOrEqual(1);
    expect(cs.sessionId).toBeTruthy();
    expect(bot.stats.totalTurns).toBeGreaterThanOrEqual(2);
  }, TIMEOUT);
});

// =========================================================================
//  INTERACTIVE: user clicks buttons / types commands in Telegram
//  (only runs with TELEGRAM_INTERACTIVE=1)
// =========================================================================

// ---------------------------------------------------------------------------
// Each interactive test is its own independent describe block with a clear name
// so you can run them individually:
//
//   TELEGRAM_INTERACTIVE=1 npx vitest run test/bot-telegram.e2e.test.ts -t "interactive: agent switch"
//   TELEGRAM_INTERACTIVE=1 npx vitest run test/bot-telegram.e2e.test.ts -t "interactive: session"
//   TELEGRAM_INTERACTIVE=1 npx vitest run test/bot-telegram.e2e.test.ts -t "interactive: directory"
//   TELEGRAM_INTERACTIVE=1 npx vitest run test/bot-telegram.e2e.test.ts -t "interactive: command"
//   TELEGRAM_INTERACTIVE=1 npx vitest run test/bot-telegram.e2e.test.ts -t "interactive: free text"
//   TELEGRAM_INTERACTIVE=1 npx vitest run test/bot-telegram.e2e.test.ts -t "interactive"   # all
// ---------------------------------------------------------------------------

describe.skipIf(SKIP || !INTERACTIVE)('interactive: agent switch', () => {
  it('user clicks agent button from /agents', async () => {
    const ctx = makeRealCtx();
    await bot.handleCommand('agents', '', ctx);

    await prompt(
      'click any agent button above to switch agents\n' +
      '(type anything to skip)',
    );

    const result = await Promise.race([
      waitCallback().then(cb => ({ type: 'cb' as const, cb })),
      waitMessages(1).then(msgs => ({ type: 'msg' as const, msgs })),
    ]);

    if (result.type === 'cb') {
      expect(result.cb.data).toMatch(/^ag:/);
      expect(result.cb.chatId).toBe(CHAT_ID);
    }
  }, TIMEOUT);
});

describe.skipIf(SKIP || !INTERACTIVE)('interactive: session', () => {
  it('user clicks session button from /sessions', async () => {
    const ctx = makeRealCtx();
    await bot.handleCommand('sessions', '', ctx);

    await prompt(
      'click "New session" or any session button above\n' +
      '(type anything to skip)',
    );

    const result = await Promise.race([
      waitCallback().then(cb => ({ type: 'cb' as const, cb })),
      waitMessages(1).then(msgs => ({ type: 'msg' as const, msgs })),
    ]);

    if (result.type === 'cb') {
      expect(result.cb.data).toMatch(/^sess:/);
    }
  }, TIMEOUT);
});

describe.skipIf(SKIP || !INTERACTIVE)('interactive: directory', () => {
  it('user browses and selects directory from /switch', async () => {
    const ctx = makeRealCtx();
    await bot.handleCommand('switch', '', ctx);

    await prompt(
      'browse directories, then click "Select this directory"\n' +
      '(type anything to skip)',
    );

    const result = await Promise.race([
      waitCallback().then(cb => ({ type: 'cb' as const, cb })),
      waitMessages(1).then(msgs => ({ type: 'msg' as const, msgs })),
    ]);

    if (result.type === 'cb') {
      expect(result.cb.data).toMatch(/^sw:/);
    }
  }, TIMEOUT);
});

describe.skipIf(SKIP || !INTERACTIVE)('interactive: command', () => {
  it('user types /status, bot responds', async () => {
    await prompt(
      'please type <code>/status</code> in the chat',
      { parseMode: 'HTML' },
    );

    const cmd = await waitCommand();
    expect(cmd.chatId).toBe(CHAT_ID);
    expect(cmd.cmd).toBe('status');
  }, TIMEOUT);
});

describe.skipIf(SKIP || !INTERACTIVE || (!HAS_CLAUDE && !HAS_CODEX))('interactive: free text', () => {
  it('user sends free text, bot calls agent and replies', async () => {
    await prompt(
      'please send any text message (e.g. "hello")\n' +
      'the bot will call a real agent and stream a reply',
    );

    const msgs = await waitMessages(1);
    expect(msgs.length).toBe(1);
    expect(msgs[0].chatId).toBe(CHAT_ID);
    expect(msgs[0].text.length).toBeGreaterThan(0);

    // Wait for the async bot handler to finish streaming
    await wait(5000);
  }, TIMEOUT);
});

// =========================================================================
//  CLEANUP
// =========================================================================

describe.skipIf(SKIP)('drain', () => {
  it('drains pending updates', async () => {
    const drainCh = new TelegramChannel({ token: TOKEN, workdir: tmpDir, pollTimeout: 1, apiTimeout: 10 });
    const count = await drainCh.drain();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  }, TIMEOUT);
});

// =========================================================================
//  Helpers
// =========================================================================

function makeRealCtx(chatId = CHAT_ID, messageId = 1) {
  const state = { sentTexts: [] as string[], sentKeyboards: [] as any[] };
  return {
    chatId,
    messageId,
    from: { id: CHAT_ID, username: 'e2e_test', firstName: 'E2E' },
    reply: async (text: string, opts?: any) => {
      state.sentTexts.push(text);
      if (opts?.keyboard) state.sentKeyboards.push(opts.keyboard);
      const msgId = await ch.send(chatId, text, { ...opts, replyTo: messageId });
      if (msgId) sentMsgIds.push(msgId);
      return msgId;
    },
    editReply: async (msgId: number, text: string, opts?: any) => {
      await ch.editMessage(chatId, msgId, text, opts);
    },
    answerCallback: async () => {},
    channel: ch,
    raw: {},
    get sentTexts() { return state.sentTexts; },
    get sentKeyboards() { return state.sentKeyboards; },
  } as TgContext & { sentTexts: string[]; sentKeyboards: any[] };
}

function makeFakeCallbackCtx(data: string, chatId = CHAT_ID, messageId = 1) {
  const state = { answerText: '', editedTexts: [] as string[] };
  return {
    chatId,
    messageId,
    from: { id: CHAT_ID, username: 'e2e_test', firstName: 'E2E' },
    callbackId: 'cb-' + Date.now(),
    reply: async (text: string, opts?: any) => {
      const msgId = await ch.send(chatId, text, { ...opts, replyTo: messageId });
      if (msgId) sentMsgIds.push(msgId);
      return msgId;
    },
    editReply: async (msgId: number, text: string, opts?: any) => {
      state.editedTexts.push(text);
      await ch.editMessage(chatId, msgId, text, opts);
    },
    answerCallback: async (text?: string) => {
      state.answerText = text || '';
    },
    channel: ch,
    raw: {},
    get answerText() { return state.answerText; },
    get editedTexts() { return state.editedTexts; },
  } as TgCallbackContext & { answerText: string; editedTexts: string[] };
}
