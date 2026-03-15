/**
 * Unit tests for code-agent.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCodexTurnInput,
  doClaudeStream,
  doCodexStream,
  doGeminiStream,
  doStream,
  getSessionTail,
  getUsage,
  labelFromWindowMinutes,
  listModels,
  shutdownCodexServer,
  stageSessionFiles,
  type StreamOpts,
} from '../src/code-agent.ts';
import { makeTmpDir, withTempHome } from './support/env.ts';

const tmpDir = path.join(os.tmpdir(), 'pikiclaw-test-' + process.pid);
const fakeBin = path.join(tmpDir, 'bin');

function writeFakeScript(name: string, jsonLines: object[]) {
  const payload = jsonLines.map(j => JSON.stringify(j)).join('\n');
  const script = `#!/bin/sh\ncat <<'JSONL_EOF'\n${payload}\nJSONL_EOF\n`;
  const p = path.join(fakeBin, name);
  fs.writeFileSync(p, script, { mode: 0o755 });
}

function baseOpts(agent: 'codex' | 'claude' | 'gemini', extra: Partial<StreamOpts> = {}): StreamOpts {
  return {
    agent,
    prompt: 'test prompt',
    workdir: tmpDir,
    timeout: 10,
    sessionId: null,
    model: null,
    thinkingEffort: 'high',
    onText: () => {},
    ...extra,
  };
}

beforeEach(() => {
  fs.mkdirSync(fakeBin, { recursive: true });
  process.env.PATH = `${fakeBin}:${process.env.PATH}`;
  shutdownCodexServer();
});

describe('buildCodexTurnInput and usage helpers', () => {
  it('uses localImage for images, explicit file references for documents, and normalizes rate-limit windows', () => {
    const imagePath = path.join(tmpDir, 'shot.png');
    const docPath = path.join(tmpDir, 'notes.txt');

    const input = buildCodexTurnInput('inspect this', [imagePath, docPath]);

    expect(input).toEqual([
      { type: 'localImage', path: imagePath },
      { type: 'text', text: `[Attached file: ${docPath}]` },
      { type: 'text', text: 'inspect this' },
    ]);

    expect(labelFromWindowMinutes(301, 'Primary')).toBe('5h');
    expect(labelFromWindowMinutes(10081, 'Secondary')).toBe('7d');
  });
});

describe('stageSessionFiles', () => {
  it('stores uploads in managed workspaces and migrates legacy sessions', () => {
    const uploadDir = makeTmpDir('pikiclaw-upload-');
    const uploadPath = path.join(uploadDir, 'report.txt');
    fs.writeFileSync(uploadPath, 'hello');

    const staged = stageSessionFiles({
      agent: 'claude',
      workdir: tmpDir,
      files: [uploadPath],
    });

    const stagedDir = path.join(tmpDir, '.pikiclaw', 'sessions', 'claude', staged.sessionId);
    expect(staged.workspacePath).toBe(path.join(stagedDir, 'workspace'));
    expect(fs.existsSync(path.join(staged.workspacePath, 'report.txt'))).toBe(true);
    expect(fs.existsSync(path.join(stagedDir, 'session.json'))).toBe(true);

    const legacySessionId = 'sess_legacy_layout';
    const legacyWorkspacePath = path.join(tmpDir, '.pikiclaw', 'workspaces', 'claude', legacySessionId);
    const legacyMetaDir = path.join(legacyWorkspacePath, '.pikiclaw');
    fs.mkdirSync(legacyMetaDir, { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspacePath, 'legacy.txt'), 'legacy');
    fs.writeFileSync(path.join(legacyMetaDir, 'return.json'), JSON.stringify({
      files: [{ path: 'legacy.txt', kind: 'document' }],
    }));
    fs.mkdirSync(path.join(tmpDir, '.pikiclaw', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pikiclaw', 'sessions', 'index.json'), JSON.stringify({
      version: 1,
      sessions: [{
        sessionId: legacySessionId,
        agent: 'claude',
        workdir: tmpDir,
        workspacePath: legacyWorkspacePath,
        createdAt: '2026-03-10T00:00:00.000Z',
        updatedAt: '2026-03-10T00:00:00.000Z',
        title: 'legacy session',
        model: 'claude-opus-4-6',
        stagedFiles: [],
      }],
    }, null, 2));

    const migrated = stageSessionFiles({
      agent: 'claude',
      workdir: tmpDir,
      files: [],
      sessionId: legacySessionId,
    });

    const migratedDir = path.join(tmpDir, '.pikiclaw', 'sessions', 'claude', legacySessionId);
    expect(migrated.workspacePath).toBe(path.join(migratedDir, 'workspace'));
    expect(fs.existsSync(path.join(migrated.workspacePath, 'legacy.txt'))).toBe(true);
    expect(fs.existsSync(path.join(migratedDir, 'session.json'))).toBe(true);
    expect(fs.existsSync(legacyWorkspacePath)).toBe(false);
  });
});

describe('codex stream', () => {
  it('passes developerInstructions on resume and surfaces structured plans and file changes', async () => {
    const callsFile = path.join(tmpDir, 'codex-rpc-calls.jsonl');
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const callsFile = ${JSON.stringify(callsFile)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  fs.appendFileSync(callsFile, JSON.stringify(msg) + '\\n');

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
    return;
  }

  if (msg.method === 'thread/resume') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { thread: { id: msg.params.threadId }, model: msg.params.model || 'gpt-5.4' },
    }) + '\\n');
    return;
  }

  if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-1' } } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: msg.params.threadId, turn: { id: 'turn-1' } } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'item/started', params: { threadId: msg.params.threadId, item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer' } } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, itemId: 'msg-1', delta: 'done' } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: msg.params.threadId, item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: 'done' } } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn-1', status: 'completed' } } }) + '\\n');
    return;
  }

  process.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'unexpected method' } }) + '\\n');
});`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script, { mode: 0o755 });

    const result = await doCodexStream(baseOpts('codex', {
      sessionId: 'thread-existing',
      codexModel: 'gpt-5.4',
      codexDeveloperInstructions: '[Telegram Artifact Return]\\nwrite manifest',
    }));

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('thread-existing');

    const calls = fs.readFileSync(callsFile, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const resumeCall = calls.find(call => call.method === 'thread/resume');
    expect(resumeCall?.params?.developerInstructions).toContain('[Telegram Artifact Return]');

    // --- surfaces structured plans and file changes through callbacks ---
    shutdownCodexServer();

    const script2 = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
    return;
  }

  if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { thread: { id: 'thread-edit' }, model: msg.params.model || 'gpt-5.4' },
    }) + '\\n');
    return;
  }

  if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-edit' } } }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-edit',
        turnId: 'turn-edit',
        explanation: 'Investigating',
        plan: [
          { step: 'Inspect streaming paths', status: 'completed' },
          { step: 'Update tests', status: 'inProgress' },
        ],
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/started',
      params: {
        threadId: 'thread-edit',
        item: {
          id: 'tool-1',
          type: 'dynamicToolCall',
          tool: 'functions.apply_patch',
          arguments: '*** Begin Patch',
          status: 'inProgress',
        },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/completed',
      params: {
        threadId: 'thread-edit',
        item: {
          id: 'file-1',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: 'src/bot-telegram.ts', kind: 'updated', diff: '@@' },
          ],
        },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-edit', turn: { id: 'turn-edit', status: 'completed' } },
    }) + '\\n');
    return;
  }

  process.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'unexpected method' } }) + '\\n');
});`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script2, { mode: 0o755 });

    const plans: any[] = [];
    const activities: string[] = [];
    const result2 = await doCodexStream(baseOpts('codex', {
      onText: (_text, _thinking, activity, _meta, plan) => {
        if (activity?.trim()) activities.push(activity);
        if (plan?.steps?.length) plans.push(plan);
      },
    }));

    expect(result2.ok).toBe(true);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    expect(plans[plans.length - 1].steps).toEqual([
      { step: 'Inspect streaming paths', status: 'completed' },
      { step: 'Update tests', status: 'inProgress' },
    ]);
    expect(activities.some(activity => activity.includes('Edit files...'))).toBe(true);
    expect(result2.activity).toContain('Updated src/bot-telegram.ts');

    // --- parses nested token usage into session context percent ---
    shutdownCodexServer();

    const script3 = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
    return;
  }

  if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { thread: { id: 'thread-usage' }, model: msg.params.model || 'gpt-5.4' },
    }) + '\\n');
    return;
  }

  if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-usage' } } }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-usage',
        tokenUsage: {
          info: {
            total_token_usage: {
              input_tokens: 34310,
              cached_input_tokens: 17280,
              output_tokens: 714,
              reasoning_output_tokens: 446,
              total_tokens: 35024,
            },
            last_token_usage: {
              input_tokens: 11417,
              cached_input_tokens: 10752,
              output_tokens: 125,
              reasoning_output_tokens: 18,
              total_tokens: 11542,
            },
            model_context_window: 258400,
          },
        },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/started',
      params: {
        threadId: 'thread-usage',
        item: { id: 'msg-usage', type: 'agentMessage', phase: 'final_answer' },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-usage', itemId: 'msg-usage', delta: 'done' },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/completed',
      params: {
        threadId: 'thread-usage',
        item: { id: 'msg-usage', type: 'agentMessage', phase: 'final_answer', text: 'done' },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-usage', turn: { id: 'turn-usage', status: 'completed' } },
    }) + '\\n');
    return;
  }

  process.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'unexpected method' } }) + '\\n');
});`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script3, { mode: 0o755 });

    const previewMeta: Array<{ contextPercent: number | null } | undefined> = [];
    const result3 = await doCodexStream(baseOpts('codex', {
      onText: (_text, _thinking, _activity, meta) => {
        if (meta) previewMeta.push({ contextPercent: meta.contextPercent });
      },
    }));

    expect(result3.ok).toBe(true);
    expect(result3.inputTokens).toBe(11417);
    expect(result3.cachedInputTokens).toBe(10752);
    expect(result3.outputTokens).toBe(125);
    expect(result3.contextUsedTokens).toBe(22169);
    expect(result3.contextPercent).toBe(8.6);
    expect(previewMeta.some(meta => meta?.contextPercent === 8.6)).toBe(true);
  });

  it('keeps long codex commentary lines intact and runs turns in parallel across sessions', async () => {
    const commentary = 'I am verifying the release workflow, the npm publish result, and the final changelog content before I close this out. Tail marker: KEEP_THIS_VISIBLE_AT_THE_END';
    const script = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
    return;
  }

  if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { thread: { id: 'thread-commentary' }, model: msg.params.model || 'gpt-5.4' },
    }) + '\\n');
    return;
  }

  if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-commentary' } } }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/started',
      params: {
        threadId: 'thread-commentary',
        item: { id: 'comment-1', type: 'agentMessage', phase: 'commentary', text: '' },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-commentary',
        itemId: 'comment-1',
        delta: ${JSON.stringify(commentary)},
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/completed',
      params: {
        threadId: 'thread-commentary',
        item: { id: 'comment-1', type: 'agentMessage', phase: 'commentary', text: ${JSON.stringify(commentary)} },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/started',
      params: {
        threadId: 'thread-commentary',
        item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer' },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-commentary', itemId: 'msg-1', delta: 'done' },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/completed',
      params: {
        threadId: 'thread-commentary',
        item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: 'done' },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-commentary', turn: { id: 'turn-commentary', status: 'completed' } },
    }) + '\\n');
    return;
  }

  process.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'unexpected method' } }) + '\\n');
});`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script, { mode: 0o755 });

    const activities: string[] = [];
    const result = await doCodexStream(baseOpts('codex', {
      onText: (_text, _thinking, activity) => {
        if (activity?.trim()) activities.push(activity);
      },
    }));

    expect(result.ok).toBe(true);
    expect(result.activity).toContain('KEEP_THIS_VISIBLE_AT_THE_END');
    expect(activities.some(activity => activity.includes('KEEP_THIS_VISIBLE_AT_THE_END'))).toBe(true);

    // --- runs codex turns in parallel across sessions ---
    shutdownCodexServer();

    const spawnLog = path.join(tmpDir, 'codex-app-server-spawns.log');
    const script2 = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const spawnLog = ${JSON.stringify(spawnLog)};
fs.appendFileSync(spawnLog, String(process.pid) + '\\n');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let threadSeq = 0;
let turnSeq = 0;
let busy = false;
const queue = [];

function flush(line) {
  process.stdout.write(JSON.stringify(line) + '\\n');
}

function runTurn(threadId, turnId) {
  busy = true;
  flush({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
  setTimeout(() => {
    const msgId = 'msg-' + turnId;
    flush({ method: 'item/started', params: { threadId, item: { id: msgId, type: 'agentMessage', phase: 'final_answer' } } });
    flush({ method: 'item/agentMessage/delta', params: { threadId, itemId: msgId, delta: 'done ' + threadId } });
    flush({ method: 'item/completed', params: { threadId, item: { id: msgId, type: 'agentMessage', phase: 'final_answer', text: 'done ' + threadId } } });
    flush({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    busy = false;
    const next = queue.shift();
    if (next) next();
  }, 400);
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.method === 'initialize') {
    flush({ id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'thread/start') {
    const threadId = 'thread-' + process.pid + '-' + (++threadSeq);
    flush({ id: msg.id, result: { thread: { id: threadId }, model: msg.params.model || 'gpt-5.4' } });
    return;
  }

  if (msg.method === 'turn/start') {
    const threadId = msg.params.threadId;
    const turnId = 'turn-' + (++turnSeq);
    flush({ id: msg.id, result: { turn: { id: turnId } } });
    const start = () => runTurn(threadId, turnId);
    if (busy) queue.push(start);
    else start();
    return;
  }

  if (msg.method === 'turn/interrupt') {
    flush({ id: msg.id, result: { ok: true } });
    return;
  }

  flush({ id: msg.id, error: { message: 'unexpected method' } });
});`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script2, { mode: 0o755 });

    const startedAt = Date.now();
    const [first, second] = await Promise.all([
      doCodexStream(baseOpts('codex', { prompt: 'parallel a' })),
      doCodexStream(baseOpts('codex', { prompt: 'parallel b' })),
    ]);
    const elapsedMs = Date.now() - startedAt;

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.message).toContain('done thread-');
    expect(second.message).toContain('done thread-');
    expect(elapsedMs).toBeLessThan(1200);

    const spawns = fs.readFileSync(spawnLog, 'utf-8').trim().split('\n').filter(Boolean);
    expect(spawns).toHaveLength(2);
  });
});

describe('gemini stream', () => {
  it('injects MCP through temporary Gemini settings and enables full-access defaults', async () => {
    const argvFile = path.join(tmpDir, 'gemini-argv.json');
    const envFile = path.join(tmpDir, 'gemini-env.json');
    const copiedSettingsFile = path.join(tmpDir, 'gemini-settings-copy.json');
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || '';
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
}));
if (settingsPath && fs.existsSync(settingsPath)) {
  fs.copyFileSync(settingsPath, ${JSON.stringify(copiedSettingsFile)});
}
process.stdout.write(JSON.stringify({ type: 'init', session_id: 'gemini-session', model: 'gemini-2.5-pro' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', delta: true, content: 'Gemini ok' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: 'gemini-session', status: 'success' }) + '\\n');
`;
    fs.writeFileSync(path.join(fakeBin, 'gemini'), script, { mode: 0o755 });

    const result = await doStream(baseOpts('gemini', {
      geminiModel: 'gemini-2.5-pro',
      mcpSendFile: async () => ({ ok: true }),
    }));

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('gemini-session');
    expect(result.message).toBe('Gemini ok');
    expect(result.contextWindow).toBe(1_048_576);

    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf-8'));
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--approval-mode');
    expect(argv).toContain('yolo');
    expect(argv).toContain('--sandbox');
    expect(argv).toContain('false');
    expect(argv).not.toContain('--mcp-config');

    const env = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
    expect(typeof env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe('string');
    expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toContain('gemini-system-settings.json');

    const settings = JSON.parse(fs.readFileSync(copiedSettingsFile, 'utf-8'));
    expect(settings.mcpServers?.pikiclaw?.command).toBeTruthy();
    expect(settings.mcpServers?.pikiclaw?.env?.MCP_CALLBACK_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(settings.mcpServers?.pikiclaw?.trust).toBe(true);
  });

  it('does not duplicate Gemini approval or sandbox flags when extra args already override them', async () => {
    const argvFile = path.join(tmpDir, 'gemini-argv-override.json');
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: 'init', session_id: 'gemini-session-override', model: 'gemini-2.5-pro' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', delta: true, content: 'Gemini override ok' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: 'gemini-session-override', status: 'success' }) + '\\n');
`;
    fs.writeFileSync(path.join(fakeBin, 'gemini'), script, { mode: 0o755 });

    const result = await doStream(baseOpts('gemini', {
      geminiApprovalMode: 'yolo',
      geminiSandbox: false,
      geminiExtraArgs: ['--approval-mode', 'default', '--sandbox', 'true'],
    }));

    expect(result.ok).toBe(true);

    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf-8'));
    expect(argv.filter((arg: string) => arg === '--approval-mode')).toHaveLength(1);
    expect(argv.filter((arg: string) => arg === '--sandbox')).toHaveLength(1);
    expect(argv).toContain('default');
    expect(argv).toContain('true');
  });

  it('computes Gemini context percent from model fallback and input-side tokens', async () => {
    writeFakeScript('gemini', [
      { type: 'init', session_id: 'gemini-ctx', model: 'gemini-2.5-pro' },
      { type: 'message', role: 'assistant', delta: true, content: 'OK' },
      { type: 'result', session_id: 'gemini-ctx', status: 'success', stats: { input_tokens: 9302, output_tokens: 50, cached: 132, total_tokens: 9484 } },
    ]);

    const result = await doGeminiStream(baseOpts('gemini', {
      geminiModel: 'gemini-2.5-pro',
    }));

    expect(result.ok).toBe(true);
    expect(result.contextWindow).toBe(1_048_576);
    expect(result.contextUsedTokens).toBe(9434);
    expect(result.contextPercent).toBe(0.9);
  });
});

describe('claude stream', () => {
  it('parses text, thinking, tool activity, retries expired sessions, and marks edge cases correctly', async () => {
    const activities: string[] = [];
    writeFakeScript('claude', [
      { type: 'system', session_id: 's-tools', model: 'claude-opus-4-6', thinking_level: 'high' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-read-1', name: 'Read', input: { file_path: 'src/bot.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-read-1', content: 'file contents', is_error: false },
          ],
        },
        tool_use_result: { stdout: 'file contents', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
      },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Hmm...' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } } },
      { type: 'result', session_id: 's-tools', usage: { input_tokens: 150, cache_read_input_tokens: 30, output_tokens: 60 }, modelUsage: { 'claude-opus-4-6': { contextWindow: 200000, maxOutputTokens: 64000 } } },
    ]);

    const parsed = await doClaudeStream(baseOpts('claude', {
      onText: (_text, _thinking, activity) => {
        if (activity) activities.push(activity);
      },
    }));
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toBe('Hello world');
    expect(parsed.thinking).toBe('Hmm...');
    expect(parsed.model).toBe('claude-opus-4-6');
    expect(parsed.thinkingEffort).toBe('high');
    expect(parsed.inputTokens).toBe(150);
    expect(parsed.cachedInputTokens).toBe(30);
    expect(parsed.outputTokens).toBe(60);
    expect(parsed.contextWindow).toBe(200000);
    expect(parsed.activity).toContain('Read src/bot.ts');
    expect(activities.some(activity => activity.includes('Read src/bot.ts done'))).toBe(true);

    const claudePreviewPercents: Array<number | null> = [];
    writeFakeScript('claude', [
      { type: 'system', session_id: 's-ctx', model: 'claude-opus-4-6' },
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 25000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ctx' } } },
      { type: 'result', session_id: 's-ctx', usage: { input_tokens: 25000, cache_read_input_tokens: 1000, output_tokens: 1 } },
    ]);

    const claudeFallback = await doClaudeStream(baseOpts('claude', {
      onText: (_text, _thinking, _activity, meta) => {
        if (meta) claudePreviewPercents.push(meta.contextPercent);
      },
    }));
    expect(claudeFallback.ok).toBe(true);
    expect(claudeFallback.contextWindow).toBe(200000);
    expect(claudeFallback.contextPercent).toBe(13);
    expect(claudePreviewPercents).toContain(13);

    writeFakeScript('claude', [
      { type: 'system', session_id: 's2' },
      { type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'Deep thought' },
        { type: 'text', text: 'Final answer' },
      ] } },
      { type: 'result', session_id: 's2' },
    ]);

    const fallback = await doClaudeStream(baseOpts('claude'));
    expect(fallback.ok).toBe(true);
    expect(fallback.message).toBe('Final answer');
    expect(fallback.thinking).toBe('Deep thought');

    // --- retries expired sessions and marks incomplete states and edge cases ---
    const stateFile = path.join(tmpDir, 'call_count');
    fs.writeFileSync(stateFile, '0');
    const retryScript = `#!/bin/sh
COUNT=$(cat ${stateFile})
COUNT=$((COUNT + 1))
echo $COUNT > ${stateFile}
if [ "$COUNT" = "1" ]; then
  echo '${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'new-sess', errors: ['No conversation found with session ID: old-sess'] })}'
else
  echo '${JSON.stringify({ type: 'system', session_id: 'new-sess', model: 'claude-opus-4-6' })}'
  echo '${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fresh start' } } })}'
  echo '${JSON.stringify({ type: 'result', session_id: 'new-sess', usage: { input_tokens: 10, output_tokens: 5 } })}'
fi`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), retryScript, { mode: 0o755 });

    const retried = await doClaudeStream(baseOpts('claude', { sessionId: 'old-sess' }));
    expect(retried.ok).toBe(true);
    expect(retried.message).toBe('Fresh start');
    expect(retried.sessionId).toBe('new-sess');
    expect(fs.readFileSync(stateFile, 'utf-8').trim()).toBe('2');

    writeFakeScript('claude', [
      { type: 'result', is_error: true, errors: ['Rate limit exceeded'] },
    ]);
    const errored = await doClaudeStream(baseOpts('claude'));
    expect(errored.ok).toBe(false);
    expect(errored.message).toBe('Rate limit exceeded');
    expect(errored.error).toBe('Rate limit exceeded');
    expect(errored.incomplete).toBe(true);

    writeFakeScript('claude', [
      { type: 'system', session_id: 's-max' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Long answer...' } } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 999 } } },
      { type: 'result', session_id: 's-max' },
    ]);
    const maxed = await doClaudeStream(baseOpts('claude'));
    expect(maxed.ok).toBe(true);
    expect(maxed.stopReason).toBe('max_tokens');
    expect(maxed.incomplete).toBe(true);

    const partialScript = `#!/bin/sh
echo '${JSON.stringify({ type: 'system', session_id: 's-partial' })}'
echo '${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial answer' } } })}'
echo "quota exceeded" >&2
exit 1`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), partialScript, { mode: 0o755 });
    const partial = await doClaudeStream(baseOpts('claude'));
    expect(partial.ok).toBe(false);
    expect(partial.message).toBe('Partial answer');
    expect(partial.error).toBe('quota exceeded');
    expect(partial.incomplete).toBe(true);

    fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 0', { mode: 0o755 });
    const empty = await doClaudeStream(baseOpts('claude'));
    expect(empty.ok).toBe(true);
    expect(empty.message).toBe('(no textual response)');
  });
});

describe('doStream and attachments', () => {
  it('routes to claude, clears stale manifests, and uses stream-json attachments only when needed', async () => {
    writeFakeScript('claude', [
      { type: 'system', session_id: 's-unified' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'via claude' } } },
      { type: 'result', session_id: 's-unified' },
    ]);

    const staged = stageSessionFiles({
      agent: 'claude',
      workdir: tmpDir,
      files: [],
    });
    const manifestPath = path.join(tmpDir, '.pikiclaw', 'sessions', 'claude', staged.sessionId, 'return.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      files: [{ path: 'README.md', kind: 'document', caption: 'stale artifact' }],
    }, null, 2));

    const routed = await doStream(baseOpts('claude', {
      sessionId: staged.sessionId,
      prompt: 'new turn without artifacts',
    }));
    expect(routed.ok).toBe(true);
    expect(routed.message).toBe('via claude');

    const argsFile = path.join(tmpDir, 'claude-args.txt');
    const stdinFile = path.join(tmpDir, 'claude-stdin.txt');
    const attachmentScript = `#!/bin/sh
echo "$@" > ${argsFile}
cat > ${stdinFile}
echo '{"type":"system","session_id":"s-file"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}'
echo '{"type":"result","session_id":"s-file"}'`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), attachmentScript, { mode: 0o755 });

    const imgPath = path.join(tmpDir, 'test.png');
    fs.writeFileSync(imgPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));

    const withImage = await doClaudeStream(baseOpts('claude', {
      attachments: [imgPath],
    }));
    expect(withImage.ok).toBe(true);
    expect(fs.readFileSync(argsFile, 'utf-8')).toContain('--input-format');
    const imageInput = JSON.parse(fs.readFileSync(stdinFile, 'utf-8').trim());
    expect(imageInput.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image' }),
      expect.objectContaining({ type: 'text' }),
    ]));

    const withDoc = await doClaudeStream(baseOpts('claude', {
      attachments: ['/tmp/doc.pdf'],
    }));
    expect(withDoc.ok).toBe(true);
    const docInput = JSON.parse(fs.readFileSync(stdinFile, 'utf-8').trim());
    expect(docInput.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('/tmp/doc.pdf') }),
    ]));

    const emptyArgsFile = path.join(tmpDir, 'claude-empty-args.txt');
    const emptyScript = `#!/bin/sh
echo "$@" > ${emptyArgsFile}
echo '{"type":"system","session_id":"s-no"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}'
echo '{"type":"result","session_id":"s-no"}'`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), emptyScript, { mode: 0o755 });

    const withoutAttachments = await doClaudeStream(baseOpts('claude', { attachments: [] }));
    expect(withoutAttachments.ok).toBe(true);
    expect(fs.readFileSync(emptyArgsFile, 'utf-8')).not.toContain('--input-format');
  });
});

describe('listModels, getUsage, and getSessionTail', () => {
  it('returns structured model and usage data and falls back to codex rollout files for session history', async () => {
    await withTempHome(async homeDir => {
      fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
        projects: {
          [tmpDir]: {
            lastModelUsage: {
              'claude-haiku-4-5-20250929': { costUSD: 0.1 },
            },
          },
        },
      }));
      const projectDir = path.join(homeDir, '.claude', 'projects', tmpDir.replace(/\//g, '-'));
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'sess.jsonl'), [
        JSON.stringify({ type: 'user', message: { content: 'hello' } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5-20250929' } }),
      ].join('\n'));

      const helpScript = `#!/bin/sh
if [ "$1" = "--help" ]; then
  cat <<'EOF'
--model <model>  Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-5-20250929').
EOF
  exit 0
fi
exit 0`;
      fs.writeFileSync(path.join(fakeBin, 'claude'), helpScript, { mode: 0o755 });

      const claudeModels = await listModels('claude', {
        workdir: tmpDir,
        currentModel: 'claude-opus-4-6',
      });
      expect(claudeModels.models.map(m => m.id)).toEqual([
        'claude-opus-4-6',
        'claude-opus-4-6[1m]',
        'claude-sonnet-4-6',
        'claude-sonnet-4-6[1m]',
        'claude-haiku-4-5-20251001',
      ]);

      const codexModels = await listModels('codex', {
        workdir: tmpDir,
        currentModel: 'gpt-5.4',
      });
      expect(codexModels.agent).toBe('codex');
      expect(Array.isArray(codexModels.models)).toBe(true);
      expect(Array.isArray(codexModels.sources)).toBe(true);

      const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '03', '08');
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, 'usage.jsonl'), [
        JSON.stringify({ type: 'session_meta', payload: { id: 'sess-usage' } }),
        JSON.stringify({
          timestamp: '2026-03-08T01:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: {
              primary: {
                used_percent: 27,
                window_minutes: 300,
                reset_after_seconds: 7200,
                resets_at: 2000000000,
              },
              secondary: {
                used_percent: 61,
                window_minutes: 10080,
                reset_after_seconds: 86400,
                resets_at: 2000086400,
              },
            },
          },
        }),
      ].join('\n'));

      const codexUsage = getUsage({ agent: 'codex' });
      expect(codexUsage.ok).toBe(true);
      expect(codexUsage.source).toBe('session-history');
      expect(codexUsage.windows.map(w => w.label)).toEqual(['5h', '7d']);

      const telemetryDir = path.join(homeDir, '.claude', 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(path.join(telemetryDir, 'events.json'), [
        JSON.stringify({
          event_type: 'ClaudeCodeInternalEvent',
          event_data: {
            event_name: 'tengu_claudeai_limits_status_changed',
            client_timestamp: '2026-03-08T04:00:00.000Z',
            model: 'claude-sonnet-4-6',
            additional_metadata: JSON.stringify({ status: 'allowed', hoursTillReset: 2 }),
          },
        }),
        JSON.stringify({
          event_type: 'ClaudeCodeInternalEvent',
          event_data: {
            event_name: 'tengu_claudeai_limits_status_changed',
            client_timestamp: '2026-03-08T03:00:00.000Z',
            model: 'claude-opus-4-6',
            additional_metadata: JSON.stringify({ status: 'allowed_warning', hoursTillReset: 39 }),
          },
        }),
      ].join('\n'));

      const claudeUsage = getUsage({ agent: 'claude', model: 'claude-opus-4-6' });
      expect(claudeUsage.ok).toBe(true);
      expect(claudeUsage.source).toBe('telemetry');
      expect(claudeUsage.status).toBe('warning');
      expect(claudeUsage.windows[0].status).toBe('warning');
      expect(claudeUsage.windows[0].resetAfterSeconds).toBe(39 * 3600);

      // --- getSessionTail: falls back to codex rollout files ---
      const emptyBin = makeTmpDir('pikiclaw-empty-bin-');
      const oldPath = process.env.PATH;
      process.env.PATH = emptyBin;
      try {
        const workdir = path.join(homeDir, 'project');
        fs.mkdirSync(workdir, { recursive: true });

        const tailSessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '03', '12');
        fs.mkdirSync(tailSessionsDir, { recursive: true });
        fs.writeFileSync(path.join(tailSessionsDir, 'rollout-2026-03-12T00-00-00-test.jsonl'), [
          JSON.stringify({
            type: 'session_meta',
            payload: { id: 'sess-fallback', cwd: workdir },
          }),
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'first question' },
          }),
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'first answer' },
          }),
        ].join('\n'));

        const tail = await getSessionTail({
          agent: 'codex',
          sessionId: 'sess-fallback',
          workdir,
          limit: 4,
        });

        expect(tail).toEqual({
          ok: true,
          messages: [
            { role: 'user', text: 'first question' },
            { role: 'assistant', text: 'first answer' },
          ],
          error: null,
        });
      } finally {
        process.env.PATH = oldPath;
      }
    });
  });
});
