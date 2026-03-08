/**
 * E2E tests for code-agent.ts — hits real codex/claude CLIs.
 *
 * Requires `codex` and/or `claude` to be installed and authenticated.
 * These tests make real API calls and cost tokens.
 *
 * Run all:        npx vitest run test/code-agent.e2e.test.ts
 * By category:
 *   basic:        npx vitest run test/code-agent.e2e.test.ts -t "codex e2e|claude e2e|doStream e2e"
 *   attachments:  npx vitest run test/code-agent.e2e.test.ts -t "attachments"
 *   browser:      npx vitest run test/code-agent.e2e.test.ts -t "browser"
 */
import { describe, it, expect } from 'vitest';
import { doStream, doCodexStream, doClaudeStream, type StreamOpts } from '../../src/code-agent.ts';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function hasCmd(cmd: string): boolean {
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

const HAS_CODEX = hasCmd('codex');
const HAS_CLAUDE = hasCmd('claude');

function baseOpts(agent: 'codex' | 'claude', extra: Partial<StreamOpts> = {}): StreamOpts {
  return {
    agent,
    prompt: 'Reply with exactly: PONG',
    workdir: process.cwd(),
    timeout: 120,
    sessionId: null,
    model: null,
    thinkingEffort: 'low',
    onText: () => {},
    codexFullAccess: true,
    claudePermissionMode: 'bypassPermissions',
    ...extra,
  };
}

// --- codex e2e ---

describe.skipIf(!HAS_CODEX)('codex e2e', () => {
  it('single turn', async () => {
    const result = await doCodexStream(baseOpts('codex'));
    expect(result.ok).toBe(true);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.sessionId).toBeTruthy();
    expect(result.elapsedS).toBeGreaterThan(0);
  }, 120_000);

  it('multi-turn (resume session)', async () => {
    const r1 = await doCodexStream(baseOpts('codex', { prompt: 'Remember the word: BANANA' }));
    expect(r1.ok).toBe(true);
    expect(r1.sessionId).toBeTruthy();

    const r2 = await doCodexStream(baseOpts('codex', {
      prompt: 'What word did I ask you to remember? Reply with just the word.',
      sessionId: r1.sessionId,
    }));
    expect(r2.ok).toBe(true);
    expect(r2.message.toUpperCase()).toContain('BANANA');
  }, 120_000);
});

// --- claude e2e ---

describe.skipIf(!HAS_CLAUDE)('claude e2e', () => {
  it('single turn', async () => {
    const result = await doClaudeStream(baseOpts('claude'));
    expect(result.ok).toBe(true);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.sessionId).toBeTruthy();
    expect(result.elapsedS).toBeGreaterThan(0);
  }, 120_000);

  it('multi-turn (resume session)', async () => {
    const r1 = await doClaudeStream(baseOpts('claude', { prompt: 'Remember the word: MANGO' }));
    expect(r1.ok).toBe(true);
    expect(r1.sessionId).toBeTruthy();

    const r2 = await doClaudeStream(baseOpts('claude', {
      prompt: 'What word did I ask you to remember? Reply with just the word.',
      sessionId: r1.sessionId,
    }));
    expect(r2.ok).toBe(true);
    expect(r2.message.toUpperCase()).toContain('MANGO');
  }, 120_000);

  it('expired session auto-retries as new conversation', async () => {
    const result = await doClaudeStream(baseOpts('claude', {
      sessionId: '00000000-0000-0000-0000-000000000000',
      prompt: 'Reply with exactly: RECOVERED',
    }));
    // Should have retried as new conversation
    expect(result.ok).toBe(true);
    expect(result.message.length).toBeGreaterThan(0);
    // sessionId should be a new one, not the fake one
    expect(result.sessionId).not.toBe('00000000-0000-0000-0000-000000000000');
  }, 120_000);
});

// --- doStream routing e2e ---

describe.skipIf(!HAS_CODEX && !HAS_CLAUDE)('doStream e2e', () => {
  it.skipIf(!HAS_CLAUDE)('routes claude', async () => {
    const result = await doStream(baseOpts('claude'));
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeTruthy();
  }, 120_000);

  it.skipIf(!HAS_CODEX)('routes codex', async () => {
    const result = await doStream(baseOpts('codex'));
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeTruthy();
  }, 120_000);
});

// --- advanced: attachments (image recognition & file summary) ---

