/**
 * bot-feishu-render.ts — Feishu-specific rendering.
 *
 * Converts structured data from bot-commands.ts into Feishu Markdown (for interactive cards).
 * Also provides a LivePreviewRenderer for streaming output.
 */

import type { Agent, StreamResult, StreamPreviewMeta } from './bot.js';
import { fmtUptime, fmtTokens, fmtBytes, formatThinkingForDisplay, thinkLabel } from './bot.js';
import type { StartData, SessionsPageData, AgentsListData, ModelsListData, StatusData, HostData } from './bot-commands.js';
import { summarizePromptForStatus } from './bot-commands.js';
import { formatProviderUsageLines } from './bot-telegram-render.js';
import type { LivePreviewRenderer } from './bot-telegram-live-preview.js';
import type { StreamPreviewRenderInput } from './bot-telegram-render.js';
import { formatActivityCommandSummary, parseActivitySummary, renderPlanForPreview, summarizeActivityForPreview } from './bot-streaming.js';
import type { FeishuCardActionItem, FeishuCardActionRow, FeishuCardView } from './channel-feishu.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCompactUptime(ms: number): string {
  return fmtUptime(ms).replace(/\s+/g, '');
}

type FooterStatus = 'running' | 'done' | 'failed';

function footerStatusSymbol(status: FooterStatus): string {
  switch (status) {
    case 'running': return '●';
    case 'done': return '✓';
    case 'failed': return '✗';
  }
}

