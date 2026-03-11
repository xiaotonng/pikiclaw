import { useState, useRef, useEffect, type ReactNode, type InputHTMLAttributes, type ButtonHTMLAttributes } from 'react';
import { cn } from '../utils';

/* ═══════════════════════════════════════════════════
   Card
   ═══════════════════════════════════════════════════ */
interface CardProps {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  onClick?: () => void;
  glow?: boolean;
}

export function Card({ children, className, interactive, onClick, glow }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'glass rounded-[14px] p-3.5 transition-all duration-300 relative',
        'hover:border-edge-h hover:bg-panel-h',
        interactive && 'cursor-pointer card-glow hover:-translate-y-px hover:shadow-[0_4px_24px_var(--th-glow-b)]',
        glow && 'card-glow',
        className
      )}
    >
      {children}
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Badge
   ═══════════════════════════════════════════════════ */
type BadgeVariant = 'ok' | 'warn' | 'err' | 'muted' | 'accent';
const badgeStyles: Record<BadgeVariant, string> = {
  ok: 'bg-emerald-500/10 text-emerald-500 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.2)]',
  warn: 'bg-amber-500/10 text-amber-500 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.2)]',
  err: 'bg-red-500/8 text-red-500 shadow-[inset_0_0_0_1px_rgba(248,113,113,0.15)]',
  muted: 'bg-panel text-fg-4 shadow-[inset_0_0_0_1px_var(--th-edge)]',
  accent: 'bg-indigo-500/10 text-indigo-500 shadow-[inset_0_0_0_1px_rgba(129,140,248,0.2)]',
};

export function Badge({ variant = 'muted', children, className }: { variant?: BadgeVariant; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium tracking-[0.01em]', badgeStyles[variant], className)}>
      {children}
    </span>
  );
}

/* ═══════════════════════════════════════════════════
   Dot
   ═══════════════════════════════════════════════════ */
type DotVariant = 'ok' | 'warn' | 'err' | 'idle';

export function Dot({ variant = 'idle', pulse }: { variant?: DotVariant; pulse?: boolean }) {
  const styles: Record<DotVariant, string> = {
    ok: 'bg-[var(--th-ok)] shadow-[0_0_8px_var(--th-ok-glow)]',
    warn: 'bg-[var(--th-warn)] shadow-[0_0_8px_var(--th-warn-glow)]',
    err: 'bg-[var(--th-err)] shadow-[0_0_8px_var(--th-err-glow)]',
    idle: 'bg-fg-5',
  };
  return <span className={cn('w-[7px] h-[7px] rounded-full shrink-0', styles[variant], pulse && 'animate-pulse-soft')} />;
}

/* ═══════════════════════════════════════════════════
   Button
   ═══════════════════════════════════════════════════ */
type BtnVariant = 'primary' | 'ghost';

export function Button({
  variant = 'ghost', size = 'default', className, children, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'default' | 'sm' }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 font-medium cursor-pointer border-none transition-all duration-200 whitespace-nowrap disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' ? 'h-7 px-2.5 text-xs rounded-lg' : 'h-9 px-4 text-[13px] rounded-[10px]',
        variant === 'primary' && 'bg-primary text-primary-fg shadow-[0_0_20px_var(--th-glow-a)] hover:bg-primary-hover hover:shadow-[0_0_30px_var(--th-glow-a)] hover:-translate-y-px active:scale-[0.97]',
        variant === 'ghost' && 'bg-transparent text-fg-3 border border-edge hover:bg-panel hover:text-fg-2 hover:border-edge-h',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ═══════════════════════════════════════════════════
   Input
   ═══════════════════════════════════════════════════ */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full h-[38px] px-3.5 bg-inset border border-edge rounded-[10px]',
        'text-fg text-[13px] outline-none',
        'transition-[border-color,box-shadow] duration-200',
        'focus:border-primary/50 focus:shadow-[0_0_0_3px_var(--th-glow-b)]',
        'placeholder:text-fg-5',
        className
      )}
      {...props}
    />
  );
}

/* ═══════════════════════════════════════════════════
   Select (custom)
   ═══════════════════════════════════════════════════ */
interface SelectOption { value: string; label: string }

export function Select({ value, options, onChange, className }: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full h-[38px] px-3.5 bg-inset border border-edge rounded-[10px] text-fg text-[13px] cursor-pointer transition-[border-color] duration-200 hover:border-edge-h focus:border-primary/50 focus:outline-none focus:shadow-[0_0_0_3px_var(--th-glow-b)]"
      >
        <span className="flex-1 text-left">{current?.label || '—'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-35"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 right-0 bg-[var(--th-dropdown)] border border-edge rounded-xl p-1 z-50 shadow-[0_12px_40px_rgba(0,0,0,0.2),0_4px_12px_rgba(0,0,0,0.1)] backdrop-blur-[20px]">
          {options.map(o => (
            <div
              key={o.value}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn(
                'flex items-center justify-between px-3 py-2 rounded-lg text-[13px] cursor-pointer transition-colors duration-150',
                o.value === value ? 'text-fg' : 'text-fg-3 hover:bg-panel hover:text-fg-2'
              )}
            >
              <span>{o.label}</span>
              {o.value === value && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--th-primary)" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Modal
   ═══════════════════════════════════════════════════ */
export function Modal({ open, onClose, wide, children }: {
  open: boolean; onClose: () => void; wide?: boolean; children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center">
      <div className="absolute inset-0 bg-[var(--th-overlay)] backdrop-blur-xl" onClick={onClose} />
      <div className={cn(
        'glass-strong relative rounded-[18px] p-7 animate-scale',
        'shadow-[0_24px_64px_rgba(0,0,0,0.2),0_0_80px_var(--th-glow-b)]',
        wide ? 'w-full max-w-[580px] mx-4' : 'w-full max-w-[440px] mx-4'
      )}>
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between mb-5">
      <div className="text-[15px] font-semibold text-fg">{title}</div>
      <Button variant="ghost" size="sm" onClick={onClose} className="!w-7 !h-7 !p-0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </Button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Section Label
   ═══════════════════════════════════════════════════ */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-widest text-fg-4 mb-4">{children}</div>;
}

/* ═══════════════════════════════════════════════════
   Skeleton
   ═══════════════════════════════════════════════════ */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('h-3.5 rounded-md animate-shimmer', className)} />;
}

/* ═══════════════════════════════════════════════════
   Toast container
   ═══════════════════════════════════════════════════ */
export function Toasts({ items }: { items: { id: number; message: string; ok: boolean }[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-200 flex flex-col gap-2">
      {items.map(t => (
        <div
          key={t.id}
          className={cn(
            'px-5 py-3 rounded-[14px] text-[13px] font-medium animate-in backdrop-blur-[16px]',
            t.ok
              ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
              : 'bg-red-500/10 text-red-500 border border-red-500/15'
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Label (form)
   ═══════════════════════════════════════════════════ */
export function Label({ children }: { children: ReactNode }) {
  return <label className="text-[11px] font-medium uppercase tracking-wider block mb-1.5 text-fg-4">{children}</label>;
}