/** Minimal 2x2 red PNG (raw bytes) */
function writeRedPng(filePath: string) {
  // 2x2 solid red (#FF0000) PNG
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg==';
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
}

describe.skipIf(!HAS_CLAUDE && !HAS_CODEX)('advanced: attachments', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeclaw-attach-'));

  it.skipIf(!HAS_CLAUDE)('claude recognizes image content', async () => {
    const imgPath = path.join(tmpDir, 'red.png');
    writeRedPng(imgPath);
    const result = await doClaudeStream(baseOpts('claude', {
      prompt: 'What color is this image? Reply with just the color name in English, nothing else.',
      attachments: [imgPath],
      timeout: 120,
    }));
    expect(result.ok).toBe(true);
    expect(result.message.toLowerCase()).toContain('red');
  }, 120_000);

  it.skipIf(!HAS_CODEX)('codex recognizes image content', async () => {
    const imgPath = path.join(tmpDir, 'red.png');
    writeRedPng(imgPath);
    const result = await doCodexStream(baseOpts('codex', {
      prompt: 'What color is this image? Reply with just the color name in English, nothing else.',
      attachments: [imgPath],
      timeout: 120,
    }));
    expect(result.ok).toBe(true);
    expect(result.message.toLowerCase()).toContain('red');
  }, 120_000);

  it.skipIf(!HAS_CLAUDE)('claude summarizes a text file', async () => {
    const txtPath = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(txtPath, 'The quick brown fox jumps over the lazy dog. This sentence contains every letter of the English alphabet and is known as a pangram.');
    const result = await doClaudeStream(baseOpts('claude', {
      prompt: 'Summarize the attached file in one sentence. Include the word "pangram" in your reply.',
      attachments: [txtPath],
      timeout: 120,
    }));
    expect(result.ok).toBe(true);
    expect(result.message.toLowerCase()).toContain('pangram');
  }, 120_000);

  it.skipIf(!HAS_CODEX)('codex summarizes a text file', async () => {
    const txtPath = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(txtPath, 'The quick brown fox jumps over the lazy dog. This sentence contains every letter of the English alphabet and is known as a pangram.');
    const result = await doCodexStream(baseOpts('codex', {
      prompt: 'Summarize the attached file in one sentence. Include the word "pangram" in your reply.',
      attachments: [txtPath],
      timeout: 120,
    }));
    expect(result.ok).toBe(true);
    expect(result.message.toLowerCase()).toContain('pangram');
  }, 120_000);
});

// --- advanced: browser automation (screenshot via JS) ---

const SCREENSHOT_PROMPT = (outPath: string) => [
  `Open my default Chrome browser (not headless, not puppeteer) to do the following:`,
  `1. Use "open" command (macOS) or equivalent to open https://example.com in Chrome`,
  `2. Wait 3 seconds for the page to load`,
  `3. Use AppleScript (osascript) to execute this JS in the Chrome tab: document.title = "CODECLAW_TEST_" + Date.now()`,
  `4. Use screencapture command to take a screenshot and save it to: ${outPath}`,
  `After you are done, reply with the exact string: SCREENSHOT_DONE`,
].join('\n');

describe.skipIf(!HAS_CLAUDE && !HAS_CODEX)('advanced: browser screenshot', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeclaw-browser-'));

  it.skipIf(!HAS_CLAUDE)('claude can open browser, run JS, and screenshot', async () => {
    const outPath = path.join(tmpDir, 'claude-screenshot.png');
    const result = await doClaudeStream(baseOpts('claude', {
      prompt: SCREENSHOT_PROMPT(outPath),
      workdir: tmpDir,
      timeout: 180,
      thinkingEffort: 'high',
    }));
    expect(result.ok).toBe(true);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.statSync(outPath).size).toBeGreaterThan(1000);
  }, 180_000);

  it.skipIf(!HAS_CODEX)('codex can open browser, run JS, and screenshot', async () => {
    const outPath = path.join(tmpDir, 'codex-screenshot.png');
    const result = await doCodexStream(baseOpts('codex', {
      prompt: SCREENSHOT_PROMPT(outPath),
      workdir: tmpDir,
      timeout: 180,
      thinkingEffort: 'high',
    }));
    expect(result.ok).toBe(true);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.statSync(outPath).size).toBeGreaterThan(1000);
  }, 180_000);
});
