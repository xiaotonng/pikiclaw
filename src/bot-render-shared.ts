/**
 * bot-render-shared.ts — Shared rendering logic used by both Telegram and Feishu renderers.
 *
 * Contains types, pure-data helpers, and functions that are identical across platforms.
 * Platform-specific formatting (HTML vs Markdown) stays in the respective render files.
 */

import type { Agent, StreamPreviewMeta, StreamPreviewPlan, StreamResult } from './bot.js';
import { fmtUptime, formatThinkingForDisplay, thinkLabel } from './bot.js';
import { formatActivityCommandSummary, parseActivitySummary, renderPlanForPreview, summarizeActivityForPreview } from './bot-streaming.js';

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

export function formatFooterSummary(
  agent: Agent,
  elapsedMs: number,
  meta?: StreamPreviewMeta | null,
  contextPercent?: number | null,
): string {
  const parts: string[] = [agent];
  const ctx = contextPercent ?? meta?.contextPercent ?? null;
  if (ctx != null) parts.push(`${ctx}%`);
  parts.push(fmtCompactUptime(Math.max(0, Math.round(elapsedMs))));
  return parts.join(' · ');
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
  footerSummary: string;
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
  const footerSummary = formatFooterSummary(agent, elapsedMs, null, result.contextPercent ?? null);

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
    footerSummary,
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
