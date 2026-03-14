import { describe, expect, it } from 'vitest';

import { buildStreamingBodyMarkdown, buildStreamPreviewMarkdown } from '../src/bot-feishu-render.ts';

describe('Feishu streaming preview render', () => {
  const input = {
    agent: 'codex' as const,
    elapsedMs: 12_000,
    bodyText: 'Final answer in progress.',
    thinking: 'Need to compare the live preview controller with the renderer.',
    activity: 'Inspecting streaming pipeline.\nExecuted 2 commands.',
    meta: { contextPercent: 42 },
    plan: {
      explanation: null,
      steps: [
        { step: 'Inspect streaming preview', status: 'completed' as const },
        { step: 'Patch Feishu renderer', status: 'inProgress' as const },
      ],
    },
  };

  it('keeps activity and thinking in CardKit streaming body updates', () => {
    const markdown = buildStreamingBodyMarkdown(input);

    expect(markdown).toContain('**Plan**');
    expect(markdown).toContain('Inspecting streaming pipeline.');
    expect(markdown).toContain('**Reasoning**');
    expect(markdown).toContain('Final answer in progress.');
    expect(markdown).not.toContain('● codex');
  });

  it('keeps the footer in the regular preview renderer', () => {
    const markdown = buildStreamPreviewMarkdown(input);

    expect(markdown).toContain('**Activity**');
    expect(markdown).toContain('Final answer in progress.');
    expect(markdown).toContain('● codex · 42% · 12s');
  });
});
