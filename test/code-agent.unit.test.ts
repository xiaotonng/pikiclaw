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
  listPikiclawSessions,
  listModels,
  mergeManagedAndNativeSessions,
  promoteSessionId,
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

  it('prefers native session metadata while keeping pikiclaw workspace and run state', () => {
    const merged = mergeManagedAndNativeSessions([
      {
        sessionId: 'sess-1',
        agent: 'codex',
        workdir: tmpDir,
        workspacePath: '/tmp/pikiclaw/workspace',
        model: 'local-model',
        createdAt: '2026-03-16T00:00:00.000Z',
        title: 'local title',
        running: false,
        runState: 'incomplete',
        runDetail: 'local detail',
        runUpdatedAt: '2026-03-16T00:02:00.000Z',
      },
    ], [
      {
        sessionId: 'sess-1',
        agent: 'codex',
        workdir: tmpDir,
        workspacePath: null,
        model: 'native-model',
        createdAt: '2026-03-16T00:01:00.000Z',
        title: 'native title',
        running: true,
        runState: 'completed',
        runDetail: null,
        runUpdatedAt: '2026-03-16T00:01:30.000Z',
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      sessionId: 'sess-1',
      title: 'native title',
      model: 'native-model',
      createdAt: '2026-03-16T00:01:00.000Z',
      workspacePath: '/tmp/pikiclaw/workspace',
      running: true,
      runState: 'incomplete',
      runDetail: 'local detail',
      runUpdatedAt: '2026-03-16T00:02:00.000Z',
    });
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

  it('uses the first question line as the new session title prefix', () => {
    const staged = stageSessionFiles({
      agent: 'claude',
      workdir: tmpDir,
      files: [],
      title: '第一行问题前缀\n第二行补充说明\n第三行细节',
    });

    const record = listPikiclawSessions(tmpDir, 'claude').find(entry => entry.sessionId === staged.sessionId);
    expect(record?.title).toBe('第一行问题前缀');
  });

  it('promotes pending sessions without leaving stale pending records or breaking old workspace paths', () => {
    const workdir = makeTmpDir('pikiclaw-promote-');
    const uploadDir = makeTmpDir('pikiclaw-image-');
    const uploadPath = path.join(uploadDir, 'shot.jpg');
    fs.writeFileSync(uploadPath, 'image-bytes');

    const staged = stageSessionFiles({
      agent: 'codex',
      workdir,
      files: [uploadPath],
      title: 'inspect image',
    });

    const oldFilePath = path.join(staged.workspacePath, 'shot.jpg');
    expect(fs.existsSync(oldFilePath)).toBe(true);

    promoteSessionId(workdir, 'codex', staged.sessionId, 'thread-native');

    const nativeWorkspace = path.join(workdir, '.pikiclaw', 'sessions', 'codex', 'thread-native', 'workspace');
    expect(fs.existsSync(path.join(nativeWorkspace, 'shot.jpg'))).toBe(true);
    expect(fs.existsSync(oldFilePath)).toBe(true);

    const records = listPikiclawSessions(workdir, 'codex');
    expect(records.map(entry => entry.sessionId)).toContain('thread-native');
    expect(records.map(entry => entry.sessionId)).not.toContain(staged.sessionId);
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
    expect(result3.contextUsedTokens).toBe(11542);
    expect(result3.contextPercent).toBe(4.5);
    expect(previewMeta.some(meta => meta?.contextPercent === 4.5)).toBe(true);
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
    expect(settings.fileFiltering).toEqual({
      respectGitIgnore: false,
      respectGeminiIgnore: false,
    });
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

  it('parses Gemini tool_use and tool_result events into readable activity previews', async () => {
    const activities: string[] = [];
    writeFakeScript('gemini', [
      { type: 'init', session_id: 'gemini-tools', model: 'gemini-2.5-pro' },
      { type: 'tool_use', tool_name: 'list_directory', tool_id: 'tool-1', parameters: { dir_path: '.' } },
      { type: 'tool_result', tool_id: 'tool-1', status: 'success', output: 'Listed 38 item(s). (2 ignored)' },
      { type: 'message', role: 'assistant', delta: true, content: 'Done' },
      { type: 'result', session_id: 'gemini-tools', status: 'success' },
    ]);

    const result = await doGeminiStream(baseOpts('gemini', {
      onText: (_text, _thinking, activity) => {
        if (activity) activities.push(activity);
      },
    }));

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Done');
    expect(result.activity).toContain('List files: .');
    expect(result.activity).toContain('List files: . -> Listed 38 item(s). (2 ignored)');
    expect(activities.some(activity => activity.includes('List files: . -> Listed 38 item(s). (2 ignored)'))).toBe(true);
  });

  it('normalizes structured Gemini result errors without crashing', async () => {
    writeFakeScript('gemini', [
      { type: 'init', session_id: 'gemini-error', model: 'gemini-2.5-pro' },
      {
        type: 'result',
        session_id: 'gemini-error',
        status: 'error',
        error: { type: 'FatalCancellationError', message: 'Operation cancelled.' },
      },
    ]);

    const result = await doGeminiStream(baseOpts('gemini'));

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Operation cancelled.');
    expect(result.error).toBe('Operation cancelled.');
    expect(result.incomplete).toBe(true);
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
    expect(claudeFallback.contextWindow).toBe(1000000);
    expect(claudeFallback.contextPercent).toBe(2.6);
    expect(claudePreviewPercents).toContain(2.6);

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

  it('exposes in-process Claude steering and keeps only the latest steered response', async () => {
    const argsFile = path.join(tmpDir, 'claude-steer-args.txt');
    const inputsFile = path.join(tmpDir, 'claude-steer-inputs.jsonl');
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join(' '));
let inputCount = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  fs.appendFileSync(${JSON.stringify(inputsFile)}, line + '\\n');
  inputCount += 1;
  if (inputCount === 1) {
    process.stdout.write(JSON.stringify({ type: 'system', session_id: 's-steer', model: 'claude-sonnet-4-6' }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'First answer' } },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        type: 'result',
        session_id: 's-steer',
        usage: { input_tokens: 10, output_tokens: 4 },
      }) + '\\n');
    }, 150);
    return;
  }
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Updated answer' } },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'result',
      session_id: 's-steer',
      usage: { input_tokens: 12, output_tokens: 5 },
    }) + '\\n');
    process.exit(0);
  }, 220);
});
rl.on('close', () => setTimeout(() => process.exit(0), 30));`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), script, { mode: 0o755 });

    let steer: ((prompt: string, attachments?: string[]) => Promise<boolean>) | null = null;
    const streamPromise = doClaudeStream(baseOpts('claude', {
      onSteerReady: value => { steer = value; },
    }));

    const deadline = Date.now() + 1500;
    while (!steer && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const notesPath = path.join(tmpDir, 'notes.txt');
    const steered = await steer?.('change direction', [notesPath]);
    expect(steered).toBe(true);

    const result = await streamPromise;
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('s-steer');
    expect(result.message).toBe('Updated answer');

    const argv = fs.readFileSync(argsFile, 'utf-8');
    expect(argv).toContain('--input-format');
    expect(argv).toContain('--replay-user-messages');

    const inputs = fs.readFileSync(inputsFile, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.message?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'test prompt' }),
    ]));
    expect(inputs[1]?.message?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining(notesPath) }),
      expect.objectContaining({ type: 'text', text: 'change direction' }),
    ]));
  });

  it('auto-closes Claude stdin after a coalesced steered result without dropping the answer', async () => {
    const inputsFile = path.join(tmpDir, 'claude-steer-coalesced-inputs.jsonl');
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
let inputCount = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  fs.appendFileSync(${JSON.stringify(inputsFile)}, line + '\\n');
  inputCount += 1;
  if (inputCount === 1) {
    process.stdout.write(JSON.stringify({ type: 'system', session_id: 's-coalesced', model: 'claude-sonnet-4-6' }) + '\\n');
    return;
  }
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: 'stream_event',
      session_id: 's-coalesced',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Steered final answer' } },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'result',
      session_id: 's-coalesced',
      usage: { input_tokens: 11, output_tokens: 4 },
    }) + '\\n');
  }, 120);
});
rl.on('close', () => process.exit(0));`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), script, { mode: 0o755 });

    let steer: ((prompt: string, attachments?: string[]) => Promise<boolean>) | null = null;
    const streamPromise = doClaudeStream(baseOpts('claude', {
      onSteerReady: value => { steer = value; },
    }));

    const deadline = Date.now() + 1500;
    while (!steer && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const steered = await steer?.('narrow it down');
    expect(steered).toBe(true);

    const result = await streamPromise;
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('s-coalesced');
    expect(result.message).toBe('Steered final answer');
    expect(result.elapsedS).toBeLessThan(3);

    const inputs = fs.readFileSync(inputsFile, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    expect(inputs).toHaveLength(2);
  });

  it('exposes the native codex session id before the turn finishes', async () => {
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
      result: { thread: { id: 'thread-early' }, model: msg.params.model || 'gpt-5.4' },
    }) + '\\n');
    return;
  }

  if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-early' } } }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-early', turn: { id: 'turn-early' } },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        method: 'item/started',
        params: { threadId: 'thread-early', item: { id: 'msg-early', type: 'agentMessage', phase: 'final_answer' } },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-early', itemId: 'msg-early', delta: 'done' },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-early', turn: { id: 'turn-early', status: 'completed' } },
      }) + '\\n');
    }, 150);
    return;
  }

  process.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'unexpected method' } }) + '\\n');
});`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script, { mode: 0o755 });

    let reportedSessionId: string | null = null;
    const streamPromise = doCodexStream(baseOpts('codex', {
      onSessionId: sessionId => { reportedSessionId = sessionId; },
    }));

    const deadline = Date.now() + 1500;
    while (!reportedSessionId && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    expect(reportedSessionId).toBe('thread-early');

    const result = await streamPromise;
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('thread-early');
  });

  it('exposes native codex steering and forwards steer input to turn/steer', async () => {
    const callsFile = path.join(tmpDir, 'codex-steer-calls.jsonl');
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const callsFile = ${JSON.stringify(callsFile)};
let completed = false;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const finishTurn = () => {
  if (completed) return;
  completed = true;
  process.stdout.write(JSON.stringify({
    method: 'item/started',
    params: { threadId: 'thread-steer', item: { id: 'msg-steer', type: 'agentMessage', phase: 'final_answer' } },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-steer', itemId: 'msg-steer', delta: 'done' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    method: 'turn/completed',
    params: { threadId: 'thread-steer', turn: { id: 'turn-steer', status: 'completed' } },
  }) + '\\n');
};
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  fs.appendFileSync(callsFile, JSON.stringify(msg) + '\\n');

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
    return;
  }

  if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { thread: { id: 'thread-steer' }, model: msg.params.model || 'gpt-5.4' },
    }) + '\\n');
    return;
  }

  if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-steer' } } }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'turn/started',
      params: { threadId: 'thread-steer', turn: { id: 'turn-steer' } },
    }) + '\\n');
    setTimeout(finishTurn, 200);
    return;
  }

  if (msg.method === 'turn/steer') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turnId: 'turn-steer' } }) + '\\n');
    return;
  }

  process.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'unexpected method' } }) + '\\n');
});`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script, { mode: 0o755 });

    let control: { turnId: string; steer: (prompt: string, attachments?: string[]) => Promise<boolean> } | null = null;
    const streamPromise = doCodexStream(baseOpts('codex', {
      onCodexTurnReady: value => { control = value; },
    }));

    const deadline = Date.now() + 1500;
    while (!control && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    expect(control?.turnId).toBe('turn-steer');
    const steered = await control!.steer('switch direction', [path.join(tmpDir, 'notes.txt')]);
    expect(steered).toBe(true);

    const result = await streamPromise;
    expect(result.ok).toBe(true);

    const calls = fs.readFileSync(callsFile, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const steerCall = calls.find(call => call.method === 'turn/steer');
    expect(steerCall?.params).toEqual({
      threadId: 'thread-steer',
      expectedTurnId: 'turn-steer',
      input: buildCodexTurnInput('switch direction', [path.join(tmpDir, 'notes.txt')]),
    });
  });

  it('surfaces raw response items like web search calls in codex activity', async () => {
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
      result: { thread: { id: 'thread-raw' }, model: msg.params.model || 'gpt-5.4' },
    }) + '\\n');
    return;
  }

  if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-raw' } } }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-raw',
        turnId: 'turn-raw',
        item: { type: 'web_search_call', action: { type: 'search', query: 'latest gold price' } },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-raw', turn: { id: 'turn-raw', status: 'completed' } },
    }) + '\\n');
    return;
  }

  process.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'unexpected method' } }) + '\\n');
});`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script, { mode: 0o755 });

    const result = await doCodexStream(baseOpts('codex'));
    expect(result.ok).toBe(true);
    expect(result.activity).toContain('Search web: latest gold price');
  });
});

describe('doStream and attachments', () => {
  it('promotes codex sessions to native ids and keeps the native workspace path', async () => {
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
      result: { thread: { id: 'thread-native' }, model: msg.params.model || 'gpt-5.4' },
    }) + '\\n');
    return;
  }

  if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-native' } } }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'turn/started',
      params: { threadId: 'thread-native', turn: { id: 'turn-native' } },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/started',
      params: { threadId: 'thread-native', item: { id: 'msg-native', type: 'agentMessage', phase: 'final_answer' } },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-native', itemId: 'msg-native', delta: 'done' },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
    }) + '\\n');
    return;
  }

  process.stdout.write(JSON.stringify({ id: msg.id, error: { message: 'unexpected method' } }) + '\\n');
});`;
    fs.writeFileSync(path.join(fakeBin, 'codex'), script, { mode: 0o755 });

    const result = await doStream(baseOpts('codex', { prompt: '给我讲故事' }));
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('thread-native');
    expect(result.workspacePath).toBe(path.join(tmpDir, '.pikiclaw', 'sessions', 'codex', 'thread-native', 'workspace'));

    const record = listPikiclawSessions(tmpDir, 'codex').find(entry => entry.sessionId === 'thread-native');
    expect(record?.title).toBe('给我讲故事');
    expect(record?.workspacePath).toBe(path.join(tmpDir, '.pikiclaw', 'sessions', 'codex', 'thread-native', 'workspace'));
  });

  it('persists completed and incomplete run states in managed session records', async () => {
    writeFakeScript('claude', [
      { type: 'system', session_id: 'sess-status' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } } },
      { type: 'result', session_id: 'sess-status' },
    ]);

    const completed = await doStream(baseOpts('claude', { prompt: 'first pass' }));
    expect(completed.ok).toBe(true);

    let record = listPikiclawSessions(tmpDir, 'claude').find(entry => entry.sessionId === 'sess-status');
    expect(record?.runState).toBe('completed');
    expect(record?.runDetail).toBeNull();

    const partialScript = `#!/bin/sh
echo '${JSON.stringify({ type: 'system', session_id: 'sess-status' })}'
echo '${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial answer' } } })}'
echo "quota exceeded" >&2
exit 1`;
    fs.writeFileSync(path.join(fakeBin, 'claude'), partialScript, { mode: 0o755 });

    const incomplete = await doStream(baseOpts('claude', { sessionId: 'sess-status', prompt: 'second pass' }));
    expect(incomplete.ok).toBe(false);

    record = listPikiclawSessions(tmpDir, 'claude').find(entry => entry.sessionId === 'sess-status');
    expect(record?.runState).toBe('incomplete');
    expect(record?.runDetail).toContain('quota exceeded');
  });

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
        'claude-sonnet-4-6',
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
