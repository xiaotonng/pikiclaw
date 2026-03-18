/**
 * bot-feishu-render.ts — Feishu-specific rendering.
 *
 * Converts structured data from bot-commands.ts into Feishu Markdown (for interactive cards).
 * Also provides a LivePreviewRenderer for streaming output.
 */

import type { Agent, StreamResult } from './bot.js';
import type { HumanLoopPromptState } from './human-loop.js';
import type {
  CommandActionButton,
  CommandItemState,
  CommandNotice,
  CommandSelectionItem,
  CommandSelectionView,
} from './bot-command-ui.js';
import { encodeCommandAction } from './bot-command-ui.js';
import { fmtUptime, fmtTokens, fmtBytes } from './bot.js';
import type { StartData, SessionsPageData, AgentsListData, ModelsListData, SkillsListData, StatusData, HostData } from './bot-commands.js';
import { summarizePromptForStatus } from './bot-commands.js';
import type { LivePreviewRenderer } from './bot-telegram-live-preview.js';
import type { StreamPreviewRenderInput } from './bot-render-shared.js';
import {
  footerStatusSymbol,
  formatFooterSummary,
  trimActivityForPreview,
  buildProviderUsageLines,
  extractFinalReplyData,
  extractStreamPreviewData,
} from './bot-render-shared.js';
import {
  currentHumanLoopQuestion,
  humanLoopAnsweredCount,
  isHumanLoopAwaitingText,
  isHumanLoopQuestionAnswered,
  summarizeHumanLoopAnswer,
} from './human-loop.js';
import type { FeishuCardActionItem, FeishuCardActionRow, FeishuCardView } from './channel-feishu.js';
import path from 'node:path';
import { listSubdirs } from './bot.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPreviewFooter(agent: Agent, elapsedMs: number, meta?: import('./bot.js').StreamPreviewMeta | null): string {
  return `${footerStatusSymbol('running')} ${formatFooterSummary(agent, elapsedMs, meta)}`;
}

