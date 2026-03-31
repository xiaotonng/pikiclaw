import type { ReactNode } from 'react';
import { cn } from '../../utils';

/* ── SectionLabel ── */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-5">{children}</div>
  );
}

/* ── Skeleton ── */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-shimmer rounded-md', className)} />;
}

/* ── Spinner ── */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-3 w-3 animate-spin', className)}
      viewBox="0 0 16 16"
      fill="none"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ── Toasts ── */
export function Toasts({ items }: { items: { id: number; message: string; ok: boolean }[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-200 flex max-w-sm flex-col gap-2">
      {items.map(item => (
        <div
          key={item.id}
          className={cn(
            'animate-in rounded-lg border px-4 py-3 text-sm font-medium shadow-[0_20px_48px_rgba(2,6,23,0.28)] backdrop-blur-xl',
            item.ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-red-500/20 bg-red-500/10 text-red-200'
          )}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
