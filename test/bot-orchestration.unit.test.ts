import { describe, expect, it } from 'vitest';

import {
  SessionMessageRegistry,
  buildBotMenuState,
  buildKnownChatEnv,
  buildSessionTaskId,
} from '../src/bot-orchestration.ts';

describe('bot-orchestration helpers', () => {
  it('builds menu state from installed agents and available skills', () => {
    const state = buildBotMenuState({
      fetchAgents: () => ({
        agents: [
          { agent: 'claude', installed: true },
          { agent: 'codex', installed: true },
          { agent: 'gemini', installed: false },
        ],
      } as any),
      fetchSkills: () => ({
        skills: [
          { name: 'review', prompt: 'review' },
          { name: 'install', prompt: 'install' },
        ],
      } as any),
    } as any);

    expect(state.skillCount).toBe(2);
    expect(state.commands.some(command => command.command === 'skills')).toBe(true);
    expect(state.commands.some(command => command.command === 'stop')).toBe(true);
    expect(state.commands.some(command => command.command === 'agents')).toBe(true);
  });

  it('deduplicates known chat ids and formats restart env vars', () => {
    expect(buildKnownChatEnv(new Set([1001, 1002]), [1002, '1003'], 'TELEGRAM_ALLOWED_CHAT_IDS')).toEqual({
      TELEGRAM_ALLOWED_CHAT_IDS: '1001,1002,1003',
    });
  });

  it('generates stable task ids and prunes per-chat session message history', () => {
    expect(buildSessionTaskId({ key: 'codex:sess-1' } as any, 7, 123456789)).toBe('codex:sess-1:21i3v9:7');

    const registry = new SessionMessageRegistry<number, number>(2);
    const session = { key: 'codex:sess-1', workdir: '/tmp/workdir', agent: 'codex', sessionId: 'sess-1' };

    registry.register(1, 100, session as any, '/tmp/workdir');
    registry.register(1, 101, session as any, '/tmp/workdir');
    registry.register(1, 102, session as any, '/tmp/workdir');
    registry.register(1, Number.NaN, session as any, '/tmp/workdir');
    registry.register(1, 103, { key: 'codex:sess-2', workdir: '/tmp/other', agent: 'codex', sessionId: 'sess-2' } as any, '/tmp/workdir');

    expect(registry.resolve(1, 100)).toBeNull();
    expect(registry.resolve(1, 101)).toMatchObject({ key: 'codex:sess-1', workdir: '/tmp/workdir', agent: 'codex', sessionId: 'sess-1' });
    expect(registry.resolve(1, 102)).toMatchObject({ key: 'codex:sess-1', workdir: '/tmp/workdir', agent: 'codex', sessionId: 'sess-1' });
    expect(registry.resolve(1, 103)).toBeNull();
  });
});
