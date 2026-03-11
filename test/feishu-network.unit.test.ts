import { afterEach, describe, expect, it } from 'vitest';
import { feishuNoProxyEnabled } from '../src/feishu-network.ts';

const KEYS = ['FEISHU_NO_PROXY', 'FEISHU_USE_PROXY'] as const;

describe('feishu network defaults', () => {
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it('defaults to direct connect for Feishu', () => {
    expect(feishuNoProxyEnabled()).toBe(true);
  });

  it('honors explicit opt-in to proxy mode', () => {
    process.env.FEISHU_USE_PROXY = '1';
    expect(feishuNoProxyEnabled()).toBe(false);
  });

  it('keeps backward compatibility with FEISHU_NO_PROXY', () => {
    process.env.FEISHU_NO_PROXY = '0';
    expect(feishuNoProxyEnabled()).toBe(false);

    process.env.FEISHU_NO_PROXY = '1';
    expect(feishuNoProxyEnabled()).toBe(true);
  });
});
