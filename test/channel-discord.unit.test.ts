/**
 * Unit tests for DiscordChannel — mocks discord.js so we can verify dispatch
 * and the send/edit/delete paths without opening a real gateway connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoist = vi.hoisted(() => {
  const sentMessages: { channelId: string; payload: any }[] = [];
  const editedMessages: { channelId: string; messageId: string; payload: any }[] = [];
  const onceHandlers: Record<string, ((...args: any[]) => any)[]> = {};
  const onHandlers: Record<string, ((...args: any[]) => any)[]> = {};
  return { sentMessages, editedMessages, onceHandlers, onHandlers };
});

vi.mock('discord.js', () => {
  class FakeMessage {
    id = `M${Math.floor(Math.random() * 100000)}`;
    constructor(public channelId: string) {}
    edit = vi.fn(async (payload: any) => {
      hoist.editedMessages.push({ channelId: this.channelId, messageId: this.id, payload });
      return this;
    });
    delete = vi.fn(async () => undefined);
  }
  class FakeChannel {
    messages: any;
    constructor(public id: string) {
      const inner = new Map<string, FakeMessage>();
      this.messages = {
        fetch: vi.fn(async (msgId: string) => {
          const existing = inner.get(msgId);
          if (existing) return existing;
          const msg = new FakeMessage(this.id);
          msg.id = msgId;
          inner.set(msgId, msg);
          return msg;
        }),
      };
    }
    send = vi.fn(async (payload: any) => {
      const msg = new FakeMessage(this.id);
      hoist.sentMessages.push({ channelId: this.id, payload });
      return msg;
    });
  }
  class FakeClient {
    user = { id: 'BOT_USER', username: 'pikiclaw', displayName: 'pikiclaw' };
    channels = {
      cache: new Map<string, FakeChannel>(),
      fetch: vi.fn(async (id: string) => {
        const ch = new FakeChannel(id);
        this.channels.cache.set(id, ch);
        return ch;
      }),
    };
    login = vi.fn(async () => {
      queueMicrotask(() => {
        const handlers = hoist.onceHandlers['ClientReady'] || [];
        handlers.forEach(h => h(this));
      });
    });
    destroy = vi.fn(async () => undefined);
    on = vi.fn((event: string, handler: any) => {
      hoist.onHandlers[event] = hoist.onHandlers[event] || [];
      hoist.onHandlers[event].push(handler);
      return this;
    });
    once = vi.fn((event: string, handler: any) => {
      hoist.onceHandlers[event] = hoist.onceHandlers[event] || [];
      hoist.onceHandlers[event].push(handler);
      return this;
    });
  }
  return {
    Client: FakeClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
    Partials: { Channel: 'Channel', Message: 'Message' },
    Events: {
      ClientReady: 'ClientReady',
      Error: 'Error',
      MessageCreate: 'MessageCreate',
      ShardDisconnect: 'ShardDisconnect',
      InteractionCreate: 'InteractionCreate',
    },
  };
});

import { DiscordChannel } from '../src/channels/discord/channel.ts';

beforeEach(() => {
  hoist.sentMessages.length = 0;
  hoist.editedMessages.length = 0;
  for (const k of Object.keys(hoist.onceHandlers)) delete hoist.onceHandlers[k];
  for (const k of Object.keys(hoist.onHandlers)) delete hoist.onHandlers[k];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiscordChannel connect / send / edit', () => {
  it('reads bot identity after gateway ready', async () => {
    const ch = new DiscordChannel({ botToken: 'token' });
    const bot = await ch.connect();
    expect(bot.id).toBe('BOT_USER');
    expect(bot.username).toBe('pikiclaw');
  });

  it('sends a text message and returns the message id', async () => {
    const ch = new DiscordChannel({ botToken: 'token' });
    await ch.connect();
    const id = await ch.send('CHAN_1', 'hello');
    expect(id).toMatch(/^M/);
    expect(hoist.sentMessages.length).toBe(1);
    expect(hoist.sentMessages[0]).toMatchObject({ channelId: 'CHAN_1', payload: { content: 'hello' } });
  });

  it('attaches a reply reference when replyTo is provided', async () => {
    const ch = new DiscordChannel({ botToken: 'token' });
    await ch.connect();
    await ch.send('CHAN_2', 'reply text', { replyTo: 'M_PARENT' });
    expect(hoist.sentMessages[0].payload.reply).toMatchObject({ messageReference: 'M_PARENT', failIfNotExists: false });
  });

  it('edits an existing message', async () => {
    const ch = new DiscordChannel({ botToken: 'token' });
    await ch.connect();
    await ch.editMessage('CHAN_1', 'M_OLD', 'updated');
    expect(hoist.editedMessages.length).toBe(1);
    expect(hoist.editedMessages[0]).toMatchObject({ channelId: 'CHAN_1', messageId: 'M_OLD', payload: { content: 'updated' } });
  });
});

describe('DiscordChannel dispatch', () => {
  function makeMsg(overrides: any = {}) {
    return {
      author: { bot: false, id: overrides.userId || 'U_USER', username: 'someone' },
      channelId: overrides.channelId || 'CHAN_1',
      id: overrides.id || 'M1',
      content: overrides.content ?? '<@BOT_USER> hi',
      mentions: { users: { has: (id: string) => id === 'BOT_USER' && !!overrides.mentionsBot } },
      channel: { isDMBased: () => !!overrides.dm },
    };
  }

  it('strips the bot mention and delivers to handler', async () => {
    const ch = new DiscordChannel({ botToken: 'token' });
    await ch.connect();
    const seen: { text: string; chatId: string }[] = [];
    ch.onMessage((msg, ctx) => seen.push({ text: msg.text, chatId: ctx.chatId }));
    await (ch as any).dispatchMessage(makeMsg({ dm: true, content: '<@BOT_USER> please ship it' }));
    expect(seen).toEqual([{ text: 'please ship it', chatId: 'CHAN_1' }]);
  });

  it('skips channel messages without bot mention', async () => {
    const ch = new DiscordChannel({ botToken: 'token' });
    await ch.connect();
    const seen: any[] = [];
    ch.onMessage(msg => seen.push(msg));
    await (ch as any).dispatchMessage(makeMsg({ dm: false, mentionsBot: false, content: 'random chatter' }));
    expect(seen).toEqual([]);
  });

  it('drops bot-authored messages', async () => {
    const ch = new DiscordChannel({ botToken: 'token' });
    await ch.connect();
    const seen: any[] = [];
    ch.onMessage(msg => seen.push(msg));
    const msg = makeMsg({ dm: true });
    msg.author.bot = true;
    await (ch as any).dispatchMessage(msg);
    expect(seen).toEqual([]);
  });

  it('respects allowedChatIds', async () => {
    const ch = new DiscordChannel({ botToken: 'token', allowedChatIds: new Set(['CHAN_OK']) });
    await ch.connect();
    const seen: any[] = [];
    ch.onMessage(msg => seen.push(msg));
    await (ch as any).dispatchMessage(makeMsg({ dm: true, channelId: 'CHAN_BLOCKED' }));
    expect(seen).toEqual([]);
  });
});
