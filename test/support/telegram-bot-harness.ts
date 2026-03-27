import type { TgContext } from '../../src/channel-telegram.ts';
import { TelegramBot } from '../../src/bot-telegram.ts';
import { vi } from 'vitest';

// Prevent Bot constructor from touching real filesystem (skills merge, gitignore, etc.)
vi.mock('../../src/code-agent.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/code-agent.ts')>();
  return { ...actual, initializeProjectSkills: vi.fn() };
});

export interface TelegramBotHarness {
  bot: TelegramBot;
  channel: any;
  ctx: TgContext;
  edits: Array<{ text: string; opts?: any }>;
  sends: Array<{ text: string; opts?: any }>;
  docs: Array<{ content: string | Buffer; filename: string; opts?: any }>;
  files: Array<{ filePath: string; opts?: any }>;
  reactions: Array<{ chatId: number; messageId: number; reactions: string[] }>;
}

export function createTelegramBotHarness(): TelegramBotHarness {
  const edits: Array<{ text: string; opts?: any }> = [];
  const sends: Array<{ text: string; opts?: any }> = [];
  const docs: Array<{ content: string | Buffer; filename: string; opts?: any }> = [];
  const files: Array<{ filePath: string; opts?: any }> = [];
  const reactions: Array<{ chatId: number; messageId: number; reactions: string[] }> = [];
  const channel = {
    capabilities: {
      editMessages: true,
      typingIndicators: true,
      commandMenu: true,
      callbackActions: true,
      messageReactions: true,
      fileUpload: true,
      fileDownload: true,
      threads: true,
    },
    editMessage: vi.fn(async (_chatId: number, _msgId: number, text: string, opts?: any) => {
      edits.push({ text, opts });
    }),
    send: vi.fn(async (_chatId: number, text: string, opts?: any) => {
      sends.push({ text, opts });
      return 777;
    }),
    sendDocument: vi.fn(async (_chatId: number, content: string | Buffer, filename: string, opts?: any) => {
      docs.push({ content, filename, opts });
      return 778;
    }),
    sendFile: vi.fn(async (_chatId: number, filePath: string, opts?: any) => {
      files.push({ filePath, opts });
      return 779;
    }),
    setMessageReaction: vi.fn(async (chatId: number, messageId: number, reactionList: string[]) => {
      reactions.push({ chatId, messageId, reactions: reactionList });
    }),
    setMenu: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    sendTyping: vi.fn(async () => {}),
    disconnect: vi.fn(),
    knownChats: new Set<number>(),
  };

  const bot = new TelegramBot();
  (bot as any).channel = channel;

  const ctx: TgContext = {
    chatId: 100,
    messageId: 200,
    from: { id: 300 },
    reply: vi.fn(async () => 1),
    editReply: vi.fn(async (msgId: number, text: string, opts?: any) => {
      await channel.editMessage(100, msgId, text, opts);
    }),
    answerCallback: vi.fn(async () => {}),
    channel: channel as any,
    raw: {},
  };

  return { bot, channel, ctx, edits, sends, docs, files, reactions };
}
