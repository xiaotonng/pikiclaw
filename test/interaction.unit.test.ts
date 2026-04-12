/**
 * Tests for the unified human-in-the-loop interaction flow.
 *
 * Covers:
 *   1. AgentInteraction creation from Codex driver format
 *   2. Bot.createInteractionHandler wiring (IM + Dashboard paths)
 *   3. SSE event emission (interaction / interaction-resolved)
 *   4. Public interaction API on Bot (select, text, skip, cancel)
 *   5. Dashboard submitSessionTask auto-wiring
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent/index.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/agent/index.ts')>();
  return {
    ...actual,
    doStream: vi.fn(),
  };
});

import { doStream, type AgentInteraction, type StreamOpts } from '../src/agent/index.ts';
import { Bot, type StreamEvent, type InteractionSnapshot } from '../src/bot/bot.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';
import { makeStreamResult } from './support/stream-result.ts';

const envSnapshot = captureEnv(['PIKICLAW_CONFIG', 'PIKICLAW_WORKDIR', 'DEFAULT_AGENT']);

beforeEach(() => {
  restoreEnv(envSnapshot);
  vi.clearAllMocks();
  const tmpConfig = makeTmpDir('interaction-unit-config-');
  process.env.PIKICLAW_CONFIG = `${tmpConfig}/setting.json`;
  process.env.PIKICLAW_WORKDIR = makeTmpDir('interaction-unit-workdir-');
  process.env.DEFAULT_AGENT = 'codex';
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

// ---- helpers ----------------------------------------------------------------

function buildTestInteraction(overrides: Partial<AgentInteraction> = {}): AgentInteraction {
  return {
    kind: 'user-input',
    id: 'req-1',
    title: 'User Input Required',
    hint: 'Use the buttons when available.',
    questions: [
      {
        id: 'q1',
        header: 'Question',
        prompt: 'Choose a tool approval policy:',
        options: [
          { label: 'Allow', description: 'Allow the tool', value: 'Allow' },
          { label: 'Deny', description: 'Deny the tool', value: 'Deny' },
        ],
        allowFreeform: false,
        allowEmpty: true,
      },
    ],
    resolveWith: (answers) => ({
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, vals]) => [id, { answers: vals }]),
      ),
    }),
    ...overrides,
  };
}

// ---- tests ------------------------------------------------------------------

describe('Bot interaction handler via submitSessionTask (dashboard path)', () => {
  it('creates interaction prompts, emits SSE events, and resolves via public API', async () => {
    const doStreamMock = vi.mocked(doStream);
    const events: StreamEvent[] = [];

    // doStream captures onInteraction and triggers it mid-stream
    let capturedOnInteraction: StreamOpts['onInteraction'];

    doStreamMock.mockImplementationOnce(async (opts) => {
      capturedOnInteraction = opts.onInteraction;
      // Simulate agent requesting user input
      const interactionPromise = opts.onInteraction?.(buildTestInteraction());

      // The promise should NOT be resolved yet — waiting for user
      expect(interactionPromise).toBeInstanceOf(Promise);

      // We'll resolve it from outside after checking the state
      const response = await interactionPromise;
      expect(response).toEqual({
        answers: { q1: { answers: ['Allow'] } },
      });

      return makeStreamResult('codex', {
        sessionId: 'sess-interaction',
        message: 'done after interaction',
      });
    });

    const bot = new Bot();

    // Subscribe to SSE events
    bot.onStreamSnapshot((key, snap) => {
      if (snap?.interactions?.length) {
        events.push({ type: 'interaction', taskId: snap.taskId, interaction: snap.interactions[0] });
      }
    });

    const submitted = bot.submitSessionTask({
      agent: 'codex',
      sessionId: 'sess-interaction',
      workdir: process.env.PIKICLAW_WORKDIR!,
      prompt: 'do work',
    });

    expect(submitted.ok).toBe(true);

    // Wait for the stream to reach the interaction point
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const snap = bot.getStreamSnapshot('codex:sess-interaction');
      if (snap?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }

    // Verify interaction snapshot is present
    const snap = bot.getStreamSnapshot('codex:sess-interaction');
    expect(snap?.interactions).toHaveLength(1);
    expect(snap!.interactions![0]).toMatchObject({
      kind: 'user-input',
      title: 'User Input Required',
    });
    const promptId = snap!.interactions![0].promptId;

    // Verify prompt is accessible via public API
    const promptState = bot.interactionPrompt(promptId);
    expect(promptState).toBeTruthy();
    expect(promptState!.title).toBe('User Input Required');
    expect(promptState!.questions).toHaveLength(1);

    // Respond via public API (simulating dashboard REST call)
    const selectResult = bot.interactionSelectOption(promptId, 'Allow');
    expect(selectResult).toBeTruthy();
    expect(selectResult!.completed).toBe(true);

    // Wait for stream to complete
    const doneDeadline = Date.now() + 2000;
    while (Date.now() < doneDeadline) {
      const s = bot.getStreamSnapshot('codex:sess-interaction');
      if (s?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }

    // Verify final state
    const finalSnap = bot.getStreamSnapshot('codex:sess-interaction');
    expect(finalSnap?.phase).toBe('done');
    expect(finalSnap?.interactions).toBeUndefined();

    // Verify prompt is no longer active
    expect(bot.interactionPrompt(promptId)).toBeNull();
  });

  it('cancels interaction prompts and rejects the agent promise', async () => {
    const doStreamMock = vi.mocked(doStream);

    doStreamMock.mockImplementationOnce(async (opts) => {
      try {
        await opts.onInteraction?.(buildTestInteraction());
        // Should not reach here
        return makeStreamResult('codex', { message: 'unexpected' });
      } catch (error: any) {
        expect(error.message).toContain('Cancelled');
        return makeStreamResult('codex', {
          sessionId: 'sess-cancel',
          message: 'cancelled interaction',
          incomplete: true,
        });
      }
    });

    const bot = new Bot();
    bot.submitSessionTask({
      agent: 'codex',
      sessionId: 'sess-cancel',
      workdir: process.env.PIKICLAW_WORKDIR!,
      prompt: 'do work',
    });

    // Wait for interaction
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const snap = bot.getStreamSnapshot('codex:sess-cancel');
      if (snap?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }

    const snap = bot.getStreamSnapshot('codex:sess-cancel');
    const promptId = snap!.interactions![0].promptId;

    // Cancel via public API
    const cancelResult = bot.interactionCancel(promptId);
    expect(cancelResult).toBeTruthy();

    // Wait for stream to complete
    const doneDeadline = Date.now() + 2000;
    while (Date.now() < doneDeadline) {
      const s = bot.getStreamSnapshot('codex:sess-cancel');
      if (s?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }

    expect(bot.getStreamSnapshot('codex:sess-cancel')?.phase).toBe('done');
  });

  it('handles freeform text submission through the public API', async () => {
    const doStreamMock = vi.mocked(doStream);

    const freeformInteraction = buildTestInteraction({
      questions: [
        {
          id: 'q1',
          header: 'Question',
          prompt: 'Enter your API key:',
          secret: true,
          allowFreeform: true,
        },
      ],
    });

    doStreamMock.mockImplementationOnce(async (opts) => {
      const response = await opts.onInteraction?.(freeformInteraction);
      expect(response).toEqual({
        answers: { q1: { answers: ['my-secret-key'] } },
      });
      return makeStreamResult('codex', {
        sessionId: 'sess-freeform',
        message: 'done',
      });
    });

    const bot = new Bot();
    bot.submitSessionTask({
      agent: 'codex',
      sessionId: 'sess-freeform',
      workdir: process.env.PIKICLAW_WORKDIR!,
      prompt: 'do work',
    });

    // Wait for interaction
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const snap = bot.getStreamSnapshot('codex:sess-freeform');
      if (snap?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }

    const snap = bot.getStreamSnapshot('codex:sess-freeform');
    const promptId = snap!.interactions![0].promptId;

    // Submit text via public API
    const textResult = bot.interactionSubmitText(promptId, 'my-secret-key');
    expect(textResult).toBeTruthy();
    expect(textResult!.completed).toBe(true);

    // Wait for done
    const doneDeadline = Date.now() + 2000;
    while (Date.now() < doneDeadline) {
      const s = bot.getStreamSnapshot('codex:sess-freeform');
      if (s?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }

    expect(bot.getStreamSnapshot('codex:sess-freeform')?.phase).toBe('done');
  });

  it('handles skip via the public API', async () => {
    const doStreamMock = vi.mocked(doStream);

    doStreamMock.mockImplementationOnce(async (opts) => {
      const response = await opts.onInteraction?.(buildTestInteraction());
      expect(response).toEqual({
        answers: { q1: { answers: [] } },
      });
      return makeStreamResult('codex', {
        sessionId: 'sess-skip',
        message: 'done',
      });
    });

    const bot = new Bot();
    bot.submitSessionTask({
      agent: 'codex',
      sessionId: 'sess-skip',
      workdir: process.env.PIKICLAW_WORKDIR!,
      prompt: 'do work',
    });

    // Wait for interaction
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const snap = bot.getStreamSnapshot('codex:sess-skip');
      if (snap?.interactions?.length) break;
      await new Promise(r => setTimeout(r, 10));
    }

    const snap = bot.getStreamSnapshot('codex:sess-skip');
    const promptId = snap!.interactions![0].promptId;

    // Skip via public API
    const skipResult = bot.interactionSkip(promptId);
    expect(skipResult).toBeTruthy();
    expect(skipResult!.completed).toBe(true);

    // Wait for done
    const doneDeadline = Date.now() + 2000;
    while (Date.now() < doneDeadline) {
      const s = bot.getStreamSnapshot('codex:sess-skip');
      if (s?.phase === 'done') break;
      await new Promise(r => setTimeout(r, 10));
    }

    expect(bot.getStreamSnapshot('codex:sess-skip')?.phase).toBe('done');
  });
});

describe('Bot.runStream interaction handler (IM path)', () => {
  it('invokes onInteraction and the response resolves back into the stream', async () => {
    const doStreamMock = vi.mocked(doStream);

    doStreamMock.mockImplementationOnce(async (opts) => {
      expect(opts.onInteraction).toBeDefined();

      const response = await opts.onInteraction?.(buildTestInteraction());
      // Verify the response shape
      expect(response).toEqual({
        answers: { q1: { answers: ['Deny'] } },
      });

      return makeStreamResult('codex', {
        sessionId: 'sess-im',
        message: 'done after IM interaction',
      });
    });

    const bot = new Bot();
    const cs = bot.chat(1);
    cs.agent = 'codex';

    // Simulate the IM path: provide onInteraction to runStream
    const interactionHandler = (bot as any).createInteractionHandler(1, 'task-im', 'codex:sess-im');

    const resultPromise = bot.runStream('do something', cs, [], () => {}, undefined, undefined, undefined, interactionHandler);

    // Wait for the interaction prompt to appear
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const prompt = (bot as any).pendingHumanLoopPrompt(1);
      if (prompt) break;
      await new Promise(r => setTimeout(r, 10));
    }

    // Find and answer the prompt
    const prompt = (bot as any).pendingHumanLoopPrompt(1);
    expect(prompt).toBeTruthy();
    expect(prompt.title).toBe('User Input Required');

    // Select an option (Deny)
    const selectResult = (bot as any).humanLoopSelectOption(prompt.promptId, 'Deny');
    expect(selectResult.completed).toBe(true);

    const result = await resultPromise;
    expect(result.message).toBe('done after IM interaction');
  });
});

describe('interaction on nonexistent prompts', () => {
  it('returns null for all operations on nonexistent prompt IDs', () => {
    const bot = new Bot();
    expect(bot.interactionSelectOption('nope', 'x')).toBeNull();
    expect(bot.interactionSubmitText('nope', 'x')).toBeNull();
    expect(bot.interactionSkip('nope')).toBeNull();
    expect(bot.interactionCancel('nope')).toBeNull();
    expect(bot.interactionPrompt('nope')).toBeNull();
  });
});
