/**
 * Channel base — minimal abstract for all IM platforms.
 *
 * Only defines: lifecycle + outgoing primitives.
 * Hooks (onCommand, onMessage, onCallback, ...) are platform-specific
 * and belong in each subclass — different IMs expose different interaction models.
 */

export interface BotInfo { id: number | string; username: string; displayName: string }

export interface SendOpts {
  replyTo?: number | string;
  parseMode?: string;
  keyboard?: any;
  disablePreview?: boolean;
  messageThreadId?: number;
}

export abstract class Channel {
  bot: BotInfo | null = null;

  // ---- lifecycle ------------------------------------------------------------

  abstract connect(): Promise<BotInfo>;
  abstract listen(): Promise<void>;
  abstract disconnect(): void;

  // ---- outgoing primitives --------------------------------------------------

  abstract send(chatId: number | string, text: string, opts?: SendOpts): Promise<number | string | null>;
  abstract editMessage(chatId: number | string, msgId: number | string, text: string, opts?: SendOpts): Promise<void>;
  abstract deleteMessage(chatId: number | string, msgId: number | string): Promise<void>;
  abstract sendTyping(chatId: number | string, opts?: SendOpts): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.3) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
