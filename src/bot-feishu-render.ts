/**
 * bot-feishu-render.ts — Feishu-specific rendering.
 *
 * Converts structured data from bot-commands.ts into Feishu Markdown (for interactive cards).
 * Also provides a LivePreviewRenderer for streaming output.
 */

import type { Agent, StreamResult, StreamPreviewMeta } from './bot.js';
import type {
  CommandActionButton,
  CommandItemState,
  CommandNotice,
  CommandSelectionItem,
  CommandSelectionView,
} from './bot-command-ui.js';
import { encodeCommandAction } from './bot-command-ui.js';
import { fmtUptime, fmtTokens, fmtBytes, formatThinkingForDisplay, thinkLabel } from './bot.js';
import type { StartData, SessionsPageData, AgentsListData, ModelsListData, SkillsListData, StatusData, HostData } from './bot-commands.js';
import { summarizePromptForStatus } from './bot-commands.js';
import { formatProviderUsageLines } from './bot-telegram-render.js';
import type { LivePreviewRenderer } from './bot-telegram-live-preview.js';
import type { StreamPreviewRenderInput } from './bot-telegram-render.js';
import { formatActivityCommandSummary, parseActivitySummary, renderPlanForPreview, summarizeActivityForPreview } from './bot-streaming.js';
import type { FeishuCardActionItem, FeishuCardActionRow, FeishuCardView } from './channel-feishu.js';
import path from 'node:path';
import { listSubdirs } from './bot.js';

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

function selectionStateSymbol(state: CommandItemState | undefined): string {
  switch (state) {
    case 'current': return '●';
    case 'running': return '🟢';
    case 'unavailable': return '❌';
    default: return '○';
  }
}

function formatCommandItemMarkdown(item: CommandSelectionItem, index: number): string {
  const parts = [
    selectionStateSymbol(item.state),
    `**${index + 1}.**`,
    item.label,
  ];
  if (item.detail) parts.push(item.detail);
  return parts.join(' ');
}

function formatCommandButtonLabel(button: CommandActionButton): string {
  const prefix = button.state && button.state !== 'default'
    ? `${selectionStateSymbol(button.state)} `
    : '';
  return truncateLabel(`${prefix}${button.label}`.trim());
}

function actionButton(button: CommandActionButton): FeishuCardActionItem {
  return cardButton(formatCommandButtonLabel(button), encodeCommandAction(button.action), !!button.primary);
}

export function renderCommandNotice(notice: CommandNotice): string {
  const lines = [`**${notice.title}**`];
  if (notice.value) {
    lines.push(notice.valueMode === 'plain' ? notice.value : `\`${notice.value}\``);
  }
  if (notice.detail) lines.push(notice.detail);
  return lines.join('\n\n');
}

export function renderCommandSelectionMarkdown(view: CommandSelectionView): string {
  const title = view.detail ? `**${view.title}** · \`${view.detail}\`` : `**${view.title}**`;
  const lines = [title];
  if (view.metaLines.length) lines.push(...view.metaLines.map(line => `*${line}*`));

  if (view.items.length) {
    lines.push('', ...view.items.map((item, index) => formatCommandItemMarkdown(item, index)));
  } else if (view.emptyText) {
    lines.push('', `*${view.emptyText}*`);
  }

  if (view.helperText) lines.push('', `*${view.helperText}*`);
  return lines.join('\n');
}

export function renderCommandSelectionCard(view: CommandSelectionView): FeishuCardView {
  return {
    markdown: renderCommandSelectionMarkdown(view),
    rows: view.rows.map(row => ({ actions: row.map(actionButton) })),
  };
}

function escapeFeishuMarkdownText(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|>~])/g, '\\$1');
}

