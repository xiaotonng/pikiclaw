import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWeixinQrDisplayUrl } from '../src/weixin-api.ts';

describe('resolveWeixinQrDisplayUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('passes through embedded image data urls unchanged', async () => {
    const embedded = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    await expect(resolveWeixinQrDisplayUrl(embedded)).resolves.toBe(embedded);
  });

  it('renders a local QR image when Weixin returns an H5 landing page url', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValueOnce(new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const targetUrl = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=abc123&bot_type=3';
    const displayUrl = await resolveWeixinQrDisplayUrl(targetUrl);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(targetUrl);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe('HEAD');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(targetUrl);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.method).toBe('GET');

    expect(displayUrl).toMatch(/^data:image\/png;base64,/);
    const png = Buffer.from(displayUrl.split(',')[1] || '', 'base64');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
