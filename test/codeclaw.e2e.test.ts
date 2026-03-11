/**
 * E2E tests for codeclaw.ts command logic — no mocks.
 *
 * Retained commands (per design):
 *   /start     — Telegram 入口，精简帮助
 *   /sessions  — getSessions 透传 + inline keyboard 切换/新建
 *   /status    — 项目状态
 *   /switch    — 目录浏览切换
 *   /host      — 宿主机信息
 *   /agents    — 列出/切换 agent (ag: callback 切换)
 *
 * Creates a real CodeClaw instance and invokes command handlers directly
 * with capturing TgContext objects. All underlying logic (getSessions,
 * listAgents, fs, os, etc.) runs for real — zero mocks.
 *
 * Requires env:
 *   TELEGRAM_BOT_TOKEN (or CODECLAW_TOKEN)
 *
 * Run:
 *   TELEGRAM_BOT_TOKEN=xxx npx vitest run test/codeclaw.e2e.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TgContext, TgCallbackContext } from '../src/channel-telegram.ts';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.CODECLAW_TOKEN || '';
const SKIP = !TOKEN;

if (SKIP) {
  console.warn(
    '\n  TELEGRAM_BOT_TOKEN not set — codeclaw command E2E tests will be SKIPPED.\n' +
    '   To run: TELEGRAM_BOT_TOKEN=xxx npx vitest run test/codeclaw.e2e.test.ts\n',
  );
}

// ---------------------------------------------------------------------------
// Capture context — real TgContext implementation that records calls
// ---------------------------------------------------------------------------

interface CapturedReply { text: string; opts?: any; msgId: number }
interface CapturedEdit  { msgId: number; text: string; opts?: any }

function createCaptureCtx(chatId = 100, messageId = 1) {
  const replies: CapturedReply[] = [];
  const edits: CapturedEdit[] = [];
  const callbacks: string[] = [];
  let nextMsgId = 1000;

  const ctx: TgContext = {
    chatId, messageId,
    from: { id: 42, username: 'testuser', firstName: 'Test' },
    reply: async (text: string, opts?: any): Promise<number> => {
      const msgId = nextMsgId++;
      replies.push({ text, opts, msgId });
      return msgId;
    },
    editReply: async (msgId: number, text: string, opts?: any): Promise<void> => {
      edits.push({ msgId, text, opts });
    },
    answerCallback: async (_text?: string): Promise<void> => {
      callbacks.push(_text ?? '');
    },
    channel: null as any,
    raw: {},
  };
  return { ctx, replies, edits, callbacks };
}

function createCallbackCtx(chatId = 100, messageId = 1) {
  const base = createCaptureCtx(chatId, messageId);
  const ctx = { ...base.ctx, callbackId: 'cb-test-001' } as TgCallbackContext;
  return { ctx, replies: base.replies, edits: base.edits, callbacks: base.callbacks };
}

// ---------------------------------------------------------------------------
// Shared CodeClaw instance
// ---------------------------------------------------------------------------

let claw: any;
let tmpWorkdir: string;

beforeAll(async () => {
  if (SKIP) return;
  tmpWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeclaw-cmd-e2e-'));
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.CODECLAW_WORKDIR = tmpWorkdir;
  process.env.DEFAULT_AGENT = 'claude';
  const { TelegramBot } = await import('../src/bot-telegram.ts');
  claw = new TelegramBot();
});

// =========================================================================
//  /start (Telegram 规范入口)
// =========================================================================

describe.skipIf(SKIP)('/start', () => {
  it('returns help text with version and the 5 retained commands', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('start', '', ctx);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    const text = replies[0].text;
    expect(text).toContain('codeclaw');
    expect(text).toContain('/sessions');
    expect(text).toContain('/status');
    expect(text).toContain('/switch');
    expect(text).toContain('/host');
    expect(text).toContain('/agents');
    expect(replies[0].opts?.parseMode).toBe('HTML');
  });

  it('shows current agent and workdir', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('start', '', ctx);
    const text = replies[0].text;
    expect(text).toContain('claude');
    expect(text).toContain(claw.workdir);
  });
});

// =========================================================================
//  /sessions — getSessions 透传 + inline keyboard 切换/新建
// =========================================================================

describe.skipIf(SKIP)('/sessions', () => {
  it('returns sessions list or "no sessions" message', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('sessions', '', ctx);

    expect(replies.length).toBe(1);
    const text = replies[0].text;
    expect(text.toLowerCase()).toContain('session');
    expect(replies[0].opts?.parseMode).toBe('HTML');
  });

  it('no-sessions case shows workdir in message', async () => {
    // tmpWorkdir is empty, so should have no sessions
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('sessions', '', ctx);
    const text = replies[0].text;
    if (text.includes('No ')) {
      expect(text).toContain(tmpWorkdir);
    }
  });

  it('includes "New session" button when sessions exist', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('sessions', '', ctx);
    const text = replies[0].text;
    if (!text.includes('No ')) {
      const kb = replies[0].opts?.keyboard;
      expect(kb).toBeTruthy();
      const allBtns = kb.inline_keyboard.flat();
      expect(allBtns.find((b: any) => b.callback_data === 'sess:new')).toBeTruthy();
    }
  });

  // --- sess: callback (inline keyboard 切换/新建) ---

  it('sess:new resets sessionId', async () => {
    const state = claw.chat(500);
    state.sessionId = 'existing-session';

    const { ctx, edits, callbacks } = createCallbackCtx(500, 2000);
    await claw.handleCallback('sess:new', ctx);

    expect(state.sessionId).toBeNull();
    expect(callbacks[0]).toContain('New session');
    expect(edits[0].text).toContain('Session reset');
  });

  it('sess:<id> switches to that session', async () => {
    const { ctx, edits, callbacks } = createCallbackCtx(600, 2001);
    await claw.handleCallback('sess:abc123def456', ctx);

    expect(claw.chat(600).sessionId).toBe('abc123def456');
    expect(callbacks[0]).toContain('abc123def456'.slice(0, 12));
    expect(edits.length).toBe(1);
  });
});

// =========================================================================
//  /status — 项目状态
// =========================================================================

describe.skipIf(SKIP)('/status', () => {
  it('shows version, uptime, agent, workdir, memory, PID', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('status', '', ctx);

    expect(replies.length).toBe(1);
    const text = replies[0].text;
    expect(text).toContain('codeclaw');
    expect(text).toContain('Uptime');
    expect(text).toContain('Memory');
    expect(text).toContain('PID');
    expect(text).toContain(String(process.pid));
    expect(text).toContain('Workdir');
    expect(text).toContain('Agent');
    expect(text).toContain('claude');
    expect(replies[0].opts?.parseMode).toBe('HTML');
  });

  it('contains usage stats (Turns)', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('status', '', ctx);
    expect(replies[0].text).toContain('Turns');
  });

  it('shows current session info', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('status', '', ctx);
    expect(replies[0].text).toContain('Session');
  });
});

// =========================================================================
//  /switch — 目录浏览切换
// =========================================================================

describe.skipIf(SKIP)('/switch', () => {
  it('shows directory browser with current workdir', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('switch', '', ctx);

    expect(replies.length).toBe(1);
    const text = replies[0].text;
    expect(text).toContain('Switch workdir');
    expect(text).toContain(claw.workdir);
    expect(replies[0].opts?.parseMode).toBe('HTML');
  });

  it('keyboard has directory buttons and "Select this directory"', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('switch', '', ctx);

    const kb = replies[0].opts?.keyboard;
    expect(kb).toBeTruthy();
    expect(kb.inline_keyboard.length).toBeGreaterThan(0);

    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    const selectBtn = lastRow.find((b: any) => b.callback_data?.startsWith('sw:s:'));
    expect(selectBtn).toBeTruthy();
    expect(selectBtn.text).toContain('Select');
  });

  it('directory buttons correspond to real filesystem subdirs', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('switch', '', ctx);

    const parentDir = path.dirname(claw.workdir);
    const realSubdirs = fs.readdirSync(parentDir)
      .filter((name: string) => {
        if (name.startsWith('.')) return false;
        try { return fs.statSync(path.join(parentDir, name)).isDirectory(); } catch { return false; }
      });

    const kb = replies[0].opts?.keyboard;
    const navBtns = kb.inline_keyboard.flat().filter((b: any) => b.callback_data?.startsWith('sw:n:'));
    if (realSubdirs.length > 0) {
      expect(navBtns.length).toBeGreaterThan(0);
    }
  });

  // --- sw: callbacks (navigate / select) ---

  it('sw:n: navigates and shows updated keyboard', async () => {
    const { ctx: switchCtx, replies } = createCaptureCtx(900);
    await claw.handleCommand('switch', '', switchCtx);

    const navBtn = replies[0].opts?.keyboard.inline_keyboard.flat()
      .find((b: any) => b.callback_data?.startsWith('sw:n:'));
    if (!navBtn) return; // no subdirs to navigate

    const { ctx: cbCtx, edits, callbacks } = createCallbackCtx(900, replies[0].msgId);
    await claw.handleCallback(navBtn.callback_data, cbCtx);

    expect(edits.length).toBe(1);
    expect(edits[0].text).toContain('Switch workdir');
    expect(callbacks.length).toBe(1);
  });

  it('sw:s: selects directory and updates workdir', async () => {
    const origWorkdir = claw.workdir;

    const { ctx: switchCtx, replies } = createCaptureCtx(1000);
    await claw.handleCommand('switch', '', switchCtx);

    const selectBtn = replies[0].opts?.keyboard.inline_keyboard.flat()
      .find((b: any) => b.callback_data?.startsWith('sw:s:'));
    if (!selectBtn) return;

    const { ctx: cbCtx, edits, callbacks } = createCallbackCtx(1000, replies[0].msgId);
    await claw.handleCallback(selectBtn.callback_data, cbCtx);

    expect(callbacks.length).toBe(1);
    expect(edits.length).toBe(1);
    expect(edits[0].text).toContain('Workdir switched');

    // restore
    claw.workdir = origWorkdir;
  });
});

// =========================================================================
//  /host — 宿主机信息
// =========================================================================

describe.skipIf(SKIP)('/host', () => {
  it('shows real host info: hostname, OS, CPU, memory, node version', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('host', '', ctx);

    expect(replies.length).toBe(1);
    const text = replies[0].text;
    expect(text).toContain('Hostname');
    expect(text).toContain(os.hostname());
    expect(text).toContain('OS');
    expect(text).toContain('CPU');
    expect(text).toContain('Memory');
    expect(text).toContain('Load');
    expect(text).toContain('Uptime');
    expect(text).toContain('Node');
    expect(text).toContain(process.version);
    expect(text).toContain('Home');
    expect(text).toContain(os.homedir());
    expect(replies[0].opts?.parseMode).toBe('HTML');
  });

  it('includes disk info on macOS/Linux', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('host', '', ctx);
    expect(replies[0].text).toContain('Disk');
  });
});

// =========================================================================
//  /agents — 列出/切换 agent
// =========================================================================

describe.skipIf(SKIP)('/agents', () => {
  it('lists claude and codex with install status', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('agents', '', ctx);

    expect(replies.length).toBe(1);
    const text = replies[0].text;
    expect(text).toContain('Available Agents');
    expect(text).toContain('claude');
    expect(text).toContain('codex');
    expect(replies[0].opts?.parseMode).toBe('HTML');
  });

  it('inline keyboard has ag: buttons for installed agents', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('agents', '', ctx);

    const kb = replies[0].opts?.keyboard;
    expect(kb).toBeTruthy();
    const agBtns = kb.inline_keyboard.flat().filter((b: any) => b.callback_data?.startsWith('ag:'));
    expect(agBtns.length).toBeGreaterThan(0);
  });

  it('marks current agent as (current)', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('agents', '', ctx);
    expect(replies[0].text).toContain('(current)');
  });

  // --- ag: callback (切换 agent) ---

  it('ag: switches agent and resets session', async () => {
    const state = claw.chat(700);
    state.agent = 'claude';
    state.sessionId = 'some-session';

    const { ctx, edits, callbacks } = createCallbackCtx(700, 3000);
    await claw.handleCallback('ag:codex', ctx);

    expect(state.agent).toBe('codex');
    expect(state.sessionId).toBeNull();
    expect(callbacks[0]).toContain('codex');
    expect(edits[0].text).toContain('codex');
  });

  it('ag: same agent shows "Already using"', async () => {
    claw.chat(800).agent = 'claude';

    const { ctx, callbacks, edits } = createCallbackCtx(800, 3001);
    await claw.handleCallback('ag:claude', ctx);

    expect(callbacks[0]).toContain('Already');
    expect(edits.length).toBe(0);
  });
});
