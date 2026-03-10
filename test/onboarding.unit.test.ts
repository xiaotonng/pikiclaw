import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSetupGuide, collectSetupState, isSupportedNode } from '../src/onboarding.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';

const ENV_KEYS = [
  'HOME',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

const envSnapshot = captureEnv(ENV_KEYS);

describe('onboarding helpers', () => {
  let homeDir: string;

  beforeEach(() => {
    restoreEnv(envSnapshot);
    homeDir = makeTmpDir('codeclaw-home-');
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('accepts Node.js 18+ and rejects older versions', () => {
    expect(isSupportedNode('18.0.0')).toBe(true);
    expect(isSupportedNode('22.12.0')).toBe(true);
    expect(isSupportedNode('16.20.2')).toBe(false);
  });

  it('renders an English first-time setup guide for missing agent and token', () => {
    const state = collectSetupState({
      agents: [
        { agent: 'claude', installed: false, path: null, version: null },
        { agent: 'codex', installed: false, path: null, version: null },
      ],
      channel: 'telegram',
      tokenProvided: false,
      nodeVersion: '20.18.1',
    });

    const guide = buildSetupGuide(state, '0.2.22');

    expect(guide).toContain('First-time setup');
    expect(guide).toContain('MISSING  Claude Code is not installed.');
    expect(guide).toContain('Install with: npm install -g @anthropic-ai/claude-code');
    expect(guide).toContain('Install with: npm install -g @openai/codex');
    expect(guide).toContain('No TELEGRAM_BOT_TOKEN or CODECLAW_TOKEN was provided.');
    expect(guide).toContain('Open Telegram and search for @BotFather');
    expect(guide).toContain('npx codeclaw@latest -t <YOUR_BOT_TOKEN>');
  });

  it('marks API-key backed agent auth as ready in doctor mode', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const state = collectSetupState({
      agents: [
        { agent: 'claude', installed: true, path: '/usr/local/bin/claude', version: '1.0.79' },
        { agent: 'codex', installed: false, path: null, version: null },
      ],
      channel: 'telegram',
      tokenProvided: true,
      nodeVersion: '20.18.1',
    });

    const guide = buildSetupGuide(state, '0.2.22', { doctor: true });

    expect(guide).toContain('Setup check');
    expect(guide).toContain('OK       Claude Code found at /usr/local/bin/claude (1.0.79)');
    expect(guide).toContain('OK       Claude Code sign-in looks ready. ANTHROPIC_API_KEY detected.');
    expect(guide).toContain('OK       A Telegram token was provided.');
    expect(guide).toContain('npx codeclaw@latest --doctor');
  });
});
