import type { Agent } from './types';
import type { SessionInfo } from './types';

export function fmtBytes(b: number): string {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(0) + 'KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + 'MB';
  if (b < 1099511627776) return (b / 1073741824).toFixed(1) + 'GB';
  return (b / 1099511627776).toFixed(1) + 'TB';
}

export function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h < 24 ? h + 'h ' + (m % 60) + 'm' : Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

export function fmtTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(iso?: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return '<1m';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  return d + 'd';
}

export function cn(...classes: (string | false | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

export interface AgentMeta {
  label: string;
  /** Shortened label for compact UI (sidebar cards, etc.) */
  shortLabel: string;
  color: string;
  bg: string;
  letter: string;
  glow: string;
  border: string;
  advantageKey: string;
}

const defaultMeta: AgentMeta = {
  label: '?',
  shortLabel: '?',
  color: '#94a3b8',
  bg: 'rgba(148,163,184,0.1)',
  letter: '?',
  glow: 'rgba(148,163,184,0.16)',
  border: 'rgba(148,163,184,0.18)',
  advantageKey: '',
};

export const agentMeta: Record<string, AgentMeta> = {
  claude: {
    label: 'Claude Code',
    shortLabel: 'Claude',
    color: '#b4c6ff',
    bg: 'rgba(180,198,255,0.12)',
    letter: 'C',
    glow: 'rgba(180,198,255,0.2)',
    border: 'rgba(180,198,255,0.2)',
    advantageKey: 'config.agentAdvantageClaude',
  },
  codex: {
    label: 'Codex',
    shortLabel: 'Codex',
    color: '#7dd3fc',
    bg: 'rgba(125,211,252,0.12)',
    letter: 'O',
    glow: 'rgba(125,211,252,0.2)',
    border: 'rgba(125,211,252,0.2)',
    advantageKey: 'config.agentAdvantageCodex',
  },
  gemini: {
    label: 'Gemini CLI',
    shortLabel: 'Gemini',
    color: '#c4b5fd',
    bg: 'rgba(196,181,253,0.12)',
    letter: 'G',
    glow: 'rgba(196,181,253,0.2)',
    border: 'rgba(196,181,253,0.2)',
    advantageKey: 'config.agentAdvantageGemini',
  },
};

export function getAgentMeta(agent: string): AgentMeta {
  return agentMeta[agent] || { ...defaultMeta, label: agent, shortLabel: agent };
}

export const EFFORT_OPTIONS: Record<Agent, string[]> = {
  claude: ['low', 'medium', 'high', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  gemini: [],
};

/**
 * Shorten a model ID for compact display.
 *   claude-opus-4-7          → opus-4-7
 *   claude-sonnet-4-6        → sonnet-4-6
 *   claude-haiku-4-5-20251001 → haiku-4-5
 *   gemini-2.5-pro-preview   → 2.5-pro
 *   gpt-4o-mini              → 4o-mini
 *   o3                       → o3
 */
export function shortenModel(model: string): string {
  let s = model;
  // strip trailing date stamps like -20251001
  s = s.replace(/-\d{8,}$/, '');
  // strip trailing -preview / -latest
  s = s.replace(/-(preview|latest|exp)$/, '');
  // strip agent prefixes
  s = s.replace(/^(claude-|gemini-|gpt-)/, '');
  return s;
}

export type SessionDisplayState = 'running' | 'completed' | 'incomplete';
export function sessionDisplayState(session: Pick<SessionInfo, 'running' | 'runState'>): SessionDisplayState {
  if (session.running || session.runState === 'running') return 'running';
  return session.runState === 'incomplete' ? 'incomplete' : 'completed';
}

export interface LiveSessionState {
  key: string;
  resolvedKey: string;
  phase: 'queued' | 'streaming' | 'done';
  sessionId: string | null;
  updatedAt: number;
  incomplete: boolean;
  error: string | null;
}

function parseSessionKey(sessionKey: string): { agent: string; sessionId: string } | null {
  const separator = sessionKey.indexOf(':');
  if (separator <= 0) return null;
  const agent = sessionKey.slice(0, separator).trim();
  const sessionId = sessionKey.slice(separator + 1).trim();
  if (!agent || !sessionId) return null;
  return { agent, sessionId };
}

export function normalizeLiveSessionState(sessionKey: string, snapshot: unknown): LiveSessionState | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const rawPhase = typeof (snapshot as any).phase === 'string' ? (snapshot as any).phase.trim() : '';
  if (rawPhase !== 'queued' && rawPhase !== 'streaming' && rawPhase !== 'done') return null;

  const parsedKey = parseSessionKey(sessionKey);
  if (!parsedKey) return null;

  const sessionId = typeof (snapshot as any).sessionId === 'string' && (snapshot as any).sessionId.trim()
    ? (snapshot as any).sessionId.trim()
    : null;
  const updatedAt = typeof (snapshot as any).updatedAt === 'number' && Number.isFinite((snapshot as any).updatedAt)
    ? (snapshot as any).updatedAt
    : Date.now();
  const error = typeof (snapshot as any).error === 'string' && (snapshot as any).error.trim()
    ? (snapshot as any).error.trim()
    : null;
  const resolvedKey = sessionId ? `${parsedKey.agent}:${sessionId}` : sessionKey;

  return {
    key: sessionKey,
    resolvedKey,
    phase: rawPhase,
    sessionId,
    updatedAt,
    incomplete: !!(snapshot as any).incomplete || !!error,
    error,
  };
}

export function applyLiveSessionState(session: SessionInfo, liveState?: LiveSessionState | null): SessionInfo {
  if (!liveState) return session;

  const nextRunState: SessionDisplayState = liveState.phase === 'done'
    ? (liveState.incomplete ? 'incomplete' : 'completed')
    : 'running';

  return {
    ...session,
    running: nextRunState === 'running',
    runState: nextRunState,
    runUpdatedAt: new Date(liveState.updatedAt).toISOString(),
    runDetail: nextRunState === 'running'
      ? null
      : (liveState.error || session.runDetail || null),
  };
}

export function sessionDisplayDetail(session: Pick<SessionInfo, 'runDetail'>): string | null {
  const detail = String(session.runDetail || '').trim();
  return detail || null;
}

const SESSION_PREVIEW_IGNORED_USER_PATTERNS = [
  /^\[Request interrupted by user(?: for tool use)?\]$/i,
];

const SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE = /\[Image:[^\]]+\]/gi;
const SESSION_PREVIEW_FILE_PLACEHOLDER_RE = /\[Attached file:[^\]]+\]/gi;

