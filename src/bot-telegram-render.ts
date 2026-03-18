import type { Agent, StreamPreviewMeta, StreamResult } from './bot.js';
import type { SkillsListData } from './bot-commands.js';
import type { HumanLoopPromptState } from './human-loop.js';
import type {
  CommandActionButton,
  CommandItemState,
  CommandNotice,
  CommandSelectionItem,
  CommandSelectionView,
} from './bot-command-ui.js';
import { encodeCommandAction } from './bot-command-ui.js';
import {
  currentHumanLoopQuestion,
  humanLoopAnsweredCount,
  isHumanLoopAwaitingText,
  isHumanLoopQuestionAnswered,
  summarizeHumanLoopAnswer,
} from './human-loop.js';
import type { FooterStatus, ProviderUsageSnapshot, StreamPreviewRenderInput } from './bot-render-shared.js';
import {
  footerStatusSymbol,
  formatFooterSummary,
  trimActivityForPreview,
  buildProviderUsageLines,
  extractFinalReplyData,
  extractStreamPreviewData,
} from './bot-render-shared.js';
export type { FooterStatus, ProviderUsageSnapshot, StreamPreviewRenderInput } from './bot-render-shared.js';

export interface FinalReplyRender {
  fullHtml: string;
  headerHtml: string;
  bodyHtml: string;
  footerHtml: string;
}

export function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncateMiddle(text: string, maxChars = 36): string {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  const visible = maxChars - 3;
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function compactCode(text: string, maxChars = 36): string {
  return `<code>${escapeHtml(truncateMiddle(text, maxChars))}</code>`;
}

export function buildCompactSelectionTitle(title: string, detail?: string | null): string {
  const cleanDetail = String(detail || '').trim();
  if (!cleanDetail) return `<b>${escapeHtml(title)}</b>`;
  return `<b>${escapeHtml(title)}</b> · ${compactCode(cleanDetail, 20)}`;
}

export function buildCompactSelectionNotice(
  title: string,
  value: string,
  detail?: string | null,
  codeMaxChars = 40,
): string {
  const lines = [`<b>${escapeHtml(title)}</b>`, compactCode(value, codeMaxChars)];
  const cleanDetail = String(detail || '').trim();
  if (cleanDetail) lines.push(`<i>${escapeHtml(cleanDetail)}</i>`);
  return lines.join('\n');
}

function selectionStateSymbol(state: CommandItemState | undefined): string {
  switch (state) {
    case 'current': return '●';
    case 'running': return '◐';
    case 'unavailable': return '✕';
    default: return '○';
  }
}

function formatCommandItemHtml(item: CommandSelectionItem, index: number): string {
  const parts = [
    selectionStateSymbol(item.state),
    `<b>${index + 1}.</b>`,
    escapeHtml(item.label),
  ];
  if (item.detail) parts.push(escapeHtml(item.detail));
  return parts.join(' ');
}

function formatCommandButtonLabel(button: CommandActionButton, maxChars = 24): string {
  const prefix = button.state && button.state !== 'default'
    ? `${selectionStateSymbol(button.state)} `
    : '';
  return truncateMiddle(`${prefix}${button.label}`.trim(), maxChars);
}

export function renderCommandNoticeHtml(notice: CommandNotice): string {
  const lines = [`<b>${escapeHtml(notice.title)}</b>`];
  if (notice.value) {
    if (notice.valueMode === 'plain') lines.push(escapeHtml(notice.value));
    else lines.push(compactCode(notice.value, 40));
  }
  if (notice.detail) lines.push(`<i>${escapeHtml(notice.detail)}</i>`);
  return lines.join('\n');
}

export function renderCommandSelectionHtml(view: CommandSelectionView): string {
  const lines = [buildCompactSelectionTitle(view.title, view.detail)];
  if (view.metaLines.length) lines.push(...view.metaLines.map(line => `<i>${escapeHtml(line)}</i>`));

  if (view.items.length) {
    lines.push('', ...view.items.map((item, index) => formatCommandItemHtml(item, index)));
  } else if (view.emptyText) {
    lines.push('', `<i>${escapeHtml(view.emptyText)}</i>`);
  }

  if (view.helperText) lines.push('', `<i>${escapeHtml(view.helperText)}</i>`);
  return lines.join('\n');
}

export function renderCommandSelectionKeyboard(view: CommandSelectionView): { inline_keyboard: { text: string; callback_data: string }[][] } | undefined {
  if (!view.rows.length) return undefined;
  return {
    inline_keyboard: view.rows.map(row => row.map(button => ({
      text: formatCommandButtonLabel(button),
      callback_data: encodeCommandAction(button.action),
    }))),
  };
}

export function buildHumanLoopPromptHtml(prompt: HumanLoopPromptState): string {
  const question = currentHumanLoopQuestion(prompt);
  const lines: string[] = [`<b>${escapeHtml(prompt.title)}</b>`];
  if (prompt.detail) lines.push(compactCode(prompt.detail, 40));
  lines.push(`<i>${humanLoopAnsweredCount(prompt)}/${prompt.questions.length} answered</i>`);
  if (!question) return lines.join('\n');

  lines.push('');
  if (question.header.trim()) lines.push(`<b>${escapeHtml(question.header)}</b>`);
  lines.push(escapeHtml(question.prompt));

  const options = question.options || [];
  if (options.length) {
    lines.push('');
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      lines.push(`${i + 1}. ${escapeHtml(option.label)}`);
      if (option.description) lines.push(`<i>${escapeHtml(option.description)}</i>`);
    }
  }

  if (isHumanLoopAwaitingText(prompt)) {
    lines.push('', `<i>${question.secret ? 'Reply with the secret value in chat.' : 'Reply with text in chat to answer.'}</i>`);
  }

  if (prompt.hint) lines.push('', `<i>${escapeHtml(prompt.hint)}</i>`);

  if (prompt.questions.length > 1) {
    lines.push('');
    for (let i = 0; i < prompt.questions.length; i++) {
      const item = prompt.questions[i];
      const summary = summarizeHumanLoopAnswer(prompt, item);
      const answered = isHumanLoopQuestionAnswered(prompt, i);
      lines.push(`${answered ? '●' : '○'} ${escapeHtml(item.header || item.prompt)}: ${escapeHtml(summary.display)}`);
    }
  }

  return lines.join('\n');
}

