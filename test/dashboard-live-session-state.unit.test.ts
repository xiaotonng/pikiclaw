import { describe, expect, it } from 'vitest';
import {
  applyLiveSessionState,
  normalizeLiveSessionState,
  sessionDisplayState,
} from '../dashboard/src/utils.ts';

describe('dashboard live session state helpers', () => {
  it('normalizes promoted stream snapshots onto the native session key', () => {
    const live = normalizeLiveSessionState('codex:pending_123', {
      phase: 'streaming',
      sessionId: 'native-456',
      updatedAt: 123,
    });

    expect(live).toEqual({
      key: 'codex:pending_123',
      resolvedKey: 'codex:native-456',
      phase: 'streaming',
      sessionId: 'native-456',
      updatedAt: 123,
      incomplete: false,
      error: null,
    });
  });

  it('maps queued and streaming snapshots to running UI state', () => {
    const base = {
      sessionId: 'sess-1',
      agent: 'codex',
      runState: 'completed' as const,
      running: false,
      runUpdatedAt: null,
      runDetail: 'old detail',
    };

    const queued = normalizeLiveSessionState('codex:sess-1', { phase: 'queued', updatedAt: 100 });
    const streaming = normalizeLiveSessionState('codex:sess-1', { phase: 'streaming', updatedAt: 200 });

    expect(sessionDisplayState(applyLiveSessionState(base, queued))).toBe('running');
    expect(sessionDisplayState(applyLiveSessionState(base, streaming))).toBe('running');
    expect(applyLiveSessionState(base, streaming).runDetail).toBeNull();
  });

  it('maps incomplete done snapshots to incomplete instead of completed', () => {
    const base = {
      sessionId: 'sess-2',
      agent: 'codex',
      runState: 'running' as const,
      running: true,
      runUpdatedAt: null,
      runDetail: null,
    };

    const done = normalizeLiveSessionState('codex:sess-2', {
      phase: 'done',
      updatedAt: 300,
      incomplete: true,
      error: 'Timed out before completion.',
    });

    const next = applyLiveSessionState(base, done);
    expect(sessionDisplayState(next)).toBe('incomplete');
    expect(next.runDetail).toBe('Timed out before completion.');
  });
});
