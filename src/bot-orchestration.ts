import type { Bot, ChatId, SessionRuntime } from './bot.js';
import { buildDefaultMenuCommands } from './bot-menu.js';
import { BOT_SHUTDOWN_FORCE_EXIT_MS as _BOT_SHUTDOWN_FORCE_EXIT_MS } from './constants.js';

export const BOT_SHUTDOWN_FORCE_EXIT_MS = _BOT_SHUTDOWN_FORCE_EXIT_MS;

export interface BotMenuState {
  commands: ReturnType<typeof buildDefaultMenuCommands>;
  skillCount: number;
}

export function buildBotMenuState(bot: Pick<Bot, 'fetchAgents' | 'fetchSkills'>): BotMenuState {
  const agents = bot.fetchAgents().agents;
  const installedCount = agents.filter(agent => agent.installed).length;
  const skills = bot.fetchSkills().skills;
  return {
    commands: buildDefaultMenuCommands(installedCount, skills),
    skillCount: skills.length,
  };
}

export function buildSessionTaskId(session: Pick<SessionRuntime, 'key'>, seq: number, now = Date.now()): string {
  return `${session.key}:${now.toString(36)}:${seq.toString(36)}`;
}

export function buildKnownChatEnv(
  allowedChatIds: Iterable<ChatId>,
  knownChatIds: Iterable<ChatId>,
  envName: string,
): Record<string, string> {
  const ids = new Set<string>();
  for (const id of allowedChatIds) ids.add(String(id));
  for (const id of knownChatIds) ids.add(String(id));
  return ids.size ? { [envName]: [...ids].join(',') } : {};
}

export class SessionMessageRegistry<ChatKey extends ChatId, MessageId extends ChatId> {
  private readonly messages = new Map<ChatKey, Map<MessageId, string>>();

  constructor(private readonly maxPerChat = 1024) {}

  clear() {
    this.messages.clear();
  }

  register(
    chatId: ChatKey,
    messageId: MessageId | null | undefined,
    session: Pick<SessionRuntime, 'key' | 'workdir'>,
    workdir: string,
  ) {
    if (session.workdir !== workdir) return;
    if (!this.isValidMessageId(messageId)) return;

    let chatMessages = this.messages.get(chatId);
    if (!chatMessages) {
      chatMessages = new Map<MessageId, string>();
      this.messages.set(chatId, chatMessages);
    }

    chatMessages.set(messageId, session.key);
    while (chatMessages.size > this.maxPerChat) {
      const oldest = chatMessages.keys().next();
      if (oldest.done) break;
      chatMessages.delete(oldest.value);
    }
  }

  registerMany(
    chatId: ChatKey,
    messageIds: Array<MessageId | null | undefined>,
    session: Pick<SessionRuntime, 'key' | 'workdir'>,
    workdir: string,
  ) {
    for (const messageId of messageIds) this.register(chatId, messageId, session, workdir);
  }

  resolve(chatId: ChatKey, messageId: MessageId | null | undefined): string | null {
    if (!this.isValidMessageId(messageId)) return null;
    return this.messages.get(chatId)?.get(messageId) || null;
  }

  private isValidMessageId(messageId: MessageId | null | undefined): messageId is MessageId {
    if (typeof messageId === 'number') return Number.isFinite(messageId);
    if (typeof messageId === 'string') return messageId.length > 0;
    return false;
  }
}
