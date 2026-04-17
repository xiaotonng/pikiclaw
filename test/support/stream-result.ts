import type { Agent, StreamResult } from '../../src/agent/index.ts';

export function makeStreamResult(
  agent: Agent,
  overrides: Partial<StreamResult> = {},
): StreamResult {
  return {
    ok: true,
    message: 'ok',
    thinking: null,
    plan: null,
    sessionId: 'sess-1',
    workspacePath: null,
    model: agent === 'codex' ? 'gpt-5.4' : 'claude-opus-4-7',
    thinkingEffort: 'high',
    elapsedS: 0.1,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    contextWindow: null,
    contextUsedTokens: null,
    contextPercent: null,
    codexCumulative: null,
    error: null,
    stopReason: null,
    incomplete: false,
    activity: null,
    ...overrides,
  };
}
