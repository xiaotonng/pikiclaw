import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuChannel, type FeishuCardView } from '../src/channel-feishu.ts';
import { makeTmpDir } from './support/env.ts';
import * as lark from '@larksuiteoapi/node-sdk';

function makeButton(label: string, action: string) {
  return {
    tag: 'button' as const,
    text: { tag: 'plain_text' as const, content: label },
    value: { action },
  };
}

function createTestChannel() {
  const ch = new FeishuChannel({
    appId: 'app-id',
    appSecret: 'app-secret',
    workdir: makeTmpDir('feishu-test-'),
  });

  const createCalls: any[] = [];
  const patchCalls: any[] = [];
  const requestCalls: any[] = [];

  (ch as any).client = {
    im: {
      message: {
        create: vi.fn(async (payload: any) => {
          createCalls.push(payload);
          return { data: { message_id: `msg-${createCalls.length}` } };
        }),
        reply: vi.fn(async (payload: any) => {
          createCalls.push(payload);
          return { data: { message_id: `msg-${createCalls.length}` } };
        }),
        patch: vi.fn(async (payload: any) => {
          patchCalls.push(payload);
          return { data: {} };
        }),
        delete: vi.fn(async () => ({ data: {} })),
      },
      image: { create: vi.fn() },
      file: { create: vi.fn() },
      messageResource: { get: vi.fn() },
    },
    cardkit: {
      v1: {
        card: {
          create: vi.fn(async (payload: any) => {
            requestCalls.push({ method: 'POST', url: '/open-apis/cardkit/v1/cards', data: payload.data });
            return { data: { card_id: `card-${requestCalls.length}` } };
          }),
          settings: vi.fn(async (payload: any) => {
            requestCalls.push({
              method: 'PATCH',
              url: `/open-apis/cardkit/v1/cards/${payload.path.card_id}/settings`,
              data: payload.data,
            });
            return { data: {} };
          }),
          update: vi.fn(async (payload: any) => {
            requestCalls.push({
              method: 'PUT',
              url: `/open-apis/cardkit/v1/cards/${payload.path.card_id}`,
              data: payload.data,
            });
            return { data: {} };
          }),
        },
        cardElement: {
          content: vi.fn(async (payload: any) => {
            requestCalls.push({
              method: 'PUT',
              url: `/open-apis/cardkit/v1/cards/${payload.path.card_id}/elements/${payload.path.element_id}/content`,
              data: payload.data,
            });
            return { data: {} };
          }),
        },
      },
    },
    request: vi.fn(async (payload: any) => {
      requestCalls.push(payload);
      if (payload?.method === 'POST' && payload?.url === '/open-apis/cardkit/v1/cards') {
        return { data: { card_id: `card-${requestCalls.length}` } };
      }
      return { data: {} };
    }),
  };

  return { ch, createCalls, patchCalls, requestCalls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FeishuChannel cards', () => {
  it('chunks legacy keyboard actions, preserves explicit card rows, and retries websocket startup failures', async () => {
    // Scenario 1: chunks legacy keyboard actions into visible action rows
    {
      const { ch, createCalls } = createTestChannel();

      await ch.send('chat-1', '**Available Agents**', {
        keyboard: {
          actions: [
            makeButton('claude', 'ag:claude'),
            makeButton('codex', 'ag:codex'),
            makeButton('gemini', 'ag:gemini'),
            makeButton('new', 'ag:new'),
          ],
        },
      });

      const payload = JSON.parse(createCalls[0].data.content);
      const actionRows = payload.elements.filter((element: any) => element.tag === 'action');

      expect(actionRows).toHaveLength(2);
      expect(actionRows[0]).toMatchObject({
        tag: 'action',
        layout: 'trisection',
        actions: [
          { value: { action: 'ag:claude' } },
          { value: { action: 'ag:codex' } },
          { value: { action: 'ag:gemini' } },
        ],
      });
      expect(actionRows[1]).toMatchObject({
        tag: 'action',
        actions: [{ value: { action: 'ag:new' } }],
      });
      expect(actionRows[1].layout).toBeUndefined();
    }

    // Scenario 2: preserves explicit command card rows on send and edit
    {
      const { ch, createCalls, patchCalls } = createTestChannel();
      const card: FeishuCardView = {
        markdown: '**Available Agents**\n\nUse the controls below.',
        rows: [
          { actions: [makeButton('claude', 'ag:claude'), makeButton('codex', 'ag:codex')] },
          { actions: [makeButton('gemini', 'ag:gemini')] },
        ],
      };

      await ch.sendCard('chat-1', card);
      await ch.editCard('chat-1', 'msg-9', card);

      const sent = JSON.parse(createCalls[0].data.content);
      const edited = JSON.parse(patchCalls[0].data.content);

      expect(sent.elements.filter((element: any) => element.tag === 'action')).toHaveLength(2);
      expect(sent.elements[1].layout).toBe('bisected');
      expect(sent.elements[2].layout).toBeUndefined();
      expect(edited.elements[1].actions[0].value.action).toBe('ag:claude');
      expect(edited.elements[2].actions[0].value.action).toBe('ag:gemini');
    }

    // Scenario 3: retries retryable websocket startup failures
    {
      const wsStart = vi.fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockImplementationOnce(async () => {});
      const wsClose = vi.fn();

      const wsSpy = vi.spyOn(lark, 'WSClient').mockImplementation(class {
        start = wsStart;
        close = wsClose;
      } as any);

      const sleepSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: any[]) => void) => {
        fn();
        return 0 as any;
      }) as typeof setTimeout);

      const { ch } = createTestChannel();
      const listenPromise = ch.listen();
      for (let i = 0; i < 10 && wsStart.mock.calls.length < 2; i++) {
        await Promise.resolve();
      }
      ch.disconnect();
      await listenPromise;

      expect(wsSpy).toHaveBeenCalledTimes(2);
      expect(wsStart).toHaveBeenCalledTimes(2);
      expect(wsClose).toHaveBeenCalled();
      expect(sleepSpy).toHaveBeenCalled();
    }
  });
});

