import {
  useEffect,
  type CSSProperties,
  type ReactNode,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ButtonHTMLAttributes,
} from 'react';
import { cn } from '../utils';

/* ═══════════════════════════════════════════════════
   Card
   ═══════════════════════════════════════════════════ */
interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  interactive?: boolean;
  glow?: boolean;
}

export function Card({ children, className, interactive, glow, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'glass rounded-xl border border-edge p-5 shadow-[0_1px_0_rgba(255,255,255,0.02),0_18px_40px_rgba(2,6,23,0.14)]',
        'transition-[border-color,background,transform,box-shadow] duration-200',
        interactive && 'cursor-pointer hover:border-edge-h hover:bg-panel-h hover:-translate-y-px',
        glow && 'card-glow',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Badge
   ═══════════════════════════════════════════════════ */
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
        'inline-flex h-6 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium tracking-[0.02em]',
        className
      )}
    >
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
    ok: 'bg-[var(--th-ok)] shadow-[0_0_10px_var(--th-ok-glow)]',
    warn: 'bg-[var(--th-warn)] shadow-[0_0_10px_var(--th-warn-glow)]',
    err: 'bg-[var(--th-err)] shadow-[0_0_10px_var(--th-err-glow)]',
    idle: 'bg-fg-5',
  };

  return <span className={cn('h-2 w-2 shrink-0 rounded-full', styles[variant], pulse && 'animate-pulse-soft')} />;
}

/* ═══════════════════════════════════════════════════
   Button
   ═══════════════════════════════════════════════════ */
type BtnVariant = 'primary' | 'secondary' | 'outline' | 'ghost';
type BtnSize = 'default' | 'sm' | 'icon';

export function Button({
  variant = 'outline',
  size = 'default',
  className,
  type = 'button',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium',
        'transition-[background,color,border-color,box-shadow,transform] duration-200',
        'focus-visible:outline-none focus-visible:border-edge-h focus-visible:shadow-[0_0_0_4px_var(--th-glow-a)]',
        'disabled:pointer-events-none disabled:opacity-50',
        size === 'default' && 'h-9 px-4',
        size === 'sm' && 'h-8 px-3 text-xs',
        size === 'icon' && 'h-9 w-9',
        variant === 'primary' && 'border border-transparent bg-primary text-primary-fg hover:bg-primary-hover',
        variant === 'secondary' && 'border border-edge bg-panel-h text-fg-2 hover:border-edge-h hover:bg-panel',
        variant === 'outline' && 'border border-edge bg-transparent text-fg-2 hover:border-edge-h hover:bg-panel',
        variant === 'ghost' && 'border border-transparent bg-transparent text-fg-4 hover:bg-panel hover:text-fg-2',
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
        'flex h-9 w-full rounded-md border border-edge bg-inset px-3 py-2 text-sm text-fg shadow-sm',
        'transition-[border-color,box-shadow,background] duration-200 outline-none',
        'placeholder:text-fg-5',
        'focus:border-edge-h focus:shadow-[0_0_0_4px_var(--th-glow-a)]',
        className
      )}
      {...props}
    />
  );
}

/* ═══════════════════════════════════════════════════
   Select (custom)
   ═══════════════════════════════════════════════════ */
interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value,
  options,
  onChange,
  className,
  placeholder = '—',
  disabled = false,
  readOnly = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const current = options.find(option => option.value === value);
  const isReadOnly = readOnly || options.length <= 1;

  if (isReadOnly) {
    return (
      <div
        className={cn(
          'flex h-10 w-full items-center rounded-xl border border-edge bg-panel-alt px-3.5 text-sm text-fg-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_1px_2px_rgba(15,23,42,0.05)]',
          disabled && 'cursor-not-allowed opacity-50',
          className
        )}
      >
        <span className={cn('truncate', !current && 'text-fg-5')}>{current?.label || placeholder}</span>
      </div>
    );
  }

  return (
    <div className={cn('relative', className)}>
      <select
        disabled={disabled}
        value={value}
        onChange={event => onChange(event.target.value)}
        className={cn(
          'h-10 w-full appearance-none rounded-xl border border-edge bg-inset px-3.5 pr-10 text-sm text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_1px_2px_rgba(15,23,42,0.05)]',
          'cursor-pointer transition-[border-color,box-shadow,background] duration-200 outline-none',
          'hover:border-edge-h hover:bg-panel',
          'focus:border-edge-h focus:shadow-[0_0_0_4px_var(--th-glow-a)]',
          'disabled:cursor-not-allowed disabled:opacity-50'
        )}
      >
        {!current && <option value="" disabled>{placeholder}</option>}
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>

      <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-fg-4">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Modal
   ═══════════════════════════════════════════════════ */
export function Modal({
  open,
  onClose,
  wide,
  panelStyle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  wide?: boolean;
  panelStyle?: CSSProperties;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[var(--th-overlay)] backdrop-blur-sm" onClick={onClose} />
      <div
        className={cn(
          'glass-strong relative max-h-[min(88vh,860px)] w-full overflow-hidden rounded-xl border border-edge shadow-[0_32px_96px_rgba(2,6,23,0.42)] animate-scale',
          wide ? 'max-w-[720px]' : 'max-w-[480px]'
        )}
        style={panelStyle}
      >
        <div className="max-h-[inherit] overflow-y-auto p-6">{children}</div>
      </div>
    </div>
  );
}

export function ModalHeader({ title, description, onClose }: { title: string; description?: string; onClose: () => void }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-base font-semibold tracking-tight text-fg">{title}</div>
        {description && <div className="mt-1 text-sm leading-relaxed text-fg-4">{description}</div>}
      </div>
      <Button variant="ghost" size="icon" onClick={onClose} className="-mr-1 -mt-1 h-8 w-8 shrink-0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </Button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Tabs
   ═══════════════════════════════════════════════════ */
export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('inline-flex items-center rounded-lg border border-edge bg-panel p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]', className)}>
      {children}
    </div>
  );
}

export function TabsTrigger({
  active,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors duration-200',
        'focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--th-glow-a)]',
        active ? 'bg-panel-h text-fg shadow-[0_1px_0_rgba(255,255,255,0.03)]' : 'text-fg-4 hover:bg-panel-alt hover:text-fg-2',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ═══════════════════════════════════════════════════
   Section Label
   ═══════════════════════════════════════════════════ */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-fg-4">{children}</div>
      <div className="h-px flex-1 bg-edge" />
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   Skeleton
   ═══════════════════════════════════════════════════ */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-shimmer rounded-md', className)} />;
}

/* ═══════════════════════════════════════════════════
   Spinner
   ═══════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════
   Toast container
   ═══════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════
   Label (form)
   ═══════════════════════════════════════════════════ */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cn('mb-2 block text-sm font-medium text-fg-3', className)}>{children}</label>;
}
