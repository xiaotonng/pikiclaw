/**
 * Feishu markdown adaptation helpers.
 */

function isGfmTableRow(line: string): boolean {
  return /^\|.+\|$/.test(line.trim());
}

function isGfmTableSeparator(line: string): boolean {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = inner.split('|');
  return cells.length > 0 && cells.every(c => /^\s*:?-{2,}:?\s*$/.test(c));
}

function parseGfmTableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function stripBoldMarkers(text: string): string {
  return text.replace(/^\*\*(.+)\*\*$/, '$1').trim();
}

function adaptLine(line: string): string {
  let next = String(line || '');
  next = next.replace(/^#{1,6}\s+/, '**');
  if (next.startsWith('**') && !next.endsWith('**')) next = `${next}**`;
  next = next.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>');
  return next;
}

function normalizeFeishuMarkdown(lines: string[]): string {
  const out: string[] = [];
  let pendingBlankLine = false;
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trimStart();

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (pendingBlankLine && out.length) out.push('');
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

  if (inCodeBlock) out.push('```');
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

    // Pass GFM tables through — Feishu card markdown supports tables natively
    if (i + 1 < lines.length && isGfmTableRow(lines[i]) && isGfmTableSeparator(lines[i + 1])) {
      while (i < lines.length && isGfmTableRow(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      continue;
    }

    out.push(adaptLine(lines[i]));
    i++;
  }

  return normalizeFeishuMarkdown(out);
}
