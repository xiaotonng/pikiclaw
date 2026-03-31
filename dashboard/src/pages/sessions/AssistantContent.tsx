import { useState, useRef, useLayoutEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../utils';
import { CollapsibleCard, CountBadge } from '../../components/ui';
import { PlanProgressCard, hasPlan } from '../../components/PlanProgressCard';
import { mdComponents } from './markdown';
import { lastNLines } from './utils';
import { ImageLightbox } from './TurnView';
import type { RichMessage, MessageBlock } from '../../types';

/* ═══════════════════════════════════════════════════════════════
   Assistant message — separated activity, thinking, output
   ═══════════════════════════════════════════════════════════════ */
export function AssistantMsg({ message, t }: { message: RichMessage; t: (k: string) => string }) {
  const { activityBlocks, thinkingBlocks, processNotes, planBlocks, outputBlocks } = categorizeAssistantBlocks(message.blocks);
  const latestPlan = [...planBlocks].reverse().find(block => hasPlan(block.plan));
  return (
    <div className="space-y-3">
      {(activityBlocks.length > 0 || processNotes.length > 0) && <ActivitySection blocks={activityBlocks} notes={processNotes} t={t} />}
      {latestPlan?.plan && <PlanProgressCard plan={latestPlan.plan} phase="done" t={t} className="max-w-[760px]" />}
      {thinkingBlocks.length > 0 && <ThinkingSection blocks={thinkingBlocks} t={t} />}
      {outputBlocks.length > 0 && <OutputBlock blocks={outputBlocks} />}
    </div>
  );
}

export function categorizeAssistantBlocks(blocks: MessageBlock[]): {
  activityBlocks: MessageBlock[];
  thinkingBlocks: MessageBlock[];
  processNotes: MessageBlock[];
  planBlocks: MessageBlock[];
  outputBlocks: MessageBlock[];
} {
  const normalized = blocks.filter(block =>
    block.type === 'plan'
    || block.type === 'tool_use'
    || block.type === 'tool_result'
    || block.type === 'image'
    || !!block.content.trim(),
  );
  const hasExplicitPhases = normalized.some(block => block.type === 'text' && !!block.phase);
  const hasStructured = normalized.some(block => block.type !== 'text' && block.type !== 'image');
  if (!hasStructured && !hasExplicitPhases) {
    return { activityBlocks: [], thinkingBlocks: [], processNotes: [], planBlocks: [], outputBlocks: normalized };
  }

  if (hasExplicitPhases) {
    return {
      activityBlocks: normalized.filter(block => block.type === 'tool_use' || block.type === 'tool_result'),
      thinkingBlocks: normalized.filter(block => block.type === 'thinking'),
      processNotes: normalized.filter(block => block.type === 'text' && block.phase === 'commentary'),
      planBlocks: normalized.filter(block => block.type === 'plan' && hasPlan(block.plan)),
      outputBlocks: normalized.filter(block =>
        block.type === 'image'
        || (block.type === 'text' && block.phase !== 'commentary'),
      ),
    };
  }

  let trailingStart = normalized.length;
  while (trailingStart > 0 && (normalized[trailingStart - 1].type === 'text' || normalized[trailingStart - 1].type === 'image')) trailingStart--;

  const processRegion = trailingStart < normalized.length ? normalized.slice(0, trailingStart) : normalized;
  const outputBlocks = trailingStart < normalized.length ? normalized.slice(trailingStart) : [];

  return {
    activityBlocks: processRegion.filter(b => b.type === 'tool_use' || b.type === 'tool_result'),
    thinkingBlocks: processRegion.filter(b => b.type === 'thinking'),
    planBlocks: processRegion.filter(b => b.type === 'plan' && hasPlan(b.plan)),
    processNotes: processRegion.filter(b => b.type === 'text'),
    outputBlocks: [...outputBlocks, ...processRegion.filter(b => b.type === 'image')],
  };
}

/* ═══════════════════════════════════════════════════════════════
   Activity section — collapsible tool call summary (cyan accent)
   ═══════════════════════════════════════════════════════════════ */
export function ActivitySection({ blocks, notes, t }: { blocks: MessageBlock[]; notes: MessageBlock[]; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const tools = blocks
    .filter(b => b.type === 'tool_use')
    .map(b => b.toolName || 'tool')
    .filter((name, i, list) => list.indexOf(name) === i);
  const totalOps = blocks.length + notes.length;
  const notePreview = notes.map(block => block.content.split('\n').find(Boolean)?.trim() || '').find(Boolean) || '';
  const preview = tools.length > 0 ? tools.join(' \u00b7 ') : notePreview;

  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen(v => !v)}
      dot={{ color: 'bg-cyan-400/60' }}
      label={t('hub.activity')}
      preview={<span className="text-[11.5px] font-mono text-fg-4 truncate">{preview}</span>}
      badge={totalOps > 0 ? <CountBadge>{totalOps}</CountBadge> : undefined}
    >
      <div className="px-3.5 py-2.5 space-y-0.5">
        {blocks.map((block, i) => <ActivityLine key={i} block={block} />)}
        {notes.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {notes.map((block, i) => (
              <div key={`note-${i}`} className="rounded-md border border-edge bg-inset px-3 py-2 session-md text-[12px] leading-[1.7] text-fg-4">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {block.content}
                </ReactMarkdown>
              </div>
            ))}
          </div>
        )}
      </div>
    </CollapsibleCard>
  );
}

