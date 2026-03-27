/**
 * session-hub performance benchmark.
 *
 * Measures querySessions() across different query patterns:
 *   1. Single agent query
 *   2. All agents query
 *   3. With status filtering
 *   4. Repeated queries (warm cache)
 *   5. querySessionTail
 *
 * Run: npx tsx test/session-hub-perf.ts
 */

import { querySessions, querySessionTail, resolveUserStatus } from '../src/session-hub.js';

const WORKDIR = process.cwd();
const ITERATIONS = 10;

async function measure(label: string, fn: () => Promise<any>): Promise<{ label: string; avgMs: number; minMs: number; maxMs: number; result: any }> {
  // Warm up
  await fn();

  const times: number[] = [];
  let lastResult: any;
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    lastResult = await fn();
    times.push(performance.now() - start);
  }

  const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);

  return { label, avgMs, minMs, maxMs, result: lastResult };
}

async function main() {
  console.log(`\nSession Hub Performance Benchmark`);
  console.log(`workdir: ${WORKDIR}`);
  console.log(`iterations: ${ITERATIONS}\n`);
  console.log('─'.repeat(70));

  // 1. Single agent — claude
  const claude = await measure('querySessions(claude)', () =>
    querySessions({ workdir: WORKDIR, agent: 'claude' }),
  );
  console.log(`${claude.label.padEnd(40)} avg=${claude.avgMs.toFixed(1)}ms  min=${claude.minMs.toFixed(1)}ms  max=${claude.maxMs.toFixed(1)}ms  sessions=${claude.result.total}`);

  // 2. Single agent — codex
  const codex = await measure('querySessions(codex)', () =>
    querySessions({ workdir: WORKDIR, agent: 'codex' }),
  );
  console.log(`${codex.label.padEnd(40)} avg=${codex.avgMs.toFixed(1)}ms  min=${codex.minMs.toFixed(1)}ms  max=${codex.maxMs.toFixed(1)}ms  sessions=${codex.result.total}`);

  // 3. Single agent — gemini
  const gemini = await measure('querySessions(gemini)', () =>
    querySessions({ workdir: WORKDIR, agent: 'gemini' }),
  );
  console.log(`${gemini.label.padEnd(40)} avg=${gemini.avgMs.toFixed(1)}ms  min=${gemini.minMs.toFixed(1)}ms  max=${gemini.maxMs.toFixed(1)}ms  sessions=${gemini.result.total}`);

  // 4. All agents (no filter)
  const all = await measure('querySessions(all agents)', () =>
    querySessions({ workdir: WORKDIR }),
  );
  console.log(`${all.label.padEnd(40)} avg=${all.avgMs.toFixed(1)}ms  min=${all.minMs.toFixed(1)}ms  max=${all.maxMs.toFixed(1)}ms  sessions=${all.result.total}`);

  // 5. All agents with limit
  const limited = await measure('querySessions(all, limit=10)', () =>
    querySessions({ workdir: WORKDIR, limit: 10 }),
  );
  console.log(`${limited.label.padEnd(40)} avg=${limited.avgMs.toFixed(1)}ms  min=${limited.minMs.toFixed(1)}ms  max=${limited.maxMs.toFixed(1)}ms  sessions=${limited.result.total}`);

  // 6. With status filter
  const filtered = await measure('querySessions(status=review)', () =>
    querySessions({ workdir: WORKDIR, userStatus: ['review'] }),
  );
  console.log(`${filtered.label.padEnd(40)} avg=${filtered.avgMs.toFixed(1)}ms  min=${filtered.minMs.toFixed(1)}ms  max=${filtered.maxMs.toFixed(1)}ms  sessions=${filtered.result.total}`);

  // 7. Session tail — pick first session with an ID
  const firstSession = all.result.sessions.find((s: any) => s.sessionId);
  if (firstSession) {
    const tail = await measure(`querySessionTail(${firstSession.agent})`, () =>
      querySessionTail({
        agent: firstSession.agent,
        sessionId: firstSession.sessionId,
        workdir: WORKDIR,
        limit: 6,
      }),
    );
    console.log(`${tail.label.padEnd(40)} avg=${tail.avgMs.toFixed(1)}ms  min=${tail.minMs.toFixed(1)}ms  max=${tail.maxMs.toFixed(1)}ms  messages=${tail.result.messages?.length ?? 0}`);
  }

  console.log('─'.repeat(70));

  // Status distribution
  const statusDist: Record<string, number> = {};
  for (const s of all.result.sessions) {
    const status = resolveUserStatus(s);
    statusDist[status] = (statusDist[status] || 0) + 1;
  }
  console.log(`\nStatus distribution (${all.result.total} sessions):`);
  for (const [status, count] of Object.entries(statusDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(10)} ${count}`);
  }

  // Agent distribution
  const agentDist: Record<string, number> = {};
  for (const s of all.result.sessions) {
    agentDist[s.agent] = (agentDist[s.agent] || 0) + 1;
  }
  console.log(`\nAgent distribution:`);
  for (const [agent, count] of Object.entries(agentDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${agent.padEnd(10)} ${count}`);
  }

  console.log();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
