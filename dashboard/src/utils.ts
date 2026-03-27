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
 *   claude-opus-4-6          → opus-4-6
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
export type SessionStreamPhase = 'queued' | 'streaming' | 'done';

export function sessionDisplayState(session: Pick<SessionInfo, 'running' | 'runState'>): SessionDisplayState {
  if (session.running || session.runState === 'running') return 'running';
  return session.runState === 'incomplete' ? 'incomplete' : 'completed';
}

export function shouldPollSessionStreamState(
  displayState: SessionDisplayState,
  localStreamPending: boolean,
  phase: SessionStreamPhase | null | undefined,
  previousPhase: SessionStreamPhase | null | undefined,
): boolean {
  if (phase === 'queued' || phase === 'streaming') return true;
  if (phase === 'done') return false;
  if (previousPhase === 'queued' || previousPhase === 'streaming' || previousPhase === 'done') return false;
  return displayState === 'running' || localStreamPending;
}

export function sessionDisplayDetail(session: Pick<SessionInfo, 'runDetail'>): string | null {
  const detail = String(session.runDetail || '').trim();
  return detail || null;
}

const SESSION_PREVIEW_IGNORED_USER_PATTERNS = [
  /^\[Request interrupted by user(?: for tool use)?\]$/i,
];

export function sanitizeSessionQuestionPreview(text?: string | null): string {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '';
  if (SESSION_PREVIEW_IGNORED_USER_PATTERNS.some(pattern => pattern.test(cleaned))) return '';
  return cleaned;
}

export function sessionListDisplayText(session: Pick<SessionInfo, 'lastQuestion' | 'title' | 'sessionId'>): string {
  return sanitizeSessionQuestionPreview(session.lastQuestion) || session.title || session.sessionId;
}
