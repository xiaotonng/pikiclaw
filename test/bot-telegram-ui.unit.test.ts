import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSwitchWorkdirView, resolveRegisteredPath } from '../src/bot-telegram-directory.ts';
import {
  buildCompactSelectionNotice,
  buildCompactSelectionTitle,
  buildStreamPreviewHtml,
  compactCode,
  formatMenuLines,
  formatProviderUsageLines,
  truncateMiddle,
} from '../src/bot-telegram-render.ts';
import { makeTmpDir } from './support/env.ts';

describe('bot-telegram render helpers', () => {
  // NOTE: renderSessionTurnHtml and buildFinalReplyRender are covered by
  // bot-telegram.unit.test.ts ("renders resumed history" and "compresses warnings").
  // Tests here focus on helpers not exercised through the bot integration tests.

  it('formats provider usage, compact selection, and stream previews', () => {
    // --- formats provider usage windows and menu command lines ---
    const usageLines = formatProviderUsageLines({
      ok: true,
      capturedAt: new Date(Date.now() - 5_000).toISOString(),
      status: 'ok',
      windows: [{
        label: 'Claude',
        usedPercent: 40,
        remainingPercent: 60,
        resetAfterSeconds: 120,
        status: 'rate_limited',
      }],
      error: null,
    });

    expect(usageLines.join('\n')).toContain('<b>Provider Usage</b>');
    expect(usageLines.join('\n')).toContain('Claude: 40% used status=rate_limited resetAfterSeconds=120');
    expect(formatMenuLines([{ command: 'status', description: 'Show status' }])[0]).toBe('/status — Show status');

    // --- keeps codex usage output in raw status form ---
    const codexUsageLines = formatProviderUsageLines({
      ok: true,
      capturedAt: null,
      status: null,
      windows: [
        {
          label: 'Primary',
          usedPercent: 82,
          remainingPercent: 18,
          resetAfterSeconds: 300,
          status: 'warning',
        },
        {
          label: 'Secondary',
          usedPercent: 0,
          remainingPercent: 100,
          resetAfterSeconds: null,
          status: 'allowed',
        },
      ],
      error: null,
    });

    expect(codexUsageLines.join('\n')).toContain('Primary: 82% used status=warning resetAfterSeconds=300');
    expect(codexUsageLines.join('\n')).toContain('Secondary: 0% used status=allowed');
    expect(formatMenuLines([{ command: 'status', description: 'Show status' }])[0]).toBe('/status — Show status');

    // --- builds compact selection copy and middle-truncated labels for mobile layouts ---
    const shortened = truncateMiddle('/Users/xiaoxiao/Desktop/work/pikiclaw/project', 24);
    expect(shortened).toContain('...');
    expect(shortened.startsWith('/Users')).toBe(true);
    expect(shortened.endsWith('project')).toBe(true);
    expect(compactCode('/Users/xiaoxiao/Desktop/work/pikiclaw/project', 24)).toContain('<code>');
    expect(buildCompactSelectionTitle('Agents', 'codex')).toBe('<b>Agents</b> · <code>codex</code>');
    expect(buildCompactSelectionNotice('Model', 'claude-sonnet-4-6', 'claude · session reset')).toContain('<b>Model</b>');

    // --- keeps longer activity visible when the preview has no body text ---
    const activity = [
      'I have the current release target: 0.2.24 to 0.2.25. I am about to patch the version in the package metadata, runtime constant, and the install skill examples.',
      'Updated 4 files',
      'The version bump is in place: 0.2.25 in runtime, package metadata, and the install skill examples. Next I am running the build and link verification commands.',
      'The build has started cleanly. I am waiting for TypeScript to finish before linking and version verification.',
      'The skill build/install verification passed: node dist/cli.js --version reports pikiclaw 0.2.25. I am checking the exact repo delta and the staged release workflow before cutting the tag.',
      'The worktree is large enough that building alone is a weak release gate. I am running the test suite before I cut the tag; if anything is red, I will stop and inspect the failure instead of pushing through.',
      'The release job succeeded on GitHub, and the Publish to npm step is explicitly green. I am replacing the auto-generated GitHub release text with a concise changelog and then I will wrap up.',
      'commands: 47 done',
    ].join('\n');

    const html = buildStreamPreviewHtml({
      agent: 'codex',
      elapsedMs: 293_000,
      bodyText: '',
      thinking: '',
      activity,
      meta: { contextPercent: 38.9 } as any,
      plan: null,
    });

    expect(html).toContain('The release job succeeded on GitHub');
    expect(html).not.toContain('\n...\n');
  });
});

describe('bot-telegram directory helpers', () => {
  it('builds switch workdir keyboards with resolvable callback ids', () => {
    const root = makeTmpDir('tg-dir-view-');
    fs.mkdirSync(path.join(root, 'alpha'));
    fs.mkdirSync(path.join(root, 'beta'));

    const view = buildSwitchWorkdirView(root, root, 0);
    expect(view.text).toContain('<b>Workdir</b>');
    expect(view.text).toContain('<code>');
    expect(view.text).toContain('●');
    expect(view.keyboard.inline_keyboard.length).toBeGreaterThanOrEqual(2);

    const childCallback = view.keyboard.inline_keyboard[0][0].callback_data;
    const childId = parseInt(childCallback.split(':')[2], 10);
    expect(resolveRegisteredPath(childId)).toBe(path.join(root, 'alpha'));

    const selectCallback = view.keyboard.inline_keyboard.at(-1)?.[0]?.callback_data ?? '';
    const selectId = parseInt(selectCallback.split(':')[2], 10);
    expect(resolveRegisteredPath(selectId)).toBe(root);
    expect(view.keyboard.inline_keyboard.at(-1)?.[0]?.text).toBe('Use This');
  });
});
