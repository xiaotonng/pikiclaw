/**
 * E2E test for getSessions — reads real session files from ~/.claude and ~/.codex.
 *
 * Run:  npx vitest run test/getSessions.e2e.test.ts
 */
import { it, expect } from 'vitest';
import { getSessions } from '../../src/code-agent.ts';

const workdir = '/Users/admin/Desktop/project/codeclaw';

it('getSessions e2e — reads real claude sessions from disk', async () => {
  const result = await getSessions({ agent: 'claude', workdir, limit: 5 });
  console.log(JSON.stringify(result, null, 2));
  expect(result.ok).toBe(true);
  expect(result.sessions.length).toBeGreaterThan(0);
  for (const s of result.sessions) {
    expect(s.agent).toBe('claude');
    expect(s.sessionId).toBeTruthy();
    expect(s.workdir).toBe(workdir);
    expect(s.model).toBeTruthy();
    expect(s.createdAt).toBeTruthy();
    expect(s.title).toBeTruthy();
  }
});

it('getSessions e2e — reads real codex sessions from disk', async () => {
  const result = await getSessions({ agent: 'codex', workdir, limit: 5 });
  console.log(JSON.stringify(result, null, 2));
  expect(result.ok).toBe(true);
  expect(result.sessions.length).toBeGreaterThan(0);
  for (const s of result.sessions) {
    expect(s.agent).toBe('codex');
    expect(s.sessionId).toBeTruthy();
    expect(s.workdir).toBe(workdir);
    expect(s.createdAt).toBeTruthy();
  }
  // At least some sessions should have a title extracted
  expect(result.sessions.some(s => s.title)).toBe(true);
});
