/**
 * Unit tests for DingtalkChannel — mocks dingtalk-stream's DWClient and global
 * fetch (used by the sessionWebhook reply path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dingtalk-stream', () => {
  const TOPIC_ROBOT = '/v1.0/im/bot/messages/get';
  class FakeDWClient {
    config: any;
    registered: any = null;
    constructor(opts: any) { this.config = opts; }
    registerCallbackListener = vi.fn((_topic: string, cb: any) => { this.registered = cb; return this; });
    getAccessToken = vi.fn(async () => 'fake-token');
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn(() => undefined);
    socketCallBackResponse = vi.fn();
  }
  return {
    DWClient: FakeDWClient,
    TOPIC_ROBOT,
    EventAck: { SUCCESS: 'SUCCESS', LATER: 'LATER' },
  };
});

import { DingtalkChannel } from '../src/channels/dingtalk/channel.ts';

const fetchCalls: { url: string; init?: any }[] = [];

beforeEach(() => {
  fetchCalls.length = 0;
  global.fetch = vi.fn(async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  }) as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DingtalkChannel', () => {
  it('connects and reports identity', async () => {
    const ch = new DingtalkChannel({ clientId: 'app-key', clientSecret: 'app-secret' });
    const bot = await ch.connect();
    expect(bot.id).toBe('app-key');
    expect(bot.displayName).toMatch(/DingTalk/);
  });

  it('dispatches a text message and surfaces the sessionWebhook to send()', async () => {
    const ch = new DingtalkChannel({ clientId: 'app-key', clientSecret: 'app-secret' });
    await ch.connect();

    const seen: { text: string; chatId: string }[] = [];
    ch.onMessage((msg, ctx) => seen.push({ text: msg.text, chatId: ctx.chatId }));

    const downstream = {
      headers: { messageId: 'srv-msg-1' },
      data: JSON.stringify({
        conversationId: 'conv-1',
        msgId: 'm-1',
        senderStaffId: 'staff-1',
        senderId: 'user-1',
        msgtype: 'text',
        text: { content: 'hello bot' },
        sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
        sessionWebhookExpiredTime: Date.now() + 60_000,
        conversationType: '1',
      }),
    };
    await (ch as any).dispatchRobotMessage(downstream);
    expect(seen).toEqual([{ text: 'hello bot', chatId: 'conv-1' }]);

    const sentId = await ch.send('conv-1', 'reply');
    expect(sentId).toMatch(/^dt:/);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain('robot/sendBySession');
    expect(JSON.parse(fetchCalls[0].init.body)).toMatchObject({
      msgtype: 'text',
      text: { content: 'reply' },
    });
  });

  it('throws on send when no sessionWebhook has been seen', async () => {
    const ch = new DingtalkChannel({ clientId: 'app-key', clientSecret: 'app-secret' });
    await ch.connect();
    await expect(ch.send('unseen-chat', 'oops')).rejects.toThrow(/sessionWebhook/);
  });

  it('dedups identical msgIds', async () => {
    const ch = new DingtalkChannel({ clientId: 'app-key', clientSecret: 'app-secret' });
    await ch.connect();
    const seen: any[] = [];
    ch.onMessage(msg => seen.push(msg));
    const downstream = {
      headers: { messageId: 'x' },
      data: JSON.stringify({
        conversationId: 'conv-1',
        msgId: 'dup',
        senderStaffId: 's-1',
        msgtype: 'text',
        text: { content: 'hi' },
        sessionWebhook: 'https://example/wh',
      }),
    };
    await (ch as any).dispatchRobotMessage(downstream);
    await (ch as any).dispatchRobotMessage(downstream);
    expect(seen.length).toBe(1);
  });

  it('respects allowedChatIds', async () => {
    const ch = new DingtalkChannel({
      clientId: 'app-key',
      clientSecret: 'app-secret',
      allowedChatIds: new Set(['only-this-chat']),
    });
    await ch.connect();
    const seen: any[] = [];
    ch.onMessage(msg => seen.push(msg));
    const downstream = {
      headers: { messageId: 'x' },
      data: JSON.stringify({
        conversationId: 'blocked-chat',
        msgId: 'msg-1',
        senderStaffId: 's-1',
        msgtype: 'text',
        text: { content: 'hi' },
        sessionWebhook: 'https://example/wh',
      }),
    };
    await (ch as any).dispatchRobotMessage(downstream);
    expect(seen).toEqual([]);
  });
});
