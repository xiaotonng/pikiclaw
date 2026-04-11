import { useState, memo, type ReactNode } from 'react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import { cn, getAgentMeta } from '../../utils';
import { BrandIcon } from '../../components/BrandIcon';
import { mdComponents, mdPlugins } from './markdown';
import { isContinuationSummary } from './utils';
import { AssistantMsg } from './AssistantContent';
import type { MessageBlock } from '../../types';
import type { Turn } from './utils';

export const TurnView = memo(function TurnView({ turn, agent, meta, model, effort, t, onResend, onEdit }: {
  turn: Turn; agent: string; meta: ReturnType<typeof getAgentMeta>; model?: string; effort?: string | null; t: (k: string) => string;
  onResend?: (text: string) => void;
  onEdit?: (text: string) => void;
}) {
  // Detect system continuation messages stored as user role (context compression summaries,
  // interruption markers). These should not render as user bubbles regardless of whether
  // the turn also contains an assistant response.
  const isSystemMsg = turn.user && isContinuationSummary(turn.user.text);

  return (
    <div className="session-turn">
      {turn.user && !isSystemMsg && (
        <UserBubble text={turn.user.text} blocks={turn.user.blocks} t={t} onResend={onResend} onEdit={onEdit} />
      )}
      {isSystemMsg && turn.user && !turn.assistant && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-[rgba(255,255,255,0.02)] border border-edge/20 text-[12.5px] leading-[1.7] text-fg-4">
          <ReactMarkdown remarkPlugins={mdPlugins} components={mdComponents}>
            {turn.user.text}
          </ReactMarkdown>
        </div>
      )}
      {turn.assistant && <TurnDivider agent={agent} meta={meta} model={model} effort={effort} />}
      {turn.assistant && (
        <div className="mb-6">
          <AssistantMsg message={turn.assistant} t={t} />
        </div>
      )}
    </div>
  );
});

/** Lightbox for full-screen image preview */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out"
      onClick={onClose}
    >
      <img
        src={src}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}

/** User message bubble with actions */
export function UserBubble({ text, blocks, t, onResend, onEdit }: {
  text: string;
  blocks?: MessageBlock[];
  t: (k: string) => string;
  onResend?: (text: string) => void;
  onEdit?: (text: string) => void;
}) {
  const [showActions, setShowActions] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const hasActions = !!(onResend || onEdit);
  const imageBlocks = blocks?.filter(b => b.type === 'image') || [];

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  return (
    <div
      className="flex flex-col items-end mb-5 group/bubble"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className="max-w-[72%] rounded-md border border-fg-6 bg-panel px-4 py-3 text-[13.5px] leading-[1.72] text-fg shadow-sm">
        {text && <div className="whitespace-pre-wrap break-words">{text}</div>}
        {imageBlocks.length > 0 && (
          <div className={cn('flex flex-wrap gap-2', text && 'mt-2')}>
            {imageBlocks.map((img, i) => (
              <img
                key={i}
                src={img.content}
                className="max-w-[280px] max-h-[200px] rounded border border-fg-6/50 object-cover cursor-zoom-in hover:opacity-90 transition-opacity"
                onClick={() => setLightboxSrc(img.content)}
              />
            ))}
          </div>
        )}
      </div>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      {/* Action bar — appears below the bubble on hover */}
      {hasActions && (
        <div className={cn(
          'flex items-center gap-1 mt-1.5 mr-1 transition-all duration-200',
          showActions ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1 pointer-events-none',
        )}>
          <BubbleAction label={copied ? t('hub.copied') : t('hub.copy')} onClick={handleCopy}>
            {copied
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            }
          </BubbleAction>
          {onResend && (
            <BubbleAction label={t('hub.rerun')} onClick={() => onResend(text)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </BubbleAction>
          )}
          {onEdit && (
            <BubbleAction label={t('hub.edit')} onClick={() => onEdit(text)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </BubbleAction>
          )}
        </div>
      )}
    </div>
  );
}

export function BubbleAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="flex items-center justify-center w-7 h-7 rounded border border-fg-6 bg-panel text-fg-4 shadow-sm hover:text-fg-2 hover:border-edge-h hover:bg-panel-h transition-colors"
    >
      {children}
    </button>
  );
}

export function TurnDivider({ agent, meta, model, effort }: { agent: string; meta: ReturnType<typeof getAgentMeta>; model?: string; effort?: string | null }) {
  return (
    <div className="flex items-center gap-1.5 mt-1 mb-3">
      <BrandIcon brand={agent} size={13} />
      <span style={{ color: meta.color }} className="text-[12px] font-semibold opacity-70">{meta.label}</span>
      {model && <span className="text-[10px] font-mono text-fg-5/50">{model}{effort ? ` · ${effort}` : ''}</span>}
    </div>
  );
}
