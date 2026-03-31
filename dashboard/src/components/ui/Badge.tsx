import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../utils';

/* ── Badge ── */
type BadgeVariant = 'ok' | 'warn' | 'err' | 'muted' | 'accent';

const badgeStyles: Record<BadgeVariant, CSSProperties> = {
  ok: {
    borderColor: 'var(--th-badge-ok-border)',
    backgroundColor: 'var(--th-badge-ok-bg)',
    color: 'var(--th-badge-ok-text)',
  },
  warn: {
    borderColor: 'var(--th-badge-warn-border)',
    backgroundColor: 'var(--th-badge-warn-bg)',
    color: 'var(--th-badge-warn-text)',
  },
  err: {
    borderColor: 'var(--th-badge-err-border)',
    backgroundColor: 'var(--th-badge-err-bg)',
    color: 'var(--th-badge-err-text)',
  },
  muted: {
    borderColor: 'var(--th-badge-muted-border)',
    backgroundColor: 'var(--th-badge-muted-bg)',
    color: 'var(--th-badge-muted-text)',
  },
  accent: {
    borderColor: 'var(--th-badge-accent-border)',
    backgroundColor: 'var(--th-badge-accent-bg)',
    color: 'var(--th-badge-accent-text)',
  },
};

export function Badge({ variant = 'muted', children, className }: { variant?: BadgeVariant; children: ReactNode; className?: string }) {
  return (
    <span
      style={badgeStyles[variant]}
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-md border px-2 text-[11px] font-medium tracking-[0.01em]',
        className
      )}
    >
      {children}
    </span>
  );
}

/* ── Dot — status indicator ── */
type DotVariant = 'ok' | 'warn' | 'err' | 'idle';

export function Dot({ variant = 'idle', pulse }: { variant?: DotVariant; pulse?: boolean }) {
  const styles: Record<DotVariant, string> = {
    ok: 'bg-[var(--th-ok)] shadow-[0_0_10px_var(--th-ok-glow)]',
    warn: 'bg-[var(--th-warn)] shadow-[0_0_10px_var(--th-warn-glow)]',
    err: 'bg-[var(--th-err)] shadow-[0_0_10px_var(--th-err-glow)]',
    idle: 'bg-fg-5',
  };

  return <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', styles[variant], pulse && 'animate-pulse-soft')} />;
}

/* ── CountBadge — compact numeric/status indicator ── */
export function CountBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn(
      'rounded-md border border-edge bg-inset px-1.5 py-0.5 text-[10px] font-mono text-fg-5',
      className,
    )}>
      {children}
    </span>
  );
}
