/**
 * E2E test for artifact return — hits real claude CLI + real Telegram API.
 *
 * Requires:
 *   - `claude` CLI installed and authenticated
 *   - TELEGRAM_BOT_TOKEN env var set
 *   - TELEGRAM_TEST_CHAT_ID env var (optional, auto-detected from recent messages)
 *
 * Run:  npx vitest run test/artifact-return.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { doClaudeStream, type StreamOpts } from '../src/code-agent.ts';
import { buildArtifactPrompt, collectArtifacts } from '../src/bot-telegram.ts';
import { TelegramChannel } from '../src/channel-telegram.ts';

function hasCmd(cmd: string): boolean {
  try { execSync(`which ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

const HAS_CLAUDE = hasCmd('claude');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
let CHAT_ID = parseInt(process.env.TELEGRAM_TEST_CHAT_ID ?? '', 10);
const SKIP = !HAS_CLAUDE || !TOKEN;

if (SKIP) {
  const missing: string[] = [];
  if (!HAS_CLAUDE) missing.push('claude CLI');
  if (!TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  console.warn(
    `\n⚠  ${missing.join(' + ')} not available — artifact return E2E tests will be SKIPPED.\n`,
  );
}

const ARTIFACT_MANIFEST = 'manifest.json';

function baseOpts(extra: Partial<StreamOpts> = {}): StreamOpts {
  return {
    agent: 'claude',
    prompt: '',
    workdir: process.cwd(),
    timeout: 120,
    sessionId: null,
    model: null,
    thinkingEffort: 'low',
    onText: () => {},
    claudePermissionMode: 'bypassPermissions',
    ...extra,
  };
}

let ch: TelegramChannel;
let tmpDir: string;

describe.skipIf(SKIP)('artifact return e2e', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-e2e-'));
    ch = new TelegramChannel({ token: TOKEN, workdir: tmpDir });
    await ch.connect();

    // Auto-detect chat ID if not provided
    if (!CHAT_ID || Number.isNaN(CHAT_ID)) {
      const detected = await ch.getRecentChatId();
      if (!detected) throw new Error('Cannot auto-detect TELEGRAM_TEST_CHAT_ID — send a message to the bot first');
      CHAT_ID = detected;
    }
    console.log(`artifact-return e2e: chat_id=${CHAT_ID}`);
  });

  afterAll(() => {
    ch?.disconnect();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('claude creates artifacts and sends them to Telegram', async () => {
    // 1. Prepare artifact directory
    const artifactDir = path.join(tmpDir, 'artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    const manifestPath = path.join(artifactDir, ARTIFACT_MANIFEST);

    // 2. Ask real claude to create files + manifest
    const prompt = buildArtifactPrompt(
      [
        'Create the following files in the artifact directory provided:',
        '1. A small valid PNG image file named "screenshot.png" (create a minimal valid PNG using printf with raw bytes or python)',
        '2. A plain text file named "console.txt" containing the text "hello from artifact test"',
        'Then write the manifest.json as instructed.',
        'Use "photo" kind for the PNG and "document" kind for the text file.',
        'Add caption "Test screenshot" for the PNG and "Console output" for the text file.',
        'Reply with exactly: ARTIFACTS_CREATED',
      ].join('\n'),
      artifactDir,
      manifestPath,
    );

    const result = await doClaudeStream(baseOpts({
      prompt,
      workdir: tmpDir,
      timeout: 120,
    }));

    expect(result.ok).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);

    // 3. Collect artifacts using real collectArtifacts
    const logs: string[] = [];
    const artifacts = collectArtifacts(artifactDir, manifestPath, msg => logs.push(msg));
    expect(artifacts).toHaveLength(2);

    const pngArtifact = artifacts.find(a => a.filename === 'screenshot.png');
    expect(pngArtifact).toBeDefined();
    expect(pngArtifact!.kind).toBe('photo');

    const txtArtifact = artifacts.find(a => a.filename === 'console.txt');
    expect(txtArtifact).toBeDefined();
    expect(txtArtifact!.kind).toBe('document');

    // 4. Send artifacts to Telegram using real channel.sendFile — same path as bot-telegram.ts sendArtifacts
    const sentIds: number[] = [];
    for (const artifact of artifacts) {
      const msgId = await ch.sendFile(CHAT_ID, artifact.filePath, {
        caption: artifact.caption,
        asPhoto: artifact.kind === 'photo',
      });
      expect(msgId).toBeTruthy();
      sentIds.push(msgId!);
    }

    // Should have sent 2 messages (1 photo + 1 document)
    expect(sentIds).toHaveLength(2);
    console.log(`artifact-return e2e: sent ${sentIds.length} artifacts to Telegram (msg IDs: ${sentIds.join(', ')})`);
  }, 120_000);
});
