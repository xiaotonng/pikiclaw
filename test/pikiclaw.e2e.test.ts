/**
 * E2E tests for pikiclaw.ts command logic — no mocks.
 *
 * Retained commands (per design):
 *   /start     — Telegram 入口，精简帮助
 *   /sessions  — getSessions 透传 + inline keyboard 切换/新建
 *   /status    — 项目状态
 *   /switch    — 目录浏览切换
 *   /host      — 宿主机信息
 *   /agents    — 列出/切换 agent (ag: callback 切换)
 *
 * Creates a real PikiClaw instance and invokes command handlers directly
 * with capturing TgContext objects. All underlying logic (getSessions,
 * listAgents, fs, os, etc.) runs for real — zero mocks.
 *
 * Requires env:
 *   TELEGRAM_BOT_TOKEN (or PIKICLAW_TOKEN)
 *
 * Run:
 *   TELEGRAM_BOT_TOKEN=xxx npx vitest run test/pikiclaw.e2e.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TgContext, TgCallbackContext } from '../src/channel-telegram.ts';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.PIKICLAW_TOKEN || '';
const SKIP = !TOKEN;

if (SKIP) {
  console.warn(
    '\n  TELEGRAM_BOT_TOKEN not set — pikiclaw command E2E tests will be SKIPPED.\n' +
    '   To run: TELEGRAM_BOT_TOKEN=xxx npx vitest run test/pikiclaw.e2e.test.ts\n',
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
// Shared PikiClaw instance
// ---------------------------------------------------------------------------

let claw: any;
let tmpWorkdir: string;

beforeAll(async () => {
  if (SKIP) return;
  tmpWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-cmd-e2e-'));
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.PIKICLAW_WORKDIR = tmpWorkdir;
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
    expect(text).toContain('pikiclaw');
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

  it('no-sessions case shows the latest empty-state copy', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('sessions', '', ctx);
    const text = replies[0].text;
    expect(text).toContain('No sessions found.');
    expect(text).toContain('Use the controls below to switch or start a new session.');
  });

  it('includes the "New session" button', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('sessions', '', ctx);
    const kb = replies[0].opts?.keyboard;
    expect(kb).toBeTruthy();
    const allBtns = kb.inline_keyboard.flat();
    expect(allBtns.find((b: any) => b.callback_data === 'sess:new')).toBeTruthy();
  });

  // --- sess: callback (inline keyboard 切换/新建) ---

  it('sess:new resets sessionId', async () => {
    const state = claw.chat(500);
    state.sessionId = 'existing-session';

    const { ctx, edits, callbacks } = createCallbackCtx(500, 2000);
    await claw.handleCallback('sess:new', ctx);

    expect(state.sessionId).toBeNull();
    expect(callbacks[0]).toContain('New session');
    expect(edits[0].text).toContain('<b>New Session</b>');
    expect(edits[0].text).toContain('Send a message to start.');
  });
});

// =========================================================================
//  /status — 项目状态
// =========================================================================

describe.skipIf(SKIP)('/status', () => {
  it('shows version, uptime, agent, workdir, memory, PID', async () => {
    const chatId = 1200;
    const state = claw.chat(chatId);
    const { ctx, replies } = createCaptureCtx(chatId);
    await claw.handleCommand('status', '', ctx);

    expect(replies.length).toBe(1);
    const text = replies[0].text;
    expect(text).toContain('pikiclaw');
    expect(text).toContain('Uptime');
    expect(text).toContain('Memory');
    expect(text).toContain('PID');
    expect(text).toContain(String(process.pid));
    expect(text).toContain('Workdir');
    expect(text).toContain('Agent');
    expect(text).toContain(state.agent);
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
    expect(text).toContain('<b>Workdir</b>');
    expect(text).toContain(path.basename(claw.workdir).slice(-12));
    expect(replies[0].opts?.parseMode).toBe('HTML');
  });

  it('keyboard has directory buttons and the latest "Use This" action', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('switch', '', ctx);

    const kb = replies[0].opts?.keyboard;
    expect(kb).toBeTruthy();
    expect(kb.inline_keyboard.length).toBeGreaterThan(0);

    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    const selectBtn = lastRow.find((b: any) => b.callback_data?.startsWith('sw:s:'));
    expect(selectBtn).toBeTruthy();
    expect(selectBtn.text).toBe('Use This');
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
    expect(edits[0].text).toContain('<b>Workdir</b>');
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
    expect(callbacks[0]).toContain('Switched!');
    expect(edits[0].text).toContain('<b>Workdir</b>');
    expect(edits[0].text).toContain('→');

    // restore
    claw.workdir = origWorkdir;
  });
});

// =========================================================================
//  /host — 宿主机信息
// =========================================================================

describe.skipIf(SKIP)('/host', () => {
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
  it('lists installed agents with the latest heading', async () => {
    const { ctx, replies } = createCaptureCtx();
    await claw.handleCommand('agents', '', ctx);

    expect(replies.length).toBe(1);
    const text = replies[0].text;
    expect(text).toContain('<b>Agents</b>');
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

  it('marks the current agent with the selected-state symbol', async () => {
    const chatId = 1300;
    const state = claw.chat(chatId);
    const { ctx, replies } = createCaptureCtx(chatId);
    await claw.handleCommand('agents', '', ctx);
    expect(replies[0].text).toMatch(new RegExp(`● <b>\\d+\\.<\\/b> ${state.agent}`));
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
