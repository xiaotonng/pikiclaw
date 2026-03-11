import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUserConfig } from '../src/user-config.ts';
import { captureEnv, restoreEnv } from './support/env.ts';

const envSnapshot = captureEnv(['TELEGRAM_ALLOWED_CHAT_IDS', 'CODECLAW_WORKDIR']);

describe('user config', () => {
  beforeEach(() => {
    restoreEnv(envSnapshot);
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    delete process.env.CODECLAW_WORKDIR;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('applies saved Telegram allowed chat IDs to the environment', () => {
    applyUserConfig({ telegramAllowedChatIds: '1,2,-3' });

    expect(process.env.TELEGRAM_ALLOWED_CHAT_IDS).toBe('1,2,-3');
  });

  it('does not apply saved default workdir to the environment', () => {
    applyUserConfig({ defaultWorkdir: '/tmp/codeclaw-saved-workdir' });

    expect(process.env.CODECLAW_WORKDIR).toBeUndefined();
  });
});
