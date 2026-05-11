/**
 * Unit tests for SlackChannel — mocks @slack/web-api + @slack/socket-mode
 * to verify message dispatch, send/edit, mention filtering, and dedup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoist = vi.hoisted(() => {
  const calls: { method: string; payload: any }[] = [];
  const results: Record<string, (payload: any) => any> = {
    'auth.test': () => ({ ok: true, user_id: 'BOT_USER', team: 'TestTeam', user: 'pikiclaw_bot' }),
    'chat.postMessage': () => ({ ok: true, ts: `${Date.now()}.000100` }),
    'chat.update': () => ({ ok: true }),
    'chat.delete': () => ({ ok: true }),
  };
  return { calls, results };
});

vi.mock('@slack/web-api', () => {
  class MockWebClient {
    constructor(_token?: string) {}
    auth = {
      test: vi.fn(async () => {
        hoist.calls.push({ method: 'auth.test', payload: {} });
        return hoist.results['auth.test']!({});
      }),
    };
    chat = {
      postMessage: vi.fn(async (payload: any) => {
        hoist.calls.push({ method: 'chat.postMessage', payload });
        return hoist.results['chat.postMessage']!(payload);
      }),
      update: vi.fn(async (payload: any) => {
        hoist.calls.push({ method: 'chat.update', payload });
        return hoist.results['chat.update']!(payload);
      }),
      delete: vi.fn(async (payload: any) => {
        hoist.calls.push({ method: 'chat.delete', payload });
        return hoist.results['chat.delete']!(payload);
      }),
    };
  }
  return { WebClient: MockWebClient };
});

vi.mock('@slack/socket-mode', () => {
  class MockSocketModeClient {
    constructor(_opts?: any) {}
    on = vi.fn();
    start = vi.fn(async () => undefined);
    disconnect = vi.fn(async () => undefined);
  }
  return { SocketModeClient: MockSocketModeClient };
});

import { SlackChannel } from '../src/channels/slack/channel.ts';

beforeEach(() => {
  hoist.calls.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeChannel(overrides: Partial<ConstructorParameters<typeof SlackChannel>[0]> = {}) {
  return new SlackChannel({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    ...overrides,
  });
}

describe('SlackChannel connect', () => {
  it('reads bot identity from auth.test', async () => {
    const ch = makeChannel();
    const bot = await ch.connect();
    expect(bot.id).toBe('BOT_USER');
    expect(bot.username).toBe('pikiclaw_bot');
    expect(hoist.calls.find(c => c.method === 'auth.test')).toBeDefined();
  });
});

describe('SlackChannel send / edit', () => {
  it('posts to a channel and returns the ts', async () => {
    const ch = makeChannel();
    await ch.connect();
    const ts = await ch.send('C123', 'hello world');
    expect(ts).toMatch(/^\d+\.\d+/);
    const post = hoist.calls.find(c => c.method === 'chat.postMessage');
    expect(post?.payload).toMatchObject({ channel: 'C123', text: 'hello world', mrkdwn: true });
  });

  it('sets thread_ts when replyTo is provided', async () => {
    const ch = makeChannel();
    await ch.connect();
    await ch.send('C123', 'hi', { replyTo: 'parent.ts' });
    const post = hoist.calls.find(c => c.method === 'chat.postMessage');
    expect(post?.payload.thread_ts).toBe('parent.ts');
  });

  it('updates a previous message via chat.update', async () => {
    const ch = makeChannel();
    await ch.connect();
    await ch.editMessage('C123', '1.2', 'updated');
    const update = hoist.calls.find(c => c.method === 'chat.update');
    expect(update?.payload).toMatchObject({ channel: 'C123', ts: '1.2', text: 'updated' });
  });

  it('swallows message_not_found on edit instead of throwing', async () => {
    const ch = makeChannel();
    await ch.connect();
    const original = hoist.results['chat.update'];
    hoist.results['chat.update'] = () => ({ ok: false, error: 'message_not_found' });
    await expect(ch.editMessage('C123', '9.9', 'late')).resolves.toBeUndefined();
    hoist.results['chat.update'] = original!;
  });
});

describe('SlackChannel dispatch', () => {
  async function feedEvent(ch: SlackChannel, event: any) {
    await (ch as any).dispatchMessageEvent(event);
  }

  it('delivers DM message text after stripping the bot mention', async () => {
    const ch = makeChannel();
    await ch.connect();
    const seen: { text: string; chatId: string }[] = [];
    ch.onMessage((msg, ctx) => {
      seen.push({ text: msg.text, chatId: ctx.chatId });
    });
    await feedEvent(ch, {
      type: 'message',
      channel: 'D123',
      channel_type: 'im',
      user: 'U999',
      text: '<@BOT_USER> please ship it',
      ts: '111.222',
    });
    expect(seen).toEqual([{ text: 'please ship it', chatId: 'D123' }]);
  });

  it('drops channel messages that do not @mention the bot', async () => {
    const ch = makeChannel();
    await ch.connect();
    const seen: any[] = [];
    ch.onMessage(msg => seen.push(msg));
    await feedEvent(ch, {
      type: 'message',
      channel: 'C123',
      channel_type: 'channel',
      user: 'U999',
      text: 'random chatter',
      ts: '111.222',
    });
    expect(seen).toEqual([]);
  });

  it('dedups repeated event ids', async () => {
    const ch = makeChannel();
    await ch.connect();
    const seen: any[] = [];
    ch.onMessage(msg => seen.push(msg));
    const event = {
      type: 'message',
      channel: 'D123',
      channel_type: 'im',
      user: 'U999',
      text: 'hi',
      ts: '111.222',
      client_msg_id: 'CLIENT-1',
    };
    await feedEvent(ch, event);
    await feedEvent(ch, event);
    expect(seen.length).toBe(1);
  });

  it('drops messages from itself', async () => {
    const ch = makeChannel();
    await ch.connect();
    const seen: any[] = [];
    ch.onMessage(msg => seen.push(msg));
    await feedEvent(ch, {
      type: 'message',
      channel: 'D123',
      channel_type: 'im',
      user: 'BOT_USER',
      text: 'echo',
      ts: '111.222',
    });
    await feedEvent(ch, {
      type: 'message',
      channel: 'D123',
      channel_type: 'im',
      user: 'U999',
      text: 'genuine',
      ts: '111.223',
      bot_id: 'B1',
    });
    expect(seen).toEqual([]);
  });

  it('blocks chat ids outside the allowlist', async () => {
    const ch = makeChannel({ allowedChatIds: new Set(['C-OK']) });
    await ch.connect();
    const seen: any[] = [];
    ch.onMessage(msg => seen.push(msg));
    await feedEvent(ch, {
      type: 'message',
      channel: 'D-NOPE',
      channel_type: 'im',
      user: 'U999',
      text: 'hi',
      ts: '1.1',
    });
    expect(seen).toEqual([]);
  });
});
