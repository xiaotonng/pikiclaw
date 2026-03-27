import { describe, expect, it } from 'vitest';
import { shouldPollSessionStreamState } from '../dashboard/src/utils.ts';

describe('dashboard stream polling', () => {
  it('stops polling completed sessions once no active stream remains', () => {
    expect(shouldPollSessionStreamState('completed', false, null, null)).toBe(false);
    expect(shouldPollSessionStreamState('completed', false, 'done', 'streaming')).toBe(false);
    expect(shouldPollSessionStreamState('completed', false, null, 'done')).toBe(false);
  });

  it('keeps polling while a stream is active or a local send is waiting to attach', () => {
    expect(shouldPollSessionStreamState('completed', true, null, null)).toBe(true);
    expect(shouldPollSessionStreamState('completed', false, 'queued', null)).toBe(true);
    expect(shouldPollSessionStreamState('incomplete', false, 'streaming', 'queued')).toBe(true);
    expect(shouldPollSessionStreamState('running', false, null, null)).toBe(true);
  });
});
