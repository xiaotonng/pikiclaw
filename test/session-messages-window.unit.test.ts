import { describe, expect, it } from 'vitest';
import { applyTurnWindow, type TailMessage } from '../src/code-agent.ts';

function conversation(turns: number): TailMessage[] {
  const messages: TailMessage[] = [];
  for (let i = 1; i <= turns; i++) {
    messages.push({ role: 'user', text: `user ${i}` });
    messages.push({ role: 'assistant', text: `assistant ${i}` });
  }
  return messages;
}

describe('applyTurnWindow', () => {
  it('returns a stable turn window with pagination metadata', () => {
    const result = applyTurnWindow(conversation(4), { turnOffset: 1, turnLimit: 2 });

    expect(result.ok).toBe(true);
    expect(result.totalTurns).toBe(4);
    expect(result.messages.map(message => message.text)).toEqual([
      'user 2',
      'assistant 2',
      'user 3',
      'assistant 3',
    ]);
    expect(result.richMessages?.map(message => message.text)).toEqual([
      'user 2',
      'assistant 2',
      'user 3',
      'assistant 3',
    ]);
    expect(result.window).toEqual({
      offset: 1,
      limit: 2,
      returnedTurns: 2,
      totalTurns: 4,
      hasOlder: true,
      hasNewer: true,
      startTurn: 1,
      endTurn: 3,
    });
  });

  it('returns all turns when no window is requested', () => {
    const result = applyTurnWindow(conversation(3), {});

    expect(result.ok).toBe(true);
    expect(result.messages).toHaveLength(6);
    expect(result.window).toEqual({
      offset: 0,
      limit: 3,
      returnedTurns: 3,
      totalTurns: 3,
      hasOlder: false,
      hasNewer: false,
      startTurn: 0,
      endTurn: 3,
    });
  });
});
