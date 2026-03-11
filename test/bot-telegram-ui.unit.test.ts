import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSwitchWorkdirView, resolveRegisteredPath } from '../src/bot-telegram-directory.ts';
import {
  buildFinalReplyRender,
  buildStreamPreviewHtml,
  formatMenuLines,
  formatProviderUsageLines,
  renderSessionTurnHtml,
} from '../src/bot-telegram-render.ts';
import { makeTmpDir } from './support/env.ts';
import { makeStreamResult } from './support/stream-result.ts';

describe('bot-telegram render helpers', () => {
  it('renders resumed session turns with quoted user content and assistant markdown', () => {
    const html = renderSessionTurnHtml(
      '请总结这次修改\n第二行保留原样',
      '# Summary\nUse **bold** and `code`.\n\n```ts\nconst x = 1;\n```',
    );

    expect(html).toContain('<blockquote expandable>请总结这次修改\n第二行保留原样</blockquote>');
    expect(html).toContain('<b>Summary</b>');
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<pre><code class="language-ts">const x = 1;</code></pre>');
  });

  it('builds final reply layouts and provider/menu summaries as pure render output', () => {
    const rendered = buildFinalReplyRender('codex', makeStreamResult('codex', {
      message: 'Build finished.',
      elapsedS: 85,
      contextPercent: 25.7,
      activity: 'Ran: /bin/zsh -lc npm run build\nRan: /bin/zsh -lc npm test',
    }));

    expect(rendered.headerHtml).toContain('<i>commands: 2 done</i>');
    expect(rendered.fullHtml).toContain('Build finished.');
    expect(rendered.fullHtml).toContain('✓ codex · 25.7% · 1m25s');

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
    expect(usageLines.join('\n')).toContain('Claude: 40% used / 60% left');
    expect(usageLines.join('\n')).toContain('rate limited');
    expect(formatMenuLines([{ command: 'status', description: 'Show status' }])[0]).toBe('/status — Show status');
  });

  it('keeps longer activity visible when the preview has no body text', () => {
    const activity = [
      'I have the current release target: 0.2.24 to 0.2.25. I am about to patch the version in the package metadata, runtime constant, and the install skill examples.',
      'Updated 4 files',
      'The version bump is in place: 0.2.25 in runtime, package metadata, and the install skill examples. Next I am running the build and link verification commands.',
      'The build has started cleanly. I am waiting for TypeScript to finish before linking and version verification.',
      'The skill build/install verification passed: node dist/cli.js --version reports codeclaw 0.2.25. I am checking the exact repo delta and the staged release workflow before cutting the tag.',
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
    expect(view.text).toContain('<b>Switch workdir</b>');
    expect(view.text).toContain(`<code>${root}</code>`);
    expect(view.keyboard.inline_keyboard.length).toBeGreaterThanOrEqual(2);

    const childCallback = view.keyboard.inline_keyboard[0][0].callback_data;
    const childId = parseInt(childCallback.split(':')[2], 10);
    expect(resolveRegisteredPath(childId)).toBe(path.join(root, 'alpha'));

    const selectCallback = view.keyboard.inline_keyboard.at(-1)?.[0]?.callback_data ?? '';
    const selectId = parseInt(selectCallback.split(':')[2], 10);
    expect(resolveRegisteredPath(selectId)).toBe(root);
  });
});
