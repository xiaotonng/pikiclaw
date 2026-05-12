/**
 * Tests for the shared command-UI action codec.
 *
 * Telegram and Feishu encode `CommandAction` values into 64-byte button
 * callback strings; WeChat (no card support) uses the same codec as the
 * `value` field of `HumanLoopQuestion.options`. A round-trip regression here
 * would silently break interactive `/agents` / `/models` / `/sessions` flows
 * on every IM, so we cover the full surface explicitly.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeCommandAction,
  encodeCommandAction,
  type CommandAction,
} from '../src/bot/command-ui.ts';

describe('CommandAction codec', () => {
  const samples: CommandAction[] = [
    { kind: 'sessions.page', page: 0 },
    { kind: 'sessions.page', page: 7 },
    { kind: 'session.new' },
    { kind: 'session.switch', sessionId: 'abc-123-def' },
    { kind: 'agent.switch', agent: 'claude' },
    { kind: 'agent.switch', agent: 'codex' },
    { kind: 'agent.switch', agent: 'gemini' },
    { kind: 'agent.switch', agent: 'hermes' },
    { kind: 'model.switch', modelId: 'claude-opus-4-7' },
    { kind: 'effort.set', effort: 'xhigh' },
    { kind: 'models.select.model', modelId: 'gpt-5' },
    { kind: 'models.select.effort', effort: 'medium' },
    { kind: 'models.confirm' },
    { kind: 'skill.run', command: 'sk_review' },
    { kind: 'mode.switch', mode: 'plan' },
    { kind: 'mode.switch', mode: 'bypassPermissions' },
  ];

  it('round-trips every CommandAction kind', () => {
    for (const action of samples) {
      const encoded = encodeCommandAction(action);
      const decoded = decodeCommandAction(encoded);
      expect(decoded).toEqual(action);
    }
  });

  it('rejects malformed payloads', () => {
    expect(decodeCommandAction('')).toBeNull();
    expect(decodeCommandAction('unknown:foo')).toBeNull();
    expect(decodeCommandAction('sess:')).toBeNull();   // empty sessionId
    expect(decodeCommandAction('ag:notAnAgent')).toBeNull();
    expect(decodeCommandAction('sp:-1')).toBeNull();   // negative page
    expect(decodeCommandAction('sp:abc')).toBeNull();  // non-numeric page
  });

  it('keeps encoded payloads short enough for IM button callbacks (<= 64 bytes)', () => {
    // Telegram limits inline button callback data to 64 bytes. Long ids are
    // truncated upstream; we just verify the encoded prefix stays small.
    for (const action of samples) {
      expect(Buffer.byteLength(encodeCommandAction(action))).toBeLessThanOrEqual(64);
    }
  });
});
