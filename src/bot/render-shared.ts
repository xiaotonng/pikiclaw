/**
 * Shared rendering utilities used by channel-specific renderers.
 *
 * Contains types, pure-data helpers, and functions that are identical across platforms.
 * Platform-specific formatting (HTML vs Markdown) stays in the respective render files.
 */

import type { Agent, StreamPreviewMeta, StreamPreviewPlan, StreamResult } from './bot.js';
import { fmtUptime, formatThinkingForDisplay, thinkLabel } from './bot.js';
import { formatActivityCommandSummary, parseActivitySummary, renderPlanForPreview, summarizeActivityForPreview } from './streaming.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FooterStatus = 'running' | 'done' | 'failed';

export interface ProviderUsageSnapshot {
  ok: boolean;
  capturedAt: string | null;
  status: string | null;
  windows: Array<{
    label: string;
    usedPercent: number | null;
    remainingPercent: number | null;
    resetAfterSeconds: number | null;
    status: string | null;
  }>;
  error: string | null;
}

export interface StreamPreviewRenderInput {
  agent: Agent;
  elapsedMs: number;
  bodyText: string;
  thinking: string;
  activity: string;
  meta?: StreamPreviewMeta | null;
  plan?: StreamPreviewPlan | null;
  /** Resolved model id for the active turn — surfaced in the running footer. */
  model?: string | null;
  /** Resolved thinking-effort for the active turn — surfaced in the running footer. */
  effort?: string | null;
}

// ---------------------------------------------------------------------------
// GFM table parsing
// ---------------------------------------------------------------------------

/** Parse GFM table lines into structured headers + rows. */
export function parseGfmTable(tableLines: string[]): { headers: string[]; rows: string[][] } | null {
  if (tableLines.length < 3) return null;
  const parseRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const isSep = (line: string) => {
    const cells = parseRow(line);
    return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c));
  };

  let headerIdx = -1;
  for (let i = 0; i < tableLines.length - 1; i++) {
    if (isSep(tableLines[i + 1])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return null;

  const headers = parseRow(tableLines[headerIdx]);
  const rows: string[][] = [];
  for (let i = headerIdx + 2; i < tableLines.length; i++) {
    if (isSep(tableLines[i])) continue;
    rows.push(parseRow(tableLines[i]));
  }
  return rows.length ? { headers, rows } : null;
}

// ---------------------------------------------------------------------------
// Footer helpers
// ---------------------------------------------------------------------------

export function fmtCompactUptime(ms: number): string {
  return fmtUptime(ms).replace(/\s+/g, '');
}

export function footerStatusSymbol(status: FooterStatus): string {
  switch (status) {
    case 'running': return '●';
    case 'done': return '✓';
    case 'failed': return '✗';
  }
}

export interface FooterDecorations {
  model?: string | null;
  effort?: string | null;
  /**
   * BYOK provider name (e.g. "OpenRouter"). Optional fallback for callers
   * that don't pipe `meta.providerName`; preview-meta-based renders should
   * not need to set this explicitly.
   */
  provider?: string | null;
}

export interface FooterParts {
  /** Identity line — `agent` or `agent · model`. */
  identity: string;
  /** Runtime line — `effort? · ctx%? · time`. Always contains at least the elapsed time. */
  runtime: string;
}

/**
 * Drop a leading `provider/` segment from long model ids so the footer stays
 * readable on narrow IM clients. `anthropic/claude-sonnet-4` → `claude-sonnet-4`,
 * `deepseek/deepseek-v4-flash` → `deepseek-v4-flash`. Already-short ids are
 * returned unchanged.
 */
function compactModelLabel(model: string): string {
  const trimmed = model.trim();
  if (trimmed.length <= 24) return trimmed;
  const slashIdx = trimmed.indexOf('/');
  return slashIdx > 0 ? trimmed.slice(slashIdx + 1) : trimmed;
}

/**
 * Split footer fields into a primary identity line (agent + model) and a
 * secondary runtime line (effort, context%, elapsed). Channel renderers
 * compose the two lines with their own visual styling so narrow IM clients
 * never have to soft-wrap a single dense line.
 */
export function formatFooterParts(
  agent: Agent,
  elapsedMs: number,
  meta?: StreamPreviewMeta | null,
  contextPercent?: number | null,
  decorations?: FooterDecorations,
): FooterParts {
  const identityParts: string[] = [agent];
  if (decorations?.model) identityParts.push(compactModelLabel(decorations.model));

  const runtimeParts: string[] = [];
  if (decorations?.effort) runtimeParts.push(decorations.effort);
  const ctx = contextPercent ?? meta?.contextPercent ?? null;
  if (ctx != null) runtimeParts.push(`${ctx}%`);
  runtimeParts.push(fmtCompactUptime(Math.max(0, Math.round(elapsedMs))));
  // BYOK attribution — tells the user the turn is being routed through a
  // third-party provider rather than the agent CLI's native auth path.
  // Tucked at the end of the runtime line so it doesn't crowd the (often
  // long) identity line on narrow IM clients.
  const providerName = meta?.providerName ?? decorations?.provider ?? null;
  if (providerName) runtimeParts.push(`via ${providerName}`);

  return {
    identity: identityParts.join(' · '),
    runtime: runtimeParts.join(' · '),
  };
}

// ---------------------------------------------------------------------------
// Activity trimming
// ---------------------------------------------------------------------------

export function trimActivityForPreview(text: string, maxChars = 900): string {
  if (text.length <= maxChars) return text;

  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length <= 1) return text.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...';

  const tailCount = Math.min(2, Math.max(1, lines.length - 1));
  const tail = lines.slice(-tailCount);
  const headCandidates = lines.slice(0, Math.max(0, lines.length - tailCount));
  const reserved = tail.join('\n').length + 5;
  const budget = Math.max(0, maxChars - reserved);
  const head: string[] = [];
  let used = 0;

  for (const line of headCandidates) {
    const extra = line.length + (head.length ? 1 : 0);
    if (used + extra > budget) break;
    head.push(line);
    used += extra;
  }

  if (!head.length) return text.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...';
  return [...head, '...', ...tail].join('\n');
}

