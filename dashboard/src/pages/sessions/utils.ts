import type { MessageBlock, RichMessage, SessionMessagesResult } from '../../types';

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
    usage: rhs.usage ?? lhs.usage ?? null,
  };
}

export function groupIntoTurns(msgs: RichMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn = { user: null, assistant: null };
  for (const m of msgs) {
    if (m.role === 'user') {
      // Continuation summaries mid-assistant should not start a new turn —
      // they are system-injected (context compression / interruption markers)
      // and the subsequent assistant blocks belong to the same logical response.
      if (cur.assistant && isContinuationSummary(m.text)) continue;
      if (cur.user || cur.assistant) { turns.push(cur); cur = { user: null, assistant: null }; }
      cur.user = m;
    } else if (cur.assistant) cur.assistant = mergeRichMessages(cur.assistant, m);
    else cur.assistant = m;
  }
  if (cur.user || cur.assistant) turns.push(cur);
  return turns;
}

/** Top-level XML wrappers Claude Code injects into role=user events for
 *  conversation infrastructure (background tasks, system reminders, IDE state,
 *  persisted-output truncations, etc.). Never render as a user bubble. */
const SYSTEM_INJECTED_USER_TAGS = new Set([
  'task-notification', 'system-reminder', 'persisted-output',
  'local-command-stdout', 'local-command-caveat', 'local-command-stderr',
  'ide_opened_file', 'ide_diagnostics', 'ide_selection', 'event',
  'analysis', 'case_id', 'tool-use-id', 'output-file',
]);

/** Inline phrase markers that identify Claude's auto-generated continuation
 *  summaries (injected as role=user when a thread is compacted). */
const CONTINUATION_MARKERS = [
  'continued from a previous',
  'summary below covers',
  'earlier portion of the conversation',
  'Summary:',
  'Key Technical Concepts',
];

/** Detect continuation/summary messages and system-injected events that Claude
 *  stores as role=user but never originated from the human. Detection is based
 *  on explicit tag/marker signatures only — never length — so legitimately long
 *  user content (pasted logs, code, pikiclaw's `<handover>` seed) still renders. */
export function isContinuationSummary(text: string): boolean {
  const trimmed = text.trim();
  const leading = trimmed.match(/^<([a-z][a-z0-9_-]*)\b/i);
  if (leading && SYSTEM_INJECTED_USER_TAGS.has(leading[1].toLowerCase())) return true;
  return CONTINUATION_MARKERS.some(m => text.includes(m));
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

function shortValue(value: unknown, max = 120): string {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : String(value);
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, Math.max(0, max - 1)) + '…';
}

function parseToolInput(content: string): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function summarizeToolUse(block: MessageBlock): string {
  const tool = String(block.toolName || '').trim() || 'Tool';
  const input = parseToolInput(block.content);
  if (!input) return tool;
  const description = shortValue(input.description, 120);
  switch (tool) {
    case 'Read': { const t = shortValue(input.file_path || input.path, 140); return t ? `Read ${t}` : 'Read'; }
    case 'Edit': { const t = shortValue(input.file_path || input.path, 140); return t ? `Edit ${t}` : 'Edit'; }
    case 'Write': { const t = shortValue(input.file_path || input.path, 140); return t ? `Write ${t}` : 'Write'; }
    case 'Glob': { const p = shortValue(input.pattern || input.glob, 120); return p ? `Glob ${p}` : 'Glob'; }
    case 'Grep': { const p = shortValue(input.pattern || input.query, 120); return p ? `Grep ${p}` : 'Grep'; }
    case 'WebFetch': { const u = shortValue(input.url, 120); return u ? `WebFetch ${u}` : 'WebFetch'; }
    case 'WebSearch': { const q = shortValue(input.query, 120); return q ? `WebSearch ${q}` : 'WebSearch'; }
    case 'TodoWrite': return 'Update plan';
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? (input.questions as any[]) : [];
      const first = qs[0];
      const q = shortValue(first?.question || input.question, 120);
      return q ? `Ask user: ${q}` : 'Ask user';
    }
    case 'Task': { const p = shortValue(input.description || input.prompt, 120); return p ? `Task: ${p}` : 'Task'; }
    case 'Bash': {
      if (description) return `Bash: ${description}`;
      const c = shortValue(input.command, 120);
      return c ? `Bash: ${c}` : 'Bash';
    }
    default: {
      const mcp = tool.match(/^mcp__[^_]+__(.+)$/);
      const bare = mcp ? mcp[1] : tool;
      if (bare === 'im_send_file') { const p = shortValue(input.path, 120); return p ? `Send file: ${p}` : 'Send file'; }
      if (bare === 'im_list_files') return 'List workspace files';
      if (description) return `${tool}: ${description}`;
      const d = shortValue(input.file_path || input.path || input.command || input.query || input.pattern || input.url, 120);
      return d ? `${tool}: ${d}` : tool;
    }
  }
}

export function summarizeToolResult(block: MessageBlock): string {
  const raw = (block.content || '').trim();
  if (!raw) return 'result';
  const firstLine = raw.split('\n').map(l => l.trim()).find(Boolean) || '';
  return firstLine ? shortValue(firstLine, 140) : 'result';
}

export function parseSessionKey(sessionKey: string): { agent: string; sessionId: string } | null {
  const separator = sessionKey.indexOf(':');
  if (separator <= 0) return null;
  const agent = sessionKey.slice(0, separator).trim();
  const sessionId = sessionKey.slice(separator + 1).trim();
  if (!agent || !sessionId) return null;
  return { agent, sessionId };
}
