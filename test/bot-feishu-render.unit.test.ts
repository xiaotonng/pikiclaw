import { describe, expect, it } from 'vitest';
import {
  renderAgentsListCard,
  renderModelsListCard,
  renderSessionsPageCard,
} from '../src/bot-feishu-render.ts';

describe('bot-feishu-render command cards', () => {
  it('builds agent cards with switch buttons', () => {
    const card = renderAgentsListCard({
      currentAgent: 'codex',
      agents: [
        { agent: 'claude', installed: true, version: '1.0.0', path: '/claude', isCurrent: false },
        { agent: 'codex', installed: true, version: '2.0.0', path: '/codex', isCurrent: true },
        { agent: 'gemini', installed: false, version: null, path: null, isCurrent: false },
      ],
    });

    expect(card.markdown).toContain('Use the controls below');
    expect(card.rows).toHaveLength(1);
    expect(card.rows?.[0]?.actions).toHaveLength(2);
    expect((card.rows?.[0]?.actions[1] as any).value.action).toBe('ag:codex');
    expect((card.rows?.[0]?.actions[1] as any).type).toBe('primary');
  });

  it('builds model cards with model and effort rows', () => {
    const card = renderModelsListCard({
      agent: 'codex',
      currentModel: 'o3',
      sources: ['cli'],
      note: null,
      models: [
        { id: 'o3', alias: 'o3', isCurrent: true },
        { id: 'o4-mini', alias: 'o4-mini', isCurrent: false },
      ],
      effort: {
        current: 'high',
        levels: [
          { id: 'low', label: 'Low', isCurrent: false },
          { id: 'high', label: 'High', isCurrent: true },
        ],
      },
    });

    expect(card.rows).toHaveLength(2);
    expect((card.rows?.[0]?.actions[0] as any).value.action).toBe('mod:o3');
    expect((card.rows?.[1]?.actions[1] as any).value.action).toBe('eff:high');
    expect((card.rows?.[1]?.actions[1] as any).type).toBe('primary');
  });

  it('builds sessions cards with navigation controls', () => {
    const card = renderSessionsPageCard({
      agent: 'codex',
      total: 7,
      page: 1,
      totalPages: 3,
      sessions: [
        { key: 'sess-1', title: 'feature-a', time: '03/11 10:00', isCurrent: false, isRunning: false },
        { key: 'sess-2', title: 'feature-b', time: '03/11 11:00', isCurrent: true, isRunning: true },
      ],
    });

    expect(card.rows).toHaveLength(2);
    expect((card.rows?.[0]?.actions[0] as any).value.action).toBe('sess:sess-1');
    expect((card.rows?.[0]?.actions[1] as any).value.action).toBe('sess:sess-2');
    expect((card.rows?.[1]?.actions[0] as any).value.action).toBe('sp:0');
    expect((card.rows?.[1]?.actions[1] as any).value.action).toBe('sess:new');
    expect((card.rows?.[1]?.actions[2] as any).value.action).toBe('sp:2');
  });
});
