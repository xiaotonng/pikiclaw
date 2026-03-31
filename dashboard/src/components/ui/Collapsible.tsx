import type { ReactNode } from 'react';
import { cn } from '../../utils';

/* ── ChevronIcon — shared expand/collapse indicator ── */
export function ChevronIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      className={cn('shrink-0 text-fg-5/40 transition-transform duration-200', open && 'rotate-180', className)}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/* ── CollapsibleCard — unified expandable panel ── */
export function CollapsibleCard({
  open,
  onToggle,
  dot,
  label,
  preview,
  badge,
  collapsedContent,
  children,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  dot?: { color: string; pulse?: boolean };
  label: string;
  preview?: ReactNode;
  badge?: ReactNode;
  collapsedContent?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(
      'rounded-md border border-edge bg-panel overflow-hidden',
      'shadow-[0_2px_8px_rgba(0,0,0,0.06)]',
      className,
    )}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-panel-h/40 transition-colors"
      >
        {dot && (
          <span className={cn(
            'h-[7px] w-[7px] shrink-0 rounded-full',
            dot.color,
            dot.pulse && 'animate-pulse',
          )} />
        )}
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fg-5">
          {label}
        </span>
        <span className="flex-1 min-w-0">{preview}</span>
        {badge}
        <ChevronIcon open={open} />
      </button>
      {!open && collapsedContent}
      {open && children && (
        <div className="border-t border-edge">
          {children}
        </div>
      )}
    </div>
  );
}