// ---------------------------------------------------------------------------
// Provider usage (plain-text builder — caller wraps as needed)
// ---------------------------------------------------------------------------

function rawUsageLine(parts: Array<string | null | undefined>): string {
  return parts.filter(part => !!part && String(part).trim()).join(' ');
}

export interface ProviderUsageLine {
  text: string;
  bold?: boolean;
}

export function buildProviderUsageLines(usage: ProviderUsageSnapshot): ProviderUsageLine[] {
  const lines: ProviderUsageLine[] = [
    { text: '', bold: false },
    { text: 'Provider Usage', bold: true },
  ];

  if (!usage.ok) {
    lines.push({ text: `  Unavailable: ${usage.error || 'No recent usage data found.'}` });
    return lines;
  }

  if (usage.capturedAt) {
    const capturedAtMs = Date.parse(usage.capturedAt);
    if (Number.isFinite(capturedAtMs)) {
      lines.push({ text: `  Updated: ${fmtUptime(Math.max(0, Date.now() - capturedAtMs))} ago` });
    }
  }

  if (!usage.windows.length) {
    lines.push({ text: `  ${usage.status ? `status=${usage.status}` : 'No window data'}` });
    return lines;
  }

  for (const window of usage.windows) {
    const details = rawUsageLine([
      window.usedPercent != null ? `${window.usedPercent}% used` : null,
      window.status ? `status=${window.status}` : null,
      window.resetAfterSeconds != null ? `resetAfterSeconds=${window.resetAfterSeconds}` : null,
    ]);
    lines.push({ text: `  ${window.label}: ${details || 'No details'}` });
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Final reply data extraction — shared computation, platform-specific wrap
// ---------------------------------------------------------------------------

export interface FinalReplyData {
  footerStatus: FooterStatus;
  activityNarrative: string | null;
  activityCommandSummary: string | null;
  thinkingDisplay: string | null;
  thinkLabel: string;
  statusLines: string[] | null;
  bodyMessage: string;
  elapsedMs: number;
}

export function extractFinalReplyData(agent: Agent, result: StreamResult): FinalReplyData {
  const footerStatus: FooterStatus = result.incomplete || !result.ok ? 'failed' : 'done';
  const elapsedMs = result.elapsedS * 1000;

  let activityNarrative: string | null = null;
  let activityCommandSummary: string | null = null;
  if (result.activity) {
    const summary = parseActivitySummary(result.activity);
    const narrative = summary.narrative.join('\n');
    if (narrative) {
      activityNarrative = narrative.length > 1600 ? '...\n' + narrative.slice(-1600) : narrative;
    }
    const cmdSummary = formatActivityCommandSummary(
      summary.completedCommands,
      summary.activeCommands,
      summary.failedCommands,
    );
    if (cmdSummary) activityCommandSummary = cmdSummary;
  }

  let thinkingDisplay: string | null = null;
  if (result.thinking) {
    thinkingDisplay = formatThinkingForDisplay(result.thinking, 1600);
  }

  let statusLines: string[] | null = null;
  if (result.incomplete) {
    statusLines = [];
    if (result.stopReason === 'max_tokens') statusLines.push('Output limit reached. Response may be truncated.');
    if (result.stopReason === 'timeout') {
      statusLines.push(`Timed out after ${fmtUptime(Math.max(0, Math.round(elapsedMs)))} before the agent reported completion.`);
    }
    if (!result.ok) {
      const detail = result.error?.trim();
      if (detail && detail !== result.message.trim() && !statusLines.includes(detail)) statusLines.push(detail);
      else if (result.stopReason !== 'timeout') statusLines.push('Agent exited before reporting completion.');
    }
  }

  return {
    footerStatus,
    activityNarrative,
    activityCommandSummary,
    thinkingDisplay,
    thinkLabel: thinkLabel(agent),
    statusLines,
    bodyMessage: result.message,
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// Stream preview data extraction — shared computation, platform-specific wrap
// ---------------------------------------------------------------------------

export interface StreamPreviewData {
  display: string;
  rawThinking: string;
  thinkDisplay: string;
  planDisplay: string;
  activityDisplay: string;
  maxActivity: number;
  label: string;
  thinkSnippet: string;
  preview: string;
}

export function extractStreamPreviewData(input: StreamPreviewRenderInput): StreamPreviewData {
  const maxBody = 2400;
  const display = input.bodyText.trim();
  const rawThinking = input.thinking.trim();
  const thinkDisplay = formatThinkingForDisplay(input.thinking, maxBody);
  const planDisplay = renderPlanForPreview(input.plan ?? null);
  const activityDisplay = summarizeActivityForPreview(input.activity);
  const maxActivity = !display && !thinkDisplay && !planDisplay ? 2400 : 1400;
  const label = thinkLabel(input.agent);

  const thinkSnippet = rawThinking ? formatThinkingForDisplay(input.thinking, 600) : '';
  const preview = display.length > maxBody ? '(...truncated)\n' + display.slice(-maxBody) : display;

  return {
    display,
    rawThinking,
    thinkDisplay,
    planDisplay,
    activityDisplay,
    maxActivity,
    label,
    thinkSnippet,
    preview,
  };
}
