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

  (ch as any).client = {
    im: {
      message: {
        create: vi.fn(async (payload: any) => {
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
    request: vi.fn(async () => ({ data: {} })),
  };

  return { ch, createCalls, patchCalls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FeishuChannel cards', () => {
  it('chunks legacy keyboard actions into visible action rows', async () => {
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
  });

  it('preserves explicit command card rows on send and edit', async () => {
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
  });

  it('retries retryable websocket startup failures', async () => {
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
  });
});
