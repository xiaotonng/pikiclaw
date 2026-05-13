/**
 * Cross-agent conversation handover.
 *
 * When the user switches agent mid-thread (Claude → Gemini, Codex → Claude, …)
 * the new session has no shared state with the source. Rather than maintain a
 * parallel "thread transcript" inside pikiclaw — which would force us to track
 * every agent's evolving session format — we let each agent own its session
 * file and bridge across the gap with a one-shot compaction at the switch.
 *
 * `compactForHandover` reads the source agent's session, formats its turns into
 * a `<handover>` envelope, and returns a seed string that callers prepend to
 * the new agent's first user prompt. After that first turn the new agent's own
 * session file is the canonical context — handover never fires again for that
 * session.
 */

import type { Agent, HandoverRef, TailMessage } from './types.js';
import { getSessionMessages } from './session.js';

// ---------------------------------------------------------------------------
// Budget heuristics
// ---------------------------------------------------------------------------

/**
 * Rough per-agent default context window (tokens). Used only to size the
 * handover budget — driver-side accurate windows still flow into usage reporting
 * via each driver's own contextWindow logic. Conservative: when in doubt,
 * underestimate so we don't pack the new turn into a window the model can't
 * handle.
 */
const DEFAULT_AGENT_WINDOW_TOKENS: Record<string, number> = {
  claude: 200_000,
  codex: 256_000,
  gemini: 1_000_000,
  hermes: 128_000,
};

function agentWindowTokens(agent: string, model?: string | null): number {
  const m = (model || '').toLowerCase();
  if (agent === 'gemini' && /(^|-)(2\.5|3|3\.1)/.test(m)) return 1_000_000;
  if (agent === 'claude' && /(opus|sonnet|haiku).*?-?(4|4\.\d)/.test(m)) return 200_000;
  return DEFAULT_AGENT_WINDOW_TOKENS[agent] ?? 128_000;
}

/**
 * Fraction of the target agent's window that the handover is allowed to
 * consume. Leaves headroom for the user's own prompt and the model's response.
 */
const HANDOVER_WINDOW_FRACTION = 0.5;

/** Rough chars-per-token estimate; agnostic, fine for budgeting. */
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type HandoverMode = 'verbatim' | 'tail' | 'empty';

export interface CompactForHandoverOpts {
  fromAgent: Agent;
  fromSessionId: string;
  workdir: string;
  toAgent: Agent;
  toModel?: string | null;
}

export interface HandoverResult {
  ok: boolean;
  seed: string;
  mode: HandoverMode;
  /** Number of individual messages (one per role per turn) packed into the seed. */
  messagesIncluded: number;
  /** Total messages available in the source session (every role, every turn). */
  messagesTotal: number;
  /** Conversation turns (user+assistant pairs) in the source session, for reporting. */
  turnsTotal: number;
  charsIncluded: number;
  budgetChars: number;
  error: string | null;
}

export function makeEmptyHandoverResult(error: string | null = null): HandoverResult {
  return { ok: false, seed: '', mode: 'empty', messagesIncluded: 0, messagesTotal: 0, turnsTotal: 0, charsIncluded: 0, budgetChars: 0, error };
}

export function describeHandoverRef(ref: HandoverRef | null | undefined): string {
  if (!ref) return '(none)';
  return `${ref.agent}:${ref.sessionId}`;
}

/**
 * Read the source agent's session and produce a seed string suitable for
 * prepending to the new agent's first user prompt.
 *
 * Strategy: pack as many turns as the target window allows, from newest to
 * oldest. If everything fits — verbatim mode. If we had to drop older turns —
 * tail mode (we still keep recent context, just less than the full history).
 * If we couldn't read the source session at all — empty mode (seed is '').
 *
 * Never throws: read failures degrade to `mode: 'empty'` so the caller can
 * proceed with the user's prompt alone.
 */
export async function compactForHandover(opts: CompactForHandoverOpts): Promise<HandoverResult> {
  const windowTokens = agentWindowTokens(opts.toAgent, opts.toModel);
  const budgetChars = Math.floor(windowTokens * HANDOVER_WINDOW_FRACTION * CHARS_PER_TOKEN);

  let messages: TailMessage[] = [];
  let turnsTotal = 0;
  try {
    const result = await getSessionMessages({
      agent: opts.fromAgent,
      sessionId: opts.fromSessionId,
      workdir: opts.workdir,
    });
    if (!result.ok) {
      return { ...makeEmptyHandoverResult(result.error || 'read failed'), budgetChars };
    }
    messages = result.messages || [];
    turnsTotal = result.totalTurns ?? Math.ceil(messages.length / 2);
  } catch (e: any) {
    return { ...makeEmptyHandoverResult(e?.message || String(e)), budgetChars };
  }

  if (!messages.length) {
    return { ...makeEmptyHandoverResult('no messages'), budgetChars };
  }

  const messagesTotal = messages.length;
  // Open the envelope first so its overhead is part of the budget calculation.
  const envelopeOpen = `<handover from="${opts.fromAgent}" to="${opts.toAgent}" turns="${turnsTotal}">`;
  const envelopeClose = `</handover>`;
  const trailerText = `\n[Continuing this conversation. The previous turns above ran under ${opts.fromAgent}; you are now ${opts.toAgent} picking up where it left off. Your next user message follows.]`;
  const overhead = envelopeOpen.length + envelopeClose.length + trailerText.length + 8 /* newlines */;
  const messageBudget = Math.max(0, budgetChars - overhead);

  // Pack newest-to-oldest so the most recent context is preserved when we run
  // out of budget. Reverse back to chronological for the seed text.
  const lines: string[] = [];
  let used = 0;
  let kept = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    const line = `${label}: ${msg.text}`;
    if (used + line.length + 1 > messageBudget) break;
    lines.push(line);
    used += line.length + 1;
    kept += 1;
  }
  lines.reverse();

  if (!lines.length) {
    return { ...makeEmptyHandoverResult('budget too small'), budgetChars };
  }

  const seed = [envelopeOpen, ...lines, envelopeClose, trailerText].join('\n');
  const mode: HandoverMode = kept >= messages.length ? 'verbatim' : 'tail';

  return {
    ok: true,
    seed,
    mode,
    messagesIncluded: kept,
    messagesTotal,
    turnsTotal,
    charsIncluded: used,
    budgetChars,
    error: null,
  };
}
