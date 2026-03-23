import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuBot } from '../src/bot-feishu.ts';
import type { FeishuContext } from '../src/channel-feishu.ts';
import { makeTmpDir } from './support/env.ts';

function createBot() {
  const edits: Array<{ text: string; opts?: any }> = [];
  const reactions: Array<{ chatId: string; messageId: string; reactions: string[] }> = [];
  const channel = {
    capabilities: {
      editMessages: true,
      typingIndicators: false,
      commandMenu: true,
      callbackActions: true,
      messageReactions: true,
      fileUpload: true,
      fileDownload: true,
      threads: false,
    },
    setMessageReaction: vi.fn(async (chatId: string, messageId: string, reactionList: string[]) => {
      reactions.push({ chatId, messageId, reactions: reactionList });
    }),
    editMessage: vi.fn(async (_chatId: string, _messageId: string, text: string, opts?: any) => {
      edits.push({ text, opts });
    }),
    isStreamingCard: vi.fn(() => true),
    endStreaming: vi.fn(async () => {}),
    knownChats: new Set<string>(),
  };

  const bot = new FeishuBot();
  (bot as any).channel = channel;

  const ctx: FeishuContext = {
    chatId: 'oc_test_chat',
    messageId: 'om_test_message',
    from: { openId: 'ou_test_user' },
    chatType: 'p2p',
    reply: vi.fn(async () => 'om_reply'),
    editReply: vi.fn(async () => {}),
    channel: channel as any,
    raw: {},
  };

  return { bot, channel, ctx, reactions, edits };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FEISHU_APP_ID = 'test-app-id';
  process.env.FEISHU_APP_SECRET = 'test-app-secret';
  process.env.PIKICLAW_WORKDIR = makeTmpDir('bot-feishu-unit-');
  process.env.DEFAULT_AGENT = 'claude';
});

describe('FeishuBot.handleMessage file staging', () => {
  it('adds a Get reaction after a bare upload is persisted into the session workspace', async () => {
    const uploadDir = makeTmpDir('bot-feishu-upload-');
    const uploadPath = path.join(uploadDir, 'report.pdf');
    fs.writeFileSync(uploadPath, 'pdf');

    const { bot, ctx, reactions } = createBot();
    const runStreamSpy = vi.spyOn(bot, 'runStream');

    await (bot as any).handleMessage({ text: '', files: [uploadPath] }, ctx);

    const chatState = bot.chat(ctx.chatId);
    expect(runStreamSpy).not.toHaveBeenCalled();
    expect(chatState.sessionId).toBeTruthy();
    expect(chatState.workspacePath).toBeTruthy();
    expect(fs.existsSync(path.join(chatState.workspacePath!, 'report.pdf'))).toBe(true);
    expect(reactions).toEqual([
      { chatId: ctx.chatId, messageId: ctx.messageId, reactions: ['Get'] },
    ]);

    fs.rmSync(uploadDir, { recursive: true, force: true });
  });
});

describe('FeishuBot steer handoff preview', () => {
  it('freezes the previous preview card content and removes its actions', async () => {
    const { bot, channel, ctx, edits } = createBot();

    const messageIds = await (bot as any).freezeSteerHandoffPreview(
      ctx,
      'om_preview',
      { getRenderedPreview: () => '**Partial reply**' },
    );

    expect(messageIds).toEqual(['om_preview']);
    expect(channel.endStreaming).toHaveBeenCalledWith('om_preview', 'Steered to a new reply.');
    expect(edits).toEqual([
      {
        text: '**Partial reply**',
        opts: { keyboard: { rows: [] } },
      },
    ]);
  });
});