function formatFooterSummary(
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

function formatPreviewFooter(agent: Agent, elapsedMs: number, meta?: StreamPreviewMeta | null): string {
  return `${footerStatusSymbol('running')} ${formatFooterSummary(agent, elapsedMs, meta)}`;
}

function formatFinalFooter(status: FooterStatus, agent: Agent, elapsedMs: number, contextPercent?: number | null): string {
  return `${footerStatusSymbol(status)} ${formatFooterSummary(agent, elapsedMs, null, contextPercent ?? null)}`;
}

function trimActivityForPreview(text: string, maxChars = 900): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n').filter(l => l.trim());
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

function truncateLabel(label: string, maxChars = 24): string {
  return label.length > maxChars ? `${label.slice(0, Math.max(1, maxChars - 1))}…` : label;
}

function cardButton(label: string, action: string, primary = false): FeishuCardActionItem {
  const button: any = {
    tag: 'button',
    text: { tag: 'plain_text', content: truncateLabel(label) },
    value: { action },
  };
  if (primary) button.type = 'primary';
  return button;
}

function cardRows(actions: FeishuCardActionItem[], size = 3): FeishuCardActionRow[] {
  const rows: FeishuCardActionRow[] = [];
  for (let i = 0; i < actions.length; i += size) {
    const rowActions = actions.slice(i, i + size);
    if (!rowActions.length) continue;
    rows.push({ actions: rowActions });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// LivePreview renderer — produces Markdown for Feishu card elements
// ---------------------------------------------------------------------------

export function buildInitialPreviewMarkdown(agent: Agent): string {
  return formatPreviewFooter(agent, 0);
}

export function buildStreamPreviewMarkdown(input: StreamPreviewRenderInput): string {
  const maxBody = 2400;
  const display = input.bodyText.trim();
  const rawThinking = input.thinking.trim();
  const thinkDisplay = formatThinkingForDisplay(input.thinking, maxBody);
  const planDisplay = renderPlanForPreview(input.plan ?? null);
  const activityDisplay = summarizeActivityForPreview(input.activity);
  const maxActivity = !display && !thinkDisplay && !planDisplay ? 1800 : 900;
  const parts: string[] = [];
  const label = thinkLabel(input.agent);

  if (planDisplay) {
    parts.push(`**Plan**\n${planDisplay}`);
  }

  if (activityDisplay) {
    parts.push(`**Activity**\n${trimActivityForPreview(activityDisplay, maxActivity)}`);
  }

  if (thinkDisplay && !display) {
    parts.push(`**${label}**\n${thinkDisplay}`);
  } else if (display) {
    if (rawThinking) parts.push(`*${label} (${rawThinking.length} chars)*`);
    const preview = display.length > maxBody ? '(...truncated)\n' + display.slice(-maxBody) : display;
    parts.push(preview);
  }

  parts.push(formatPreviewFooter(input.agent, input.elapsedMs, input.meta ?? null));
  return parts.join('\n\n');
}

export const feishuPreviewRenderer: LivePreviewRenderer = {
  renderInitial: buildInitialPreviewMarkdown,
  renderStream: buildStreamPreviewMarkdown,
};

// ---------------------------------------------------------------------------
// Final reply render
// ---------------------------------------------------------------------------

export interface FeishuFinalReplyRender {
  fullText: string;
  headerText: string;
  bodyText: string;
  footerText: string;
}

export function buildFinalReplyRender(agent: Agent, result: StreamResult): FeishuFinalReplyRender {
  const footerStatus: FooterStatus = result.incomplete || !result.ok ? 'failed' : 'done';
  const footerText = `\n\n${formatFinalFooter(footerStatus, agent, result.elapsedS * 1000, result.contextPercent ?? null)}`;

  let activityText = '';
  let activityNoteText = '';
  if (result.activity) {
    const summary = parseActivitySummary(result.activity);
    const narrative = summary.narrative.join('\n');
    if (narrative) {
      let display = narrative;
      if (display.length > 800) display = '...\n' + display.slice(-800);
      activityText = `**Activity**\n${display}\n\n`;
    }
    const commandSummary = formatActivityCommandSummary(
      summary.completedCommands,
      summary.activeCommands,
      summary.failedCommands,
    );
    if (commandSummary) activityNoteText = `*${commandSummary}*\n\n`;
  }

  let thinkingText = '';
  if (result.thinking) {
    thinkingText = `**${thinkLabel(agent)}**\n${formatThinkingForDisplay(result.thinking, 800)}\n\n`;
  }

  let statusText = '';
  if (result.incomplete) {
    const statusLines: string[] = [];
    if (result.stopReason === 'max_tokens') statusLines.push('Output limit reached. Response may be truncated.');
    if (result.stopReason === 'timeout') {
      statusLines.push(`Timed out after ${fmtUptime(Math.max(0, Math.round(result.elapsedS * 1000)))} before the agent reported completion.`);
    }
    if (!result.ok) {
      const detail = result.error?.trim();
      if (detail && detail !== result.message.trim() && !statusLines.includes(detail)) statusLines.push(detail);
      else if (result.stopReason !== 'timeout') statusLines.push('Agent exited before reporting completion.');
    }
    statusText = `**⚠ Incomplete Response**\n${statusLines.join('\n')}\n\n`;
  }

  const headerText = `${activityText}${activityNoteText}${statusText}${thinkingText}`;
  const bodyText = result.message;
  return {
    fullText: `${headerText}${bodyText}${footerText}`,
    headerText,
    bodyText,
    footerText,
  };
}

// ---------------------------------------------------------------------------
// Command renderers — produce Markdown for Feishu cards
// ---------------------------------------------------------------------------

export function renderStart(d: StartData): string {
  const lines = [
    `**${d.title}** v${d.version}`,
    d.subtitle,
    '',
    `**Agent:** ${d.agent}`,
    `**Workdir:** \`${d.workdir}\``,
    '',
    '**Commands**',
    ...d.commands.map(c => `/${c.command} — ${c.description}`),
  ];
  return lines.join('\n');
}

export function renderSessionsPage(d: SessionsPageData): string {
  const lines = [
    `**${d.agent} sessions** (${d.total})  p${d.page + 1}/${d.totalPages}`,
    '',
  ];

  if (!d.sessions.length) {
    lines.push('*No sessions found.*');
  } else {
    for (let i = 0; i < d.sessions.length; i++) {
      const s = d.sessions[i];
      const icon = s.isRunning ? '🟢' : s.isCurrent ? '●' : '○';
      lines.push(`${icon} **${i + 1}.** ${s.title}  ${s.time}${s.isCurrent ? ' ← current' : ''}`);
    }
    lines.push('');
    lines.push('*Use the controls below to switch, or reply with session number / "new".*');
  }

  if (d.totalPages > 1) {
    lines.push(`\nPage ${d.page + 1}/${d.totalPages}. Use the page controls below or reply "p2", "p3" etc. to navigate.`);
  }
  return lines.join('\n');
}

export function renderAgentsList(d: AgentsListData): string {
  const lines = ['**Available Agents**', ''];
  for (const a of d.agents) {
    const status = !a.installed ? '❌' : a.isCurrent ? '●' : '○';
    lines.push(`${status} **${a.agent}**${a.isCurrent ? ' (current)' : ''}`);
    if (a.installed) {
      if (a.version) lines.push(`   Version: \`${a.version}\``);
    } else {
      lines.push('   Not installed');
    }
  }
  lines.push('');
  lines.push('*Use the controls below to switch, or reply with agent name (e.g. "claude", "codex").*');
  return lines.join('\n');
}

export function renderModelsList(d: ModelsListData): string {
  const lines = [`**Models for ${d.agent}**`];
  if (d.sources.length) lines.push(`*Source: ${d.sources.join(', ')}*`);
  if (d.note) lines.push(`*${d.note}*`);
  lines.push('');
  if (!d.models.length) {
    lines.push('*No discoverable models found.*');
  } else {
    for (let i = 0; i < d.models.length; i++) {
      const m = d.models[i];
      const status = m.isCurrent ? '●' : '○';
      const display = m.alias ? `${m.alias} (${m.id})` : m.id;
      lines.push(`${status} **${i + 1}.** \`${display}\`${m.isCurrent ? ' ← current' : ''}`);
    }
    lines.push('');
    lines.push('*Use the controls below to switch, or reply with model number / ID.*');
  }
  if (d.effort) {
    lines.push('');
    lines.push(`**Thinking Effort:** \`${d.effort.current}\``);
    lines.push(d.effort.levels.map(l => l.isCurrent ? `**[${l.label}]**` : l.label).join(' | '));
  }
  return lines.join('\n');
}

export function renderSessionsPageCard(d: SessionsPageData): FeishuCardView {
  const sessionButtons = d.sessions.map(s => {
    const prefix = s.isCurrent ? '● ' : s.isRunning ? '🟢 ' : '';
    return cardButton(`${prefix}${s.title}`, `sess:${s.key}`, s.isCurrent);
  });
  const navButtons: FeishuCardActionItem[] = [];
  if (d.page > 0) navButtons.push(cardButton(`◀ p${d.page}`, `sp:${d.page - 1}`));
  navButtons.push(cardButton('+ New', 'sess:new'));
  if (d.page < d.totalPages - 1) navButtons.push(cardButton(`p${d.page + 2} ▶`, `sp:${d.page + 1}`));

  return {
    markdown: renderSessionsPage(d),
    rows: [
      ...cardRows(sessionButtons),
      ...(navButtons.length ? [{ actions: navButtons }] : []),
    ],
  };
}

export function renderAgentsListCard(d: AgentsListData): FeishuCardView {
  const actions = d.agents
    .filter(a => a.installed)
    .map(a => cardButton(a.isCurrent ? `● ${a.agent}` : a.agent, `ag:${a.agent}`, a.isCurrent));

  return {
    markdown: renderAgentsList(d),
    rows: cardRows(actions),
  };
}

export function renderModelsListCard(d: ModelsListData): FeishuCardView {
  const modelRows = cardRows(d.models.map(m =>
    cardButton(m.isCurrent ? `● ${m.alias || m.id}` : (m.alias || m.id), `mod:${m.id}`, m.isCurrent),
  ));
  const effortRows = d.effort
    ? cardRows(d.effort.levels.map(l => cardButton(l.isCurrent ? `● ${l.label}` : l.label, `eff:${l.id}`, l.isCurrent)))
    : [];

  return {
    markdown: renderModelsList(d),
    rows: [...modelRows, ...effortRows],
  };
}

export function renderStatus(d: StatusData): string {
  const lines = [
    `**codeclaw** v${d.version}`,
    '',
    `**Uptime:** ${fmtUptime(d.uptime)}`,
    `**Memory:** ${(d.memRss / 1024 / 1024).toFixed(0)}MB RSS / ${(d.memHeap / 1024 / 1024).toFixed(0)}MB heap`,
    `**PID:** ${d.pid}`,
    `**Workdir:** \`${d.workdir}\``,
    '',
    `**Agent:** ${d.agent}`,
    `**Model:** ${d.model}`,
    `**Session:** ${d.localSessionId ? `\`${d.localSessionId}\`` : d.sessionId ? `\`${d.sessionId.slice(0, 16)}\`` : '(new)'}`,
    `**Active Tasks:** ${d.activeTasksCount}`,
  ];
  if (d.running) {
    lines.push(`**Running:** ${fmtUptime(Date.now() - d.running.startedAt)} - ${summarizePromptForStatus(d.running.prompt)}`);
  }
  // Provider usage
  const usageLines = formatProviderUsageLines(d.usage);
  if (usageLines.length > 1) {
    lines.push('');
    // Strip HTML tags from usage lines (they're HTML-formatted)
    for (const line of usageLines) {
      lines.push(line.replace(/<\/?[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    }
  }
  lines.push('', '**Bot Usage**', `  Turns: ${d.stats.totalTurns}`);
  if (d.stats.totalInputTokens || d.stats.totalOutputTokens) {
    lines.push(`  In: ${fmtTokens(d.stats.totalInputTokens)}  Out: ${fmtTokens(d.stats.totalOutputTokens)}`);
    if (d.stats.totalCachedTokens) lines.push(`  Cached: ${fmtTokens(d.stats.totalCachedTokens)}`);
  }
  return lines.join('\n');
}

export function renderHost(d: HostData): string {
  const lines = [
    '**Host**',
    '',
    `**Name:** ${d.hostName}`,
    `**CPU:** ${d.cpuModel} x${d.cpuCount}`,
    d.cpuUsage
      ? `**CPU Usage:** ${d.cpuUsage.usedPercent.toFixed(1)}% (${d.cpuUsage.userPercent.toFixed(1)}% user, ${d.cpuUsage.sysPercent.toFixed(1)}% sys, ${d.cpuUsage.idlePercent.toFixed(1)}% idle)`
      : '**CPU Usage:** unavailable',
    `**Memory:** ${fmtBytes(d.memoryUsed)} / ${fmtBytes(d.totalMem)} (${d.memoryPercent.toFixed(0)}%)`,
    `**Available:** ${fmtBytes(d.memoryAvailable)}`,
    `**Battery:** ${d.battery ? `${d.battery.percent} (${d.battery.state})` : 'unavailable'}`,
  ];
  if (d.disk) lines.push(`**Disk:** ${d.disk.used} used / ${d.disk.total} total (${d.disk.percent})`);
  lines.push(`\n**Process:** PID ${d.selfPid} | RSS ${fmtBytes(d.selfRss)} | Heap ${fmtBytes(d.selfHeap)}`);
  if (d.topProcs.length > 1) {
    lines.push('\n**Top Processes**');
    lines.push('```');
    lines.push(...d.topProcs);
    lines.push('```');
  }
  return lines.join('\n');
}
