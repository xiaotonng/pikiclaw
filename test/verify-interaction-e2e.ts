#!/usr/bin/env npx tsx
/**
 * End-to-end interaction verification script.
 *
 * Starts a real dashboard + bot, submits a task that triggers a human-in-the-loop
 * interaction, then responds via REST API — exactly how the dashboard frontend would.
 *
 * Run:  npx tsx test/verify-interaction-e2e.ts
 */

import fs from 'node:fs';
import { Bot } from '../src/bot/bot.ts';
import { startDashboard, type DashboardServer } from '../src/dashboard/server.ts';
import type { AgentInteraction, StreamResult } from '../src/agent/index.ts';

// ---------------------------------------------------------------------------
// Setup env before anything else
// ---------------------------------------------------------------------------

const TMP = '/tmp/pikiclaw-e2e-interaction';
fs.mkdirSync(`${TMP}/workdir`, { recursive: true });
fs.writeFileSync(`${TMP}/setting.json`, '{}');
process.env.PIKICLAW_CONFIG = `${TMP}/setting.json`;
process.env.PIKICLAW_WORKDIR = `${TMP}/workdir`;
process.env.DEFAULT_AGENT = 'codex';

// ---------------------------------------------------------------------------
// Create a Bot subclass that patches runStream to inject interaction
// ---------------------------------------------------------------------------

class TestBot extends Bot {
  async runStream(...args: Parameters<Bot['runStream']>): Promise<StreamResult> {
    const [prompt, cs, attachments, onText, _sp, _mcp, _abort, onInteraction] = args;

    if (!onInteraction) {
      return super.runStream(...args);
    }

    console.log('\n🤖 [Agent] Simulating human-in-the-loop: asking user to choose...');

    const interaction: AgentInteraction = {
      kind: 'permission',
      id: 'demo-req-1',
      title: 'Tool Permission Required',
      hint: 'The agent wants to execute a shell command. Please approve or deny.',
      questions: [
        {
          id: 'approval',
          header: 'Shell Command Approval',
          prompt: 'Allow execution of: rm -rf /tmp/test-dir',
          options: [
            { label: 'Allow', description: 'Approve this command', value: 'allow' },
            { label: 'Deny', description: 'Block this command', value: 'deny' },
            { label: 'Allow All', description: 'Auto-approve for this session', value: 'allow-all' },
          ],
          allowFreeform: true,
          allowEmpty: false,
        },
      ],
      resolveWith: (answers) => {
        const choice = answers.approval?.[0] || 'deny';
        console.log(`\n   [Agent] Received user response: "${choice}"`);
        return { approved: choice !== 'deny', policy: choice };
      },
    };

    onText?.('Analyzing your request...', '', 'Preparing to execute command');

    const response = await onInteraction(interaction);
    console.log(`   [Agent] Resolved response:`, JSON.stringify(response));

    onText?.(`Command ${response?.approved ? 'approved' : 'denied'} by user.`, '', 'Done');

    return {
      ok: true,
      message: `Task completed. User chose: ${response?.policy || 'unknown'}`,
      thinking: null,
      plan: null,
      sessionId: 'demo-session',
      workspacePath: null,
      model: 'demo-model',
      thinkingEffort: 'high',
      elapsedS: 1.5,
      inputTokens: 100,
      outputTokens: 50,
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
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PORT = 13941;
const BASE = `http://localhost:${PORT}`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function json(url: string, opts?: RequestInit) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers as any },
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let dashboard: DashboardServer | null = null;

try {
  // Step 1
  console.log('━━━ Step 1: Starting Bot + Dashboard ━━━');
  const bot = new TestBot();
  dashboard = await startDashboard({ port: PORT, bot });
  console.log(`   Dashboard at ${dashboard.url}`);

  // Step 2
  console.log('\n━━━ Step 2: Submitting task via POST /api/session-hub/session/send ━━━');
  const sendResult = await json(`${BASE}/api/session-hub/session/send`, {
    method: 'POST',
    body: JSON.stringify({
      workdir: `${TMP}/workdir`,
      agent: 'codex',
      sessionId: 'demo-session',
      prompt: 'Please clean up /tmp/test-dir',
    }),
  });
  console.log('   Response:', JSON.stringify(sendResult));
  if (!sendResult.ok) throw new Error(`Submit failed: ${sendResult.error}`);

  // Step 3
  console.log('\n━━━ Step 3: Polling GET /api/session-hub/session/stream-state ━━━');
  let promptId: string | null = null;
  for (let i = 0; i < 100 && !promptId; i++) {
    const state = await json(`${BASE}/api/session-hub/session/stream-state?agent=codex&sessionId=demo-session`);
    if (state.state?.interactions?.length) {
      promptId = state.state.interactions[0].promptId;
      console.log('   Interaction found in stream state!');
      console.log('   interactions:', JSON.stringify(state.state.interactions, null, 2));
      break;
    }
    await sleep(30);
  }
  if (!promptId) throw new Error('Timeout: no interaction appeared');

  // Step 4
  console.log('\n━━━ Step 4: GET /api/interaction/:promptId ━━━');
  const detail = await json(`${BASE}/api/interaction/${promptId}`);
  console.log('   Prompt:', JSON.stringify(detail, null, 2));
  if (!detail.prompt) throw new Error('Prompt detail is null');

  // Step 5
  console.log('\n━━━ Step 5: POST /api/interaction/:promptId/select {value: "allow"} ━━━');
  const selectResult = await json(`${BASE}/api/interaction/${promptId}/select`, {
    method: 'POST',
    body: JSON.stringify({ value: 'allow' }),
  });
  console.log('   Result:', JSON.stringify(selectResult));
  if (!selectResult.ok || !selectResult.completed) throw new Error('Select failed');

  // Step 6
  console.log('\n━━━ Step 6: Waiting for task to complete... ━━━');
  let finalState: any = null;
  for (let i = 0; i < 100 && !finalState; i++) {
    const state = await json(`${BASE}/api/session-hub/session/stream-state?agent=codex&sessionId=demo-session`);
    if (state.state?.phase === 'done') { finalState = state.state; break; }
    await sleep(30);
  }
  if (!finalState) throw new Error('Timeout: task did not complete');
  console.log('   phase: done');
  console.log('   text:', finalState.text);
  console.log('   interactions:', finalState.interactions ?? '(none)');

  // Step 7
  console.log('\n━━━ Step 7: Verify prompt is cleaned up ━━━');
  const after = await json(`${BASE}/api/interaction/${promptId}`);
  console.log('   Prompt after resolve:', JSON.stringify(after));
  if (after.prompt !== null) throw new Error('Prompt should be null after resolve');

  // Done
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' ALL PASSED — full interaction chain verified:');
  console.log('   1. Dashboard submits task     (POST /api/.../send)');
  console.log('   2. Agent triggers interaction  (onInteraction callback)');
  console.log('   3. Interaction in SSE/snapshot (GET  /api/.../stream-state)');
  console.log('   4. Dashboard reads prompt      (GET  /api/interaction/:id)');
  console.log('   5. Dashboard responds          (POST /api/interaction/:id/select)');
  console.log('   6. Agent receives + completes  (resolveWith → stream done)');
  console.log('   7. Prompt cleaned up           (GET  /api/interaction/:id → null)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
} catch (err) {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
} finally {
  if (dashboard) await dashboard.close();
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}
