import type { RichMessage, SessionMessagesResult } from '../../types';

export interface Turn {
  user: RichMessage | null;
  assistant: RichMessage | null;
}

export interface TurnHistoryWindow {
  turns: Turn[];
  startTurn: number;
  endTurn: number;
  totalTurns: number;
  hasOlder: boolean;
}

export function normalizeTurnHistory(result: SessionMessagesResult): TurnHistoryWindow {
  const richMessages = result.richMessages?.length
    ? result.richMessages
    : result.messages?.map(m => ({ role: m.role, text: m.text, blocks: [{ type: 'text' as const, content: m.text }] })) || [];
  const turns = groupIntoTurns(richMessages);
  const totalTurns = Math.max(result.window?.totalTurns ?? result.totalTurns ?? turns.length, turns.length);
  const endTurn = result.window?.endTurn ?? totalTurns;
  const startTurn = result.window?.startTurn ?? Math.max(0, endTurn - turns.length);
  return {
    turns,
    startTurn,
    endTurn,
    totalTurns,
    hasOlder: result.window?.hasOlder ?? startTurn > 0,
  };
}

export function mergeOlderHistory(current: TurnHistoryWindow, older: TurnHistoryWindow): TurnHistoryWindow {
  const prefixCount = Math.max(0, current.startTurn - older.startTurn);
  const prefix = older.turns.slice(0, prefixCount);
  return {
    turns: [...prefix, ...current.turns],
    startTurn: older.startTurn,
    endTurn: current.endTurn,
    totalTurns: Math.max(current.totalTurns, older.totalTurns),
    hasOlder: older.hasOlder,
  };
}

export function mergeLatestHistory(current: TurnHistoryWindow, latest: TurnHistoryWindow): TurnHistoryWindow {
  if (latest.startTurn <= current.startTurn) return latest;
  const keepCount = Math.max(0, latest.startTurn - current.startTurn);
  const preservedPrefix = current.turns.slice(0, keepCount);
  return {
    turns: [...preservedPrefix, ...latest.turns],
    startTurn: current.startTurn,
    endTurn: latest.endTurn,
    totalTurns: latest.totalTurns,
    hasOlder: current.startTurn > 0,
  };
}

export function mergeRichMessages(lhs: RichMessage, rhs: RichMessage): RichMessage {
  const parts = [lhs.text, rhs.text].filter(Boolean);
  return {
    role: lhs.role,
    text: parts.join('\n\n'),
    blocks: [...lhs.blocks, ...rhs.blocks],
  };
}

export function groupIntoTurns(msgs: RichMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn = { user: null, assistant: null };
  for (const m of msgs) {
    if (m.role === 'user') {
      if (cur.user || cur.assistant) { turns.push(cur); cur = { user: null, assistant: null }; }
      cur.user = m;
    } else if (cur.assistant) cur.assistant = mergeRichMessages(cur.assistant, m);
    else cur.assistant = m;
  }
  if (cur.user || cur.assistant) turns.push(cur);
  return turns;
}

/** Detect continuation/summary messages that Claude stores as role=user */
export function isContinuationSummary(text: string): boolean {
  if (text.length > 800) return true;
  const markers = ['continued from a previous', 'summary below covers', 'earlier portion of the conversation', 'Summary:', 'Key Technical Concepts'];
  return markers.some(m => text.includes(m));
}

export function lastNLines(text: string, n: number): string {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length <= n) return lines.join('\n');
  return lines.slice(-n).join('\n');
}

export type ComposerImageAttachment = { id: string; file: File; previewUrl: string };

export function makeComposerImageAttachment(file: File): ComposerImageAttachment {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    previewUrl: URL.createObjectURL(file),
  };
}

export function revokeComposerAttachments(items: ComposerImageAttachment[]) {
  for (const item of items) URL.revokeObjectURL(item.previewUrl);
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

export async function copyImageFile(file: File): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ [file.type || 'image/png']: file })]);
    return true;
  } catch {
    return false;
  }
}

export function parseSessionKey(sessionKey: string): { agent: string; sessionId: string } | null {
  const separator = sessionKey.indexOf(':');
  if (separator <= 0) return null;
  const agent = sessionKey.slice(0, separator).trim();
  const sessionId = sessionKey.slice(separator + 1).trim();
  if (!agent || !sessionId) return null;
  return { agent, sessionId };
}