function renderFeishuQuote(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${escapeFeishuMarkdownText(line)}`)
    .join('\n');
}

export function renderSessionTurnMarkdown(userText: string | null | undefined, assistantText: string | null | undefined): string {
  const parts: string[] = [];
  const user = String(userText || '').trim();
  const assistant = String(assistantText || '').trim();
  if (user || assistant) parts.push('**Recent Context**');
  if (user) parts.push('**User**', renderFeishuQuote(user));
  if (assistant) parts.push('**Assistant**', assistant);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// LivePreview renderer — produces Markdown for Feishu card elements
// ---------------------------------------------------------------------------

export function buildInitialPreviewMarkdown(agent: Agent): string {
  return formatPreviewFooter(agent, 0);
}

function buildPreviewMarkdown(input: StreamPreviewRenderInput, options?: { includeFooter?: boolean }): string {
  const maxBody = 2400;
  const display = input.bodyText.trim();
  const rawThinking = input.thinking.trim();
  const thinkDisplay = formatThinkingForDisplay(input.thinking, maxBody);
  const planDisplay = renderPlanForPreview(input.plan ?? null);
  const activityDisplay = summarizeActivityForPreview(input.activity);
  const maxActivity = !display && !thinkDisplay && !planDisplay ? 2400 : 1400;
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
    if (rawThinking) {
      const thinkSnippet = formatThinkingForDisplay(input.thinking, 600);
      parts.push(`**${label}**\n${thinkSnippet}`);
    }
    const preview = display.length > maxBody ? '(...truncated)\n' + display.slice(-maxBody) : display;
    parts.push(preview);
  }

  if (options?.includeFooter !== false) {
    parts.push(formatPreviewFooter(input.agent, input.elapsedMs, input.meta ?? null));
  }
  return parts.join('\n\n');
}

export function buildStreamingBodyMarkdown(input: StreamPreviewRenderInput): string {
  // CardKit streaming content uses a separate status element, so keep the
  // body focused on live plan/activity/thinking/output without duplicating the footer.
  return buildPreviewMarkdown(input, { includeFooter: false });
}

export function buildStreamPreviewMarkdown(input: StreamPreviewRenderInput): string {
  return buildPreviewMarkdown(input, { includeFooter: true });
}

export const feishuPreviewRenderer: LivePreviewRenderer = {
  renderInitial: buildInitialPreviewMarkdown,
  renderStream: buildStreamPreviewMarkdown,
};

export const feishuStreamingPreviewRenderer: LivePreviewRenderer = {
  renderInitial: () => '',
  renderStream: buildStreamingBodyMarkdown,
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
      if (display.length > 1600) display = '...\n' + display.slice(-1600);
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
    thinkingText = `**${thinkLabel(agent)}**\n${formatThinkingForDisplay(result.thinking, 1600)}\n\n`;
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
    '**Agents**',
    ...d.agentDetails.map(a => {
      let line = `  **${a.agent}**: ${a.model}`;
      if (a.effort) line += ` (effort: ${a.effort})`;
      return line;
    }),
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

export function renderSkillsList(d: SkillsListData): string {
  const lines = [`**Project Skills** (${d.skills.length})`, '', `**Agent:** ${d.agent}`, `**Workdir:** \`${d.workdir}\``];
  if (!d.skills.length) {
    lines.push('', '*No project skills found in `.pikiclaw/skills/` or `.claude/commands/`.*');
    return lines.join('\n');
  }

  lines.push('');
  for (const skill of d.skills) {
    lines.push(`**/${skill.command}** — ${skill.label}`);
    if (skill.description) lines.push(skill.description);
  }
  lines.push('', '*Tap a button below or send the command directly.*');
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

export function renderSkillsCard(d: SkillsListData): FeishuCardView {
  return {
    markdown: renderSkillsList(d),
    rows: cardRows(d.skills.map(skill => cardButton(skill.label, `skill:${skill.command}`)), 2),
  };
}

