/**
 * E2E tests for /switch (workdir switching) — verifies the agent truly
 * operates inside the switched directory by toggling between two real
 * subdirectories of this project: src/ and test/.
 *
 * No mocking — real agent calls, real filesystem.
 *
 * Requires `claude` or `codex` CLI installed and authenticated.
 *
 * Run:  npx vitest run test/switch-workdir.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { doStream, type StreamOpts } from '../../src/code-agent.ts';
import { Bot } from '../../src/bot.ts';
import { execSync } from 'node:child_process';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TIMEOUT = 180_000;
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

const DIR_SRC = path.join(PROJECT_ROOT, 'src');

/** Files we know exist in src/ */
const SRC_FILES = ['code-agent.ts', 'bot.ts', 'cli.ts'];

function hasCmd(cmd: string): boolean {
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_CLAUDE = hasCmd('claude');
const HAS_CODEX = hasCmd('codex');
const SKIP = !HAS_CLAUDE && !HAS_CODEX;

if (SKIP) {
  console.warn(
    '\n  Neither claude nor codex is installed — switch-workdir E2E tests will be SKIPPED.\n',
  );
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let bot: Bot;

function baseOpts(overrides: Partial<StreamOpts> = {}): StreamOpts {
  return {
    agent: HAS_CLAUDE ? 'claude' : 'codex',
    prompt: '',
    workdir: bot.workdir,
    timeout: 120,
    sessionId: null,
    model: null,
    thinkingEffort: 'low',
    onText: () => {},
    codexFullAccess: true,
    claudePermissionMode: 'bypassPermissions',
    ...overrides,
  };
}

const LIST_PROMPT = [
  'List ALL file names in the current working directory (non-recursively).',
  'Reply with ONLY the file names, one per line, nothing else.',
].join('\n');

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (SKIP) return;
  bot = new Bot();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('switch workdir e2e', () => {

  it('switchWorkdir updates bot.workdir and resets all sessions', () => {
    const chatId = 1;
    const cs = bot.chat(chatId);
    cs.sessionId = 'old-session-id';

    const old = bot.switchWorkdir(DIR_SRC);
    expect(bot.workdir).toBe(DIR_SRC);
    expect(cs.sessionId).toBeNull();

    bot.switchWorkdir(old);
  });

  it('agent lists src/ files after switching workdir to src/', async () => {
    bot.switchWorkdir(DIR_SRC);
    expect(bot.workdir).toBe(DIR_SRC);

    const result = await doStream(baseOpts({
      workdir: bot.workdir,
      prompt: LIST_PROMPT,
    }));

    expect(result.ok).toBe(true);
    const reply = result.message.toLowerCase();

    for (const f of SRC_FILES) {
      expect(reply).toContain(f);
    }
  }, TIMEOUT);

  it('runStream also respects switched workdir', async () => {
    bot.switchWorkdir(DIR_SRC);
    const cs = bot.chat(99);

    const result = await bot.runStream(LIST_PROMPT, cs, [], () => {});

    expect(result.ok).toBe(true);
    const reply = result.message.toLowerCase();
    for (const f of SRC_FILES) {
      expect(reply).toContain(f);
    }
  }, TIMEOUT);
});

afterAll(() => {
  if (bot) bot.switchWorkdir(PROJECT_ROOT);
});
