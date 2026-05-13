/**
 * Tests the native /goal bridge for the claude driver: reading goal_status
 * attachments out of a session transcript JSONL exactly as Claude Code v2.x
 * writes them, and the helpers that build the slash-command prompts pikiclaw
 * sends through the task queue.
 *
 * Fixture transcripts mirror the on-disk shape from a real claude -p run:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * The encoded-cwd convention (every non-alphanumeric → "-") is shared with the
 * rest of the claude driver (see core/platform.ts:encodePathAsDirName), so we
 * exercise that path by pointing HOME at a tmp dir and using its real workdir.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getClaudeNativeGoal,
  buildClaudeSetGoalPrompt,
  buildClaudeClearGoalPrompt,
} from '../src/agent/drivers/claude.ts';
import { encodePathAsDirName } from '../src/core/platform.ts';
import { makeTmpDir, captureEnv, restoreEnv } from './support/env.ts';

const HOME_KEYS = ['HOME', 'USERPROFILE'] as const;

let tmpHome: string;
let tmpWorkdir: string;
let envSnap: ReturnType<typeof captureEnv>;

const SID = 'deadbeef-1111-2222-3333-444455556666';

function transcriptPath(): string {
  return path.join(tmpHome, '.claude', 'projects', encodePathAsDirName(tmpWorkdir), `${SID}.jsonl`);
}

function writeTranscript(lines: string[]): void {
  const file = transcriptPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

beforeEach(() => {
  envSnap = captureEnv(HOME_KEYS);
  tmpHome = makeTmpDir('pikiclaw-claude-goal-home-');
  tmpWorkdir = makeTmpDir('pikiclaw-claude-goal-wd-');
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  restoreEnv(envSnap);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpWorkdir, { recursive: true, force: true }); } catch {}
});

describe('getClaudeNativeGoal', () => {
  it('returns null when no transcript exists', () => {
    expect(getClaudeNativeGoal(tmpWorkdir, SID)).toBeNull();
  });

  it('returns null when transcript has no goal_status attachment', () => {
    writeTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
    ]);
    expect(getClaudeNativeGoal(tmpWorkdir, SID)).toBeNull();
  });

  it('parses the latest goal_status attachment as an active goal when met:false', () => {
    writeTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: '/goal x' } }),
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-05-13T00:15:01.374Z',
        attachment: { type: 'goal_status', met: false, sentinel: true, condition: 'create file done.txt' },
      }),
    ]);
    const goal = getClaudeNativeGoal(tmpWorkdir, SID);
    expect(goal).not.toBeNull();
    expect(goal!.condition).toBe('create file done.txt');
    expect(goal!.met).toBe(false);
    expect(goal!.status).toBe('active');
    expect(goal!.updatedAtMs).toBe(Date.parse('2026-05-13T00:15:01.374Z'));
  });

  it('returns null after auto-clear (latest goal_status has met:true)', () => {
    // Claude's Stop hook emits a follow-up goal_status with met:true when the
    // Haiku judge confirms the condition is satisfied. The bridge surfaces
    // that as "no active goal" so the API matches codex's clear semantics.
    writeTranscript([
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-05-13T00:15:01.000Z',
        attachment: { type: 'goal_status', met: false, sentinel: true, condition: 'foo' },
      }),
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-05-13T00:16:01.000Z',
        attachment: { type: 'goal_status', met: true, sentinel: true, condition: 'foo' },
      }),
    ]);
    expect(getClaudeNativeGoal(tmpWorkdir, SID)).toBeNull();
  });

  it('latest entry wins when multiple active goal_status lines are present (e.g. user re-set goal)', () => {
    writeTranscript([
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-05-13T00:15:01.000Z',
        attachment: { type: 'goal_status', met: false, sentinel: true, condition: 'first goal' },
      }),
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-05-13T00:20:00.000Z',
        attachment: { type: 'goal_status', met: false, sentinel: true, condition: 'second goal' },
      }),
    ]);
    const goal = getClaudeNativeGoal(tmpWorkdir, SID);
    expect(goal?.condition).toBe('second goal');
  });

  it('ignores malformed JSON lines and unrelated attachments', () => {
    writeTranscript([
      'not even json',
      '{ broken',
      JSON.stringify({ type: 'attachment', attachment: { type: 'budget_usd', used: 0.01 } }),
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-05-13T00:15:01.000Z',
        attachment: { type: 'goal_status', met: false, sentinel: true, condition: 'survived' },
      }),
    ]);
    const goal = getClaudeNativeGoal(tmpWorkdir, SID);
    expect(goal?.condition).toBe('survived');
  });

  it('returns null on empty / blank session id', () => {
    expect(getClaudeNativeGoal(tmpWorkdir, '')).toBeNull();
  });
});

describe('slash-command prompt builders', () => {
  it('buildClaudeSetGoalPrompt prepends /goal and trims', () => {
    expect(buildClaudeSetGoalPrompt('  fix the auth bug ')).toBe('/goal fix the auth bug');
  });

  it('buildClaudeClearGoalPrompt is the canonical /goal clear', () => {
    expect(buildClaudeClearGoalPrompt()).toBe('/goal clear');
  });
});