export function renderStatus(d: StatusData): string {
  const lines = [
    `**pikiclaw** v${d.version}`,
    '',
    `**Uptime:** ${fmtUptime(d.uptime)}`,
    `**Memory:** ${(d.memRss / 1024 / 1024).toFixed(0)}MB RSS / ${(d.memHeap / 1024 / 1024).toFixed(0)}MB heap`,
    `**PID:** ${d.pid}`,
    `**Workdir:** \`${d.workdir}\``,
    '',
    `**Agent:** ${d.agent}`,
    `**Model:** ${d.model}`,
    `**Session:** ${d.sessionId ? `\`${d.sessionId.slice(0, 16)}\`` : '(new)'}`,
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

// ---------------------------------------------------------------------------
// Directory browser (interactive workdir switcher)
// ---------------------------------------------------------------------------

class PathRegistry {
  private pathToId = new Map<string, number>();
  private idToPath = new Map<number, string>();
  private nextId = 1;

  register(dirPath: string): number {
    let id = this.pathToId.get(dirPath);
    if (id != null) return id;
    id = this.nextId++;
    this.pathToId.set(dirPath, id);
    this.idToPath.set(id, dirPath);
    if (this.pathToId.size > 500) {
      const oldest = [...this.pathToId.entries()].slice(0, 200);
      for (const [oldPath, oldId] of oldest) {
        this.pathToId.delete(oldPath);
        this.idToPath.delete(oldId);
      }
    }
    return id;
  }

  resolve(id: number): string | undefined {
    return this.idToPath.get(id);
  }
}

const feishuPathRegistry = new PathRegistry();
const DIR_PAGE_SIZE = 8;

export function resolveFeishuRegisteredPath(id: number): string | undefined {
  return feishuPathRegistry.resolve(id);
}

export function buildSwitchWorkdirCard(currentWorkdir: string, browsePath: string, page = 0): FeishuCardView {
  const dirs = listSubdirs(browsePath);
  const totalPages = Math.max(1, Math.ceil(dirs.length / DIR_PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = dirs.slice(currentPage * DIR_PAGE_SIZE, (currentPage + 1) * DIR_PAGE_SIZE);

  // Text
  const lines = ['**Workdir**'];
  lines.push(`● \`${currentWorkdir}\``);
  if (browsePath !== currentWorkdir) lines.push(`○ \`${browsePath}\``);

  // Directory buttons (2 per row)
  const dirRows: FeishuCardActionRow[] = [];
  for (let i = 0; i < slice.length; i += 2) {
    const rowActions: FeishuCardActionItem[] = [];
    for (let j = i; j < Math.min(i + 2, slice.length); j++) {
      const fullPath = path.join(browsePath, slice[j]);
      const id = feishuPathRegistry.register(fullPath);
      rowActions.push(cardButton(slice[j], `sw:n:${id}:0`));
    }
    dirRows.push({ actions: rowActions });
  }

  // Nav row: parent + pagination
  const navActions: FeishuCardActionItem[] = [];
  const parent = path.dirname(browsePath);
  if (parent !== browsePath) {
    navActions.push(cardButton('⬆ ..', `sw:n:${feishuPathRegistry.register(parent)}:0`));
  }
  if (totalPages > 1) {
    const browseId = feishuPathRegistry.register(browsePath);
    if (currentPage > 0) navActions.push(cardButton(`◀ ${currentPage}/${totalPages}`, `sw:n:${browseId}:${currentPage - 1}`));
    if (currentPage < totalPages - 1) navActions.push(cardButton(`${currentPage + 2}/${totalPages} ▶`, `sw:n:${browseId}:${currentPage + 1}`));
  }

  // Select button
  const selectActions: FeishuCardActionItem[] = [
    cardButton('✓ Use This', `sw:s:${feishuPathRegistry.register(browsePath)}`, true),
  ];

  const rows = [
    ...dirRows,
    ...(navActions.length ? [{ actions: navActions }] : []),
    { actions: selectActions },
  ];

  return { markdown: lines.join('\n'), rows };
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
