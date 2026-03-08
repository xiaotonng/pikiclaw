/**
 * E2E tests for model discovery — hits real local claude/codex CLIs, config, and session state.
 *
 * No mocks are used here.
 *
 * Run: npx vitest run test/list-models.e2e.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { listModels } from '../src/code-agent.ts';

function hasCmd(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_CLAUDE = hasCmd('claude');
const HAS_CODEX = hasCmd('codex');
const WORKDIR = process.cwd();

describe.skipIf(!HAS_CLAUDE && !HAS_CODEX)('listModels e2e', () => {
  it.skipIf(!HAS_CLAUDE)('discovers Claude models from the real local environment', () => {
    const currentModel = (process.env.CLAUDE_MODEL || 'claude-opus-4-6').trim();
    const result = listModels('claude', { workdir: WORKDIR, currentModel });

    console.log('\n[list-models e2e][claude]');
    console.log(JSON.stringify(result, null, 2));

    expect(result.agent).toBe('claude');
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.note).toContain('does not expose');
  });

  it.skipIf(!HAS_CODEX)('discovers Codex models from the real local environment', () => {
    const currentModel = (process.env.CODEX_MODEL || 'gpt-5.4').trim();
    const result = listModels('codex', { workdir: WORKDIR, currentModel });

    console.log('\n[list-models e2e][codex]');
    console.log(JSON.stringify(result, null, 2));

    expect(result.agent).toBe('codex');
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.note).toContain('does not expose');
  });
});
