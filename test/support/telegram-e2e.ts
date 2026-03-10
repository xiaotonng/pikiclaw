import type { TelegramChannel, TgCallbackContext, TgContext, TgMessage } from '../../src/channel-telegram.ts';

export interface ReceivedMsg {
  text: string;
  files: string[];
  chatId: number;
  fromId?: number;
}

export interface ReceivedCmd {
  cmd: string;
  args: string;
  chatId: number;
}

export interface ReceivedCb {
  data: string;
  chatId: number;
  callbackId: string;
}

export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function promptChat(
  channel: Pick<TelegramChannel, 'send'>,
  chatId: number,
  sentMsgIds: number[],
  text: string,
  opts?: any,
  promptDelayMs = 2_000,
): Promise<void> {
  const msgId = await channel.send(chatId, text, opts);
  if (msgId) sentMsgIds.push(msgId);
  await wait(promptDelayMs);
}

export async function cleanupMessages(
  channel: Pick<TelegramChannel, 'deleteMessage'> | null | undefined,
  chatId: number,
  sentMsgIds: number[],
): Promise<void> {
  if (!channel) return;
  for (const id of sentMsgIds) {
    await channel.deleteMessage(chatId, id).catch(() => {});
  }
}

export async function resolveChatId(
  initialChatId: number,
  detectRecentChatId: () => Promise<number | null | undefined>,
  waitMessages: (count: number) => Promise<ReceivedMsg[]>,
): Promise<number> {
  if (Number.isFinite(initialChatId) && initialChatId > 0) return initialChatId;

  const detected = await detectRecentChatId();
  if (detected && Number.isFinite(detected)) {
    console.log(`Auto-detected CHAT_ID=${detected} from recent updates`);
    return detected;
  }

  console.log('No recent messages — send any message to the bot to start...');
  const first = await waitMessages(1);
  console.log(`Auto-detected CHAT_ID=${first[0].chatId} from polling`);
  return first[0].chatId;
}

interface TelegramWaitersOptions {
  waitTimeout: number;
  sentMsgIds: number[];
  callbackAckText: string;
  includeFromId?: boolean;
}

export function createTelegramWaiters({
  waitTimeout,
  sentMsgIds,
  callbackAckText,
  includeFromId = false,
}: TelegramWaitersOptions) {
  let onMsg: ((msg: TgMessage, ctx: TgContext) => void) | null = null;
  let onCmd: ((cmd: string, args: string, ctx: TgContext) => void) | null = null;
  let onCb: ((data: string, ctx: TgCallbackContext) => void) | null = null;

  return {
    dispatchMessage(msg: TgMessage, ctx: TgContext) {
      if (!onMsg) return false;
      onMsg(msg, ctx);
      return true;
    },
    dispatchCommand(cmd: string, args: string, ctx: TgContext, fallbackToMessage = false) {
      if (onCmd) {
        onCmd(cmd, args, ctx);
        return true;
      }
      if (fallbackToMessage && onMsg) {
        onMsg({ text: `/${cmd} ${args}`.trim(), files: [] }, ctx);
        return true;
      }
      return false;
    },
    dispatchCallback(data: string, ctx: TgCallbackContext) {
      if (!onCb) return false;
      onCb(data, ctx);
      return true;
    },
    waitMessages(count: number): Promise<ReceivedMsg[]> {
      const results: ReceivedMsg[] = [];
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out — expected ${count} message(s), got ${results.length}`)),
          waitTimeout,
        );
        onMsg = (msg, ctx) => {
          sentMsgIds.push(ctx.messageId);
          results.push({
            text: msg.text,
            files: msg.files,
            chatId: ctx.chatId,
            fromId: includeFromId ? ctx.from.id : undefined,
          });
          if (results.length >= count) {
            clearTimeout(timer);
            onMsg = null;
            resolve(results);
          }
        };
      });
    },
    waitCommand(): Promise<ReceivedCmd> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for command')), waitTimeout);
        onCmd = (cmd, args, ctx) => {
          clearTimeout(timer);
          onCmd = null;
          sentMsgIds.push(ctx.messageId);
          resolve({ cmd, args, chatId: ctx.chatId });
        };
      });
    },
    waitCallback(): Promise<ReceivedCb> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for button click')), waitTimeout);
        onCb = (data, ctx) => {
          clearTimeout(timer);
          onCb = null;
          sentMsgIds.push(ctx.messageId);
          ctx.answerCallback(callbackAckText);
          resolve({ data, chatId: ctx.chatId, callbackId: ctx.callbackId });
        };
      });
    },
  };
}
