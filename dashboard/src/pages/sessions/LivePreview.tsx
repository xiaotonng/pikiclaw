import { useState, useRef, useLayoutEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CollapsibleCard, CountBadge, Spinner } from '../../components/ui';
import { PlanProgressCard, hasPlan } from '../../components/PlanProgressCard';
import { mdComponents } from './markdown';
import { lastNLines } from './utils';
import type { StreamPlan } from '../../types';

/* ── Live streaming preview ── */
export function LivePreview({
  stream,
  t,
}: {
  stream: { phase: 'streaming' | 'done'; text: string; thinking: string; activity?: string; plan?: StreamPlan | null };
  t: (k: string) => string;
}) {
  const showPlan = hasPlan(stream.plan);
  const [activityOpen, setActivityOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const activityScrollRef = useRef<HTMLDivElement>(null);
  const thinkingScrollRef = useRef<HTMLDivElement>(null);
  const showBody = !!stream.text || !!stream.activity || !!stream.thinking;

  const activityLines = useMemo(() =>
    (stream.activity || '').split('\n').filter(Boolean),
    [stream.activity],
  );
  const lastActivity = activityLines[activityLines.length - 1] || '';

  // Auto-scroll activity detail to bottom when content updates
  useLayoutEffect(() => {
    const el = activityScrollRef.current;
    if (el && activityOpen) el.scrollTop = el.scrollHeight;
  }, [activityOpen, stream.activity]);

  // Auto-scroll thinking detail to bottom when content updates
  useLayoutEffect(() => {
    const el = thinkingScrollRef.current;
    if (el && thinkingOpen) el.scrollTop = el.scrollHeight;
  }, [thinkingOpen, stream.thinking]);

  return (
    <div className="space-y-3 animate-in">
      {/* Plan — prominent card at top */}
      {showPlan && (
        <PlanProgressCard plan={stream.plan!} phase={stream.phase} t={t} className="mb-1 max-w-[760px]" />
      )}

      {/* Activity — expandable, shows latest line as preview */}
      {activityLines.length > 0 && (
        <CollapsibleCard
          open={activityOpen}
          onToggle={() => setActivityOpen(v => !v)}
          dot={{ color: 'bg-cyan-400/60', pulse: true }}
          label={t('hub.activity')}
          preview={<span className="text-[12px] text-fg-4 truncate">{lastActivity}</span>}
          badge={activityLines.length > 1 ? <CountBadge>{activityLines.length}</CountBadge> : undefined}
        >
          <div ref={activityScrollRef} className="px-3.5 py-2.5 space-y-0.5 max-h-[240px] overflow-y-auto">
            {activityLines.map((line, i) => (
              <div key={i} className="flex items-center gap-1.5 py-[2px]">
                <span className="w-1 h-1 rounded-full shrink-0 bg-fg-5/30" />
                <span className="text-[11px] font-mono text-fg-5/60 truncate">{line}</span>
              </div>
            ))}
          </div>
        </CollapsibleCard>
      )}

      {/* Thinking — 3-line preview, expandable */}
      {stream.thinking && (
        <CollapsibleCard
          open={thinkingOpen}
          onToggle={() => setThinkingOpen(v => !v)}
          dot={{ color: 'bg-violet-400/50', pulse: true }}
          label={t('hub.thinking')}
          collapsedContent={
            <div className="px-3.5 pb-2.5 -mt-0.5 text-[12px] text-fg-4 leading-[1.65] whitespace-pre-wrap break-words line-clamp-3">
              {lastNLines(stream.thinking, 3)}
            </div>
          }
        >
          <div ref={thinkingScrollRef} className="px-3.5 py-3 text-[12px] text-fg-4 leading-[1.7] whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
            {stream.thinking}
          </div>
        </CollapsibleCard>
      )}

      {/* Response text with typing cursor */}
      {stream.text && (
        <div className="session-md text-[13.5px] leading-[1.75] text-fg-2">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {stream.text}
          </ReactMarkdown>
          {stream.phase === 'streaming' && <span className="inline-block w-[2px] h-[16px] bg-fg-3 animate-pulse ml-0.5 align-text-bottom" />}
        </div>
      )}

      {/* Waiting state — no content yet */}
      {!showPlan && !showBody && (
        <div className="flex items-center gap-2.5 py-1">
          <Spinner className="h-3.5 w-3.5 text-fg-5" />
          <span className="text-[12px] text-fg-5">{t('status.running')}</span>
        </div>
      )}
    </div>
  );
}