describe('FeishuChannel streaming cards', () => {
  it('streams append-only body content and falls back to regular card edits when content rewrites', async () => {
    const { ch, createCalls, patchCalls, requestCalls } = createTestChannel();

    expect(await ch.sendStreamingCard('chat-1', '● codex · 0s')).toBe('msg-1');

    const createCardReq = requestCalls.find(call => call.method === 'POST' && call.url === '/open-apis/cardkit/v1/cards');
    expect(createCardReq).toBeTruthy();

    const cardJson = JSON.parse(createCardReq.data.data);
    expect(cardJson.body.elements).toEqual([
      { tag: 'markdown', content: '● codex · 0s', element_id: 'status' },
      { tag: 'markdown', content: '', element_id: 'content' },
    ]);

    expect(createCalls).toHaveLength(1);
    expect(JSON.parse(createCalls[0].data.content)).toEqual({ type: 'card', data: { card_id: 'card-1' } });

    await ch.editMessage('chat-1', 'msg-1', 'hello');
    const pushReq = requestCalls.find(call =>
      call.method === 'PUT' &&
      call.url === '/open-apis/cardkit/v1/cards/card-1/elements/content/content',
    );
    expect(pushReq?.data).toEqual({ content: 'hello', sequence: 2 });

    await ch.editMessage('chat-1', 'msg-1', 'rewritten output');

    const endReq = requestCalls.find(call =>
      call.method === 'PATCH' &&
      call.url === '/open-apis/cardkit/v1/cards/card-1/settings',
    );
    expect(endReq?.data.sequence).toBe(3);
    expect(requestCalls.some(call =>
      call.method === 'PUT' &&
      call.url === '/open-apis/cardkit/v1/cards/card-1' &&
      call.data?.card?.type === 'card_json',
    )).toBe(false);
    expect(patchCalls).toHaveLength(1);
    expect(JSON.parse(patchCalls[0].data.content)).toEqual({
      config: { wide_screen_mode: true, update_multi: true },
      elements: [{ tag: 'markdown', content: 'rewritten output' }],
    });

    await ch.editMessage('chat-1', 'msg-1', 'rewritten output v2');

    expect(patchCalls).toHaveLength(2);
    expect(JSON.parse(patchCalls[1].data.content)).toEqual({
      config: { wide_screen_mode: true, update_multi: true },
      elements: [{ tag: 'markdown', content: 'rewritten output v2' }],
    });
  });

  it('disables CardKit after a 400 create failure and falls back to regular cards', async () => {
    const { ch, createCalls } = createTestChannel();
    const createCard = vi.spyOn((ch as any).client.cardkit.v1.card, 'create');
    createCard.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 400'), {
      config: { method: 'post', url: '/open-apis/cardkit/v1/cards' },
      response: { data: { code: 200650, msg: 'permission denied' } },
    }));

    expect(await ch.sendStreamingCard('chat-1', '● codex · 0s')).toBe('msg-1');
    expect(createCalls).toHaveLength(1);
    expect(JSON.parse(createCalls[0].data.content).elements[0].content).toBe('● codex · 0s');

    createCard.mockClear();
    expect(await ch.sendStreamingCard('chat-1', '● codex · 1s')).toBe('msg-2');
    expect(createCard).not.toHaveBeenCalled();
    expect(createCalls).toHaveLength(2);
  });
});

describe('FeishuChannel files', () => {
  it('falls back to a file message when image upload is rejected', async () => {
    const { ch, createCalls } = createTestChannel();
    const pngPath = path.join(makeTmpDir('feishu-file-'), 'desktop.png');
    fs.writeFileSync(pngPath, 'fake-png');

    const uploadImage = vi.spyOn(ch, 'uploadImage').mockRejectedValue(new Error('Image upload failed: invalid image'));
    const uploadFile = vi.spyOn(ch, 'uploadFile').mockResolvedValue('file-key-1');

    expect(await ch.sendFile('chat-1', pngPath, { asPhoto: true })).toBe('msg-1');
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].data.msg_type).toBe('file');
    expect(JSON.parse(createCalls[0].data.content)).toEqual({ file_key: 'file-key-1' });
  });
});
