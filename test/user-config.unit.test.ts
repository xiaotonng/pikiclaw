import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadModule() {
  return import('../src/user-config.ts');
}

async function loadBrowserProfileModule() {
  return import('../src/browser-profile.ts');
}

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.PIKICLAW_CONFIG;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('user config path resolution', () => {
  it('uses the explicit config path before any profile selection', async () => {
    process.env.PIKICLAW_CONFIG = '/tmp/pikiclaw-custom.json';
    const mod = await loadModule();

    expect(mod.getUserConfigPath()).toBe('/tmp/pikiclaw-custom.json');
  });

  it('exposes the dedicated dev config path', async () => {
    const mod = await loadModule();

    expect(mod.getDevUserConfigPath()).toBe(
      path.join(os.homedir(), '.pikiclaw', 'dev', 'setting.json'),
    );
  });

  it('falls back to the canonical default config path', async () => {
    const mod = await loadModule();

    expect(mod.getUserConfigPath()).toBe(
      path.join(os.homedir(), '.pikiclaw', 'setting.json'),
    );
  });

  it('keeps the managed browser profile outside the dev config directory', async () => {
    process.env.PIKICLAW_CONFIG = path.join(os.homedir(), '.pikiclaw', 'dev', 'setting.json');
    const mod = await loadBrowserProfileModule();

    expect(mod.getManagedBrowserProfileDir()).toBe(
      path.join(os.homedir(), '.pikiclaw', 'browser', 'chrome-profile'),
    );
  });
});