function formatFinalFooter(status: import('./bot-render-shared.js').FooterStatus, agent: Agent, elapsedMs: number, contextPercent?: number | null): string {
  return `${footerStatusSymbol(status)} ${formatFooterSummary(agent, elapsedMs, null, contextPercent ?? null)}`;
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

export function buildHumanLoopPromptMarkdown(prompt: HumanLoopPromptState): string {
  const question = currentHumanLoopQuestion(prompt);
  const lines: string[] = [`**${prompt.title}**`];
  if (prompt.detail) lines.push(`\`${prompt.detail}\``);
  lines.push(`*${humanLoopAnsweredCount(prompt)}/${prompt.questions.length} answered*`);
  if (!question) return lines.join('\n\n');

  if (question.header.trim()) lines.push(`**${question.header}**`);
  lines.push(question.prompt);

  const options = question.options || [];
  if (options.length) {
    lines.push(options.map((option, index) => {
      const detail = option.description ? `\n   ${option.description}` : '';
      return `${index + 1}. ${option.label}${detail}`;
    }).join('\n'));
  }

  if (isHumanLoopAwaitingText(prompt)) {
    lines.push(`*${question.secret ? 'Reply in chat with the secret value.' : 'Reply in chat with text to answer.'}*`);
  }

  if (prompt.hint) lines.push(`*${prompt.hint}*`);

  if (prompt.questions.length > 1) {
    lines.push(prompt.questions.map((item, index) => {
      const summary = summarizeHumanLoopAnswer(prompt, item);
      const answered = isHumanLoopQuestionAnswered(prompt, index);
      return `${answered ? '●' : '○'} ${item.header || item.prompt}: ${summary.display}`;
    }).join('\n'));
  }

  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// LivePreview renderer — produces Markdown for Feishu card elements
// ---------------------------------------------------------------------------

export function buildInitialPreviewMarkdown(agent: Agent, model?: string | null, effort?: string | null, waiting = false): string {
  const parts: string[] = [];
  if (waiting) parts.push('Waiting in queue...');
  if (model) parts.push(model);
  else parts.push(agent);
  if (effort) parts.push(`${effort}`);
  return parts.join(' · ');
}

function buildPreviewMarkdown(input: StreamPreviewRenderInput, options?: { includeFooter?: boolean }): string {
  const data = extractStreamPreviewData(input);
  const parts: string[] = [];

  if (data.planDisplay) {
    parts.push(`**Plan**\n${data.planDisplay}`);
  }

  if (data.activityDisplay) {
    parts.push(`**Activity**\n${trimActivityForPreview(data.activityDisplay, data.maxActivity)}`);
  }

  if (data.thinkDisplay && !data.display) {
    parts.push(`**${data.label}**\n${data.thinkDisplay}`);
  } else if (data.display) {
    if (data.rawThinking) {
      parts.push(`**${data.label}**\n${data.thinkSnippet}`);
    }
    parts.push(data.preview);
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
  const data = extractFinalReplyData(agent, result);
  const footerText = `\n\n${formatFinalFooter(data.footerStatus, agent, data.elapsedMs, result.contextPercent ?? null)}`;

  let activityText = '';
  let activityNoteText = '';
  if (data.activityNarrative) {
    activityText = `**Activity**\n${data.activityNarrative}\n\n`;
  }
  if (data.activityCommandSummary) {
    activityNoteText = `*${data.activityCommandSummary}*\n\n`;
  }

  let thinkingText = '';
  if (data.thinkingDisplay) {
    thinkingText = `**${data.thinkLabel}**\n${data.thinkingDisplay}\n\n`;
  }

  let statusText = '';
  if (data.statusLines) {
    statusText = `**⚠ Incomplete Response**\n${data.statusLines.join('\n')}\n\n`;
  }

  const headerText = `${activityText}${activityNoteText}${statusText}${thinkingText}`;
  const bodyText = data.bodyMessage;
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
  const usageLines = buildProviderUsageLines(d.usage);
  if (usageLines.length > 1) {
    lines.push('');
    for (const line of usageLines) {
      lines.push(line.text);
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

// ---------------------------------------------------------------------------
// GFM table → Feishu text conversion
// ---------------------------------------------------------------------------
// Feishu card markdown does not support GFM pipe-delimited table syntax.

function isGfmTableRow(line: string): boolean {
  return line.trim().startsWith('|');
}

function isGfmTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('|')) return false;
  const inner = t.replace(/^\||\|$/g, '');
  const cells = inner.split('|');
  return cells.length > 0 && cells.every(c => /^\s*:?-{2,}:?\s*$/.test(c));
}

function parseGfmTableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(c => c.trim());
}

function stripBoldMarkers(text: string): string {
  return text.replace(/\*\*/g, '');
}

/** Strip anchor links [text](#id) → text (anchors don't work in Feishu cards). */
function adaptLine(line: string): string {
  const withoutAnchors = line.replace(/\[([^\]]+)\]\(#[^)]*\)/g, '$1');
  const heading = withoutAnchors.match(/^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/);
  if (!heading) return withoutAnchors;

  const indent = heading[1] || '';
  const content = heading[2].trim();
  return content ? `${indent}**${content}**` : '';
}

function normalizeFeishuMarkdown(lines: string[]): string {
  const out: string[] = [];
  let inCodeBlock = false;
  let pendingBlankLine = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, '');
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (pendingBlankLine && out.length && !inCodeBlock) out.push('');
      pendingBlankLine = false;
      out.push(line);
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      out.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      if (out.length) pendingBlankLine = true;
      continue;
    }

    if (pendingBlankLine && out.length) out.push('');
    pendingBlankLine = false;
    out.push(line);
  }

  return out.join('\n');
}

export function adaptMarkdownForFeishu(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let i = 0;
  let inCodeBlock = false;

  while (i < lines.length) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      out.push(lines[i]);
      i++;
      continue;
    }
    if (inCodeBlock) {
      out.push(lines[i]);
      i++;
      continue;
    }

    // GFM table conversion
    if (
      i + 1 < lines.length &&
      isGfmTableRow(lines[i]) &&
      isGfmTableSeparator(lines[i + 1])
    ) {
      const headers = parseGfmTableCells(lines[i]);
      i += 2;
      const dataRows: string[][] = [];
      while (i < lines.length && isGfmTableRow(lines[i]) && !isGfmTableSeparator(lines[i])) {
        dataRows.push(parseGfmTableCells(lines[i]));
        i++;
      }

      for (const row of dataRows) {
        if (headers.length <= 2) {
          const key = (row[0] || '').trim();
          const val = (row[1] || '').trim();
          if (key && val) {
            out.push(adaptLine(`**${stripBoldMarkers(key)}** ${val}`));
          } else if (key || val) {
            out.push(adaptLine(key || val));
          }
        } else {
          const parts = headers.map((h, idx) => {
            const cell = (row[idx] || '').trim();
            if (!cell) return '';
            const header = stripBoldMarkers(h.trim());
            return header ? `**${header}:** ${cell}` : cell;
          }).filter(Boolean);
          out.push(adaptLine(parts.join('  ')));
        }
      }
    } else {
      out.push(adaptLine(lines[i]));
      i++;
    }
  }

  return normalizeFeishuMarkdown(out);
}