export function ActivityLine({ block }: { block: MessageBlock }) {
  const [open, setOpen] = useState(false);
  const isUse = block.type === 'tool_use';
  return (
    <div>
      <button onClick={() => block.content && setOpen(v => !v)} className={cn('flex items-center gap-2 py-[3px] w-full text-left group rounded-sm transition-colors', block.content && 'hover:bg-panel-h/30')}>
        <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', isUse ? 'bg-fg-5/40' : 'bg-ok/40')} />
        <span className="text-[11px] font-mono text-fg-5/60 group-hover:text-fg-3 transition-colors truncate">
          {isUse ? (block.toolName || 'tool') : 'result'}
        </span>
      </button>
      {open && block.content && (
        <pre className="ml-3 mt-1 mb-2 p-3 rounded-md bg-inset border border-edge text-[11px] leading-[1.6] text-fg-4 font-mono whitespace-pre-wrap break-words max-h-[240px] overflow-y-auto">
          {block.content.length > 3000 ? block.content.slice(0, 3000) + '\n\u2026' : block.content}
        </pre>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Thinking section — collapsible, last 3 lines preview
   ═══════════════════════════════════════════════════════════════ */
export function ThinkingSection({ blocks, t }: { blocks: MessageBlock[]; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const text = blocks.map(b => b.content).filter(Boolean).join('\n\n').trim();
  if (!text) return null;

  const preview = lastNLines(text, 3);

  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen(v => !v)}
      dot={{ color: 'bg-violet-400/50' }}
      label={t('hub.thinking')}
      collapsedContent={
        preview ? (
          <div className="px-3.5 pb-2.5 -mt-0.5 text-[12px] text-fg-4 leading-[1.65] whitespace-pre-wrap break-words line-clamp-3">
            {preview}
          </div>
        ) : undefined
      }
    >
      <ThinkingExpandedContent scrollRef={scrollRef} text={text} />
    </CollapsibleCard>
  );
}

/** Expanded thinking content — scrolls to bottom on mount. */
export function ThinkingExpandedContent({ scrollRef, text }: { scrollRef: React.RefObject<HTMLDivElement | null>; text: string }) {
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  return (
    <div ref={scrollRef} className="px-3.5 py-3 text-[12px] text-fg-4 leading-[1.7] whitespace-pre-wrap break-words max-h-[320px] overflow-y-auto">
      {text}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Output — markdown
   ═══════════════════════════════════════════════════════════════ */
export function OutputBlock({ blocks }: { blocks: MessageBlock[] }) {
  const textBlocks = blocks.filter(b => b.type === 'text');
  const imageBlocks = blocks.filter(b => b.type === 'image');
  const text = textBlocks.map(b => b.content).filter(Boolean).join('\n\n');
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  if (!text.trim() && imageBlocks.length === 0) return null;
  return (
    <>
      {text.trim() && (
        <div className="session-md text-[13.5px] leading-[1.75] text-fg-2">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {text}
          </ReactMarkdown>
        </div>
      )}
      {imageBlocks.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {imageBlocks.map((img, i) => (
            <img
              key={i}
              src={img.content}
              className="max-w-[400px] max-h-[300px] rounded-md border border-fg-6/50 object-contain cursor-zoom-in hover:opacity-90 transition-opacity"
              onClick={() => setLightboxSrc(img.content)}
            />
          ))}
        </div>
      )}
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