function cleanSessionPreviewText(text?: string | null): string {
  return String(text || '')
    .replace(SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE, ' ')
    .replace(SESSION_PREVIEW_FILE_PLACEHOLDER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMeaningfulLine(text?: string | null): string {
  for (const line of String(text || '').split('\n')) {
    const cleaned = cleanSessionPreviewText(line)
      .replace(/^[#>*\-\s`]+/, '')
      .trim();
    if (cleaned) return cleaned;
  }
  return '';
}

export function sanitizeSessionQuestionPreview(text?: string | null): string {
  const cleaned = cleanSessionPreviewText(text);
  if (!cleaned) return '';
  if (SESSION_PREVIEW_IGNORED_USER_PATTERNS.some(pattern => pattern.test(cleaned))) return '';
  return cleaned;
}

export function sessionListDisplayText(session: Pick<SessionInfo, 'lastQuestion' | 'title' | 'sessionId'>): string {
  return cleanSessionPreviewText(session.title) || sanitizeSessionQuestionPreview(session.lastQuestion) || session.sessionId;
}

export function sessionListContextText(
  session: Pick<SessionInfo, 'title' | 'lastAnswer' | 'classification' | 'runDetail' | 'sessionId'>,
  primary: string,
): string {
  const title = cleanSessionPreviewText(session.title);
  if (title && title !== primary) return title;

  const summary = firstMeaningfulLine(session.classification?.summary);
  if (summary && summary !== primary) return summary;

  const answer = firstMeaningfulLine(session.lastAnswer);
  if (answer && answer !== primary) return answer;

  const detail = cleanSessionPreviewText(session.runDetail);
  if (detail && !/interrupted by user/i.test(detail) && detail !== primary) return detail;

  return '';
}