function mdInline(line: string): string {
  const parts: string[] = [];
  let rest = line;
  while (rest.includes('`')) {
    const a = rest.indexOf('`');
    const b = rest.indexOf('`', a + 1);
    if (b === -1) break;
    parts.push(formatMarkdownSegment(rest.slice(0, a)));
    parts.push(`<code>${escapeHtml(rest.slice(a + 1, b))}</code>`);
    rest = rest.slice(b + 1);
  }
  parts.push(formatMarkdownSegment(rest));
  return parts.join('');
}

function formatMarkdownSegment(text: string): string {
  let value = escapeHtml(text);
  value = value.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  value = value.replace(/__(.+?)__/g, '<b>$1</b>');
  value = value.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  value = value.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');
  value = value.replace(/~~(.+?)~~/g, '<s>$1</s>');
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return value;
}

export function mdToTgHtml(text: string): string {
  const result: string[] = [];
  const lines = text.split('\n');
  let i = 0;
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();
    if (stripped.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLang = stripped.slice(3).trim().split(/\s/)[0] || '';
        codeLines = [];
      } else {
        inCode = false;
        const content = escapeHtml(codeLines.join('\n'));
        result.push(codeLang
          ? `<pre><code class="language-${escapeHtml(codeLang)}">${content}</code></pre>`
          : `<pre>${content}</pre>`);
      }
      i++;
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      i++;
      continue;
    }

    if (stripped.startsWith('|') && stripped.endsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length) {
        const tableLine = lines[i].trim();
        if (!tableLine.startsWith('|')) break;
        if (/^\|[\s\-:|]+\|$/.test(tableLine)) {
          i++;
          continue;
        }
        tableLines.push(tableLine);
        i++;
      }
      if (tableLines.length) result.push(`<pre>${escapeHtml(tableLines.join('\n'))}</pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      result.push(`<b>${mdInline(heading[2])}</b>`);
      i++;
      continue;
    }

    result.push(mdInline(line));
    i++;
  }

  if (inCode && codeLines.length) result.push(`<pre>${escapeHtml(codeLines.join('\n'))}</pre>`);
  return result.join('\n');
}

export function renderSessionTurnHtml(userText: string | null | undefined, assistantText: string | null | undefined): string {
  const parts: string[] = [];
  const user = String(userText || '').trim();
  const assistant = String(assistantText || '').trim();
  if (user || assistant) parts.push('<b>Recent Context</b>');
  if (user) parts.push(`<blockquote expandable>${escapeHtml(user)}</blockquote>`);
  if (assistant) parts.push(mdToTgHtml(assistant));
  return parts.join('\n\n');
}

export function formatMenuLines(commands: { command: string; description: string }[]): string[] {
  return commands.map(cmd => `/${cmd.command} — ${escapeHtml(cmd.description)}`);
}

export function renderSkillsListHtml(d: SkillsListData): string {
  const lines = [
    `<b>Project Skills</b> (${d.skills.length})`,
    '',
    `<b>Agent:</b> ${escapeHtml(d.agent)}`,
    `<b>Workdir:</b> <code>${escapeHtml(d.workdir)}</code>`,
  ];

  if (!d.skills.length) {
    lines.push('', '<i>No project skills found in .pikiclaw/skills/ or .claude/commands/.</i>');
    return lines.join('\n');
  }

  lines.push('');
  for (const skill of d.skills) {
    lines.push(`<b>/${escapeHtml(skill.command)}</b> — ${escapeHtml(skill.label)}`);
    if (skill.description) lines.push(escapeHtml(skill.description));
  }
  return lines.join('\n');
}

export function formatPreviewFooterHtml(agent: Agent, elapsedMs: number, meta?: StreamPreviewMeta | null): string {
  return escapeHtml(`${footerStatusSymbol('running')} ${formatFooterSummary(agent, elapsedMs, meta)}`);
}

function formatFinalFooterHtml(status: FooterStatus, agent: Agent, elapsedMs: number, contextPercent?: number | null): string {
  return escapeHtml(`${footerStatusSymbol(status)} ${formatFooterSummary(agent, elapsedMs, null, contextPercent ?? null)}`);
}

export function formatProviderUsageLines(usage: ProviderUsageSnapshot): string[] {
  return buildProviderUsageLines(usage).map(line =>
    line.bold ? `<b>${escapeHtml(line.text)}</b>` : escapeHtml(line.text),
  );
}

export function buildInitialPreviewHtml(agent: Agent, waiting = false): string {
  return waiting
    ? `<i>Waiting in queue...</i>\n\n${formatPreviewFooterHtml(agent, 0)}`
    : formatPreviewFooterHtml(agent, 0);
}

export function buildStreamPreviewHtml(input: StreamPreviewRenderInput): string {
  const data = extractStreamPreviewData(input);
  const parts: string[] = [];

  if (data.planDisplay) {
    parts.push(`<blockquote><b>Plan</b>\n${escapeHtml(data.planDisplay)}</blockquote>`);
  }

  if (data.activityDisplay) {
    parts.push(`<blockquote><b>Activity</b>\n${escapeHtml(trimActivityForPreview(data.activityDisplay, data.maxActivity))}</blockquote>`);
  }

  if (data.thinkDisplay && !data.display) {
    parts.push(`<blockquote><b>${escapeHtml(data.label)}</b>\n${escapeHtml(data.thinkDisplay)}</blockquote>`);
  } else if (data.display) {
    if (data.rawThinking) {
      parts.push(`<blockquote><b>${escapeHtml(data.label)}</b>\n${escapeHtml(data.thinkSnippet)}</blockquote>`);
    }
    parts.push(mdToTgHtml(data.preview));
  }

  parts.push(formatPreviewFooterHtml(input.agent, input.elapsedMs, input.meta ?? null));
  return parts.join('\n\n');
}

export function buildFinalReplyRender(agent: Agent, result: StreamResult): FinalReplyRender {
  const data = extractFinalReplyData(agent, result);
  const footerHtml = `\n\n${formatFinalFooterHtml(data.footerStatus, agent, data.elapsedMs, result.contextPercent ?? null)}`;

  let activityHtml = '';
  let activityNoteHtml = '';
  if (data.activityNarrative) {
    activityHtml = `<blockquote><b>Activity</b>\n${escapeHtml(data.activityNarrative)}</blockquote>\n\n`;
  }
  if (data.activityCommandSummary) {
    activityNoteHtml = `<i>${escapeHtml(data.activityCommandSummary)}</i>\n\n`;
  }

  let thinkingHtml = '';
  if (data.thinkingDisplay) {
    thinkingHtml = `<blockquote><b>${escapeHtml(data.thinkLabel)}</b>\n${escapeHtml(data.thinkingDisplay)}</blockquote>\n\n`;
  }

  let statusHtml = '';
  if (data.statusLines) {
    statusHtml = `<blockquote expandable><b>Incomplete Response</b>\n${data.statusLines.map(escapeHtml).join('\n')}</blockquote>\n\n`;
  }

  const headerHtml = `${activityHtml}${activityNoteHtml}${statusHtml}${thinkingHtml}`;
  const bodyHtml = mdToTgHtml(data.bodyMessage);
  return {
    fullHtml: `${headerHtml}${bodyHtml}${footerHtml}`,
    headerHtml,
    bodyHtml,
    footerHtml,
  };
}
