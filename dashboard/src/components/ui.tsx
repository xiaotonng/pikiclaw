import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ButtonHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
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
        'glass rounded-md border border-edge p-2.5 shadow-[0_1px_0_rgba(255,255,255,0.02),0_4px_12px_rgba(15,23,42,0.05)]',
        'transition-[border-color,background,transform,box-shadow] duration-200',
        interactive && 'cursor-pointer hover:border-edge-h hover:bg-panel-h',
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
        'inline-flex h-5 items-center gap-1 rounded-md border px-2 text-[11px] font-medium tracking-[0.01em]',
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

  return <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', styles[variant], pulse && 'animate-pulse-soft')} />;
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
        size === 'default' && 'h-8 px-3 text-[13px]',
        size === 'sm' && 'h-7 px-2.5 text-[11px]',
        size === 'icon' && 'h-8 w-8',
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
        'flex h-8 w-full rounded-md border border-edge bg-inset px-2.5 py-1.5 text-[13px] text-fg shadow-sm',
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

interface SelectMenuStyle {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
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
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<SelectMenuStyle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => {
      const trigger = rootRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      const openUpward = spaceBelow < 220 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(140, Math.min(260, openUpward ? spaceAbove : spaceBelow));
      setMenuStyle({
        left: rect.left,
        top: openUpward ? Math.max(12, rect.top - maxHeight - 8) : rect.bottom + 8,
        width: rect.width,
        maxHeight,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  if (isReadOnly) {
    return (
      <div
        className={cn(
          'flex h-8 w-full items-center rounded-md border border-edge bg-panel-alt px-2.5 text-[13px] text-fg-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_1px_2px_rgba(15,23,42,0.05)]',
          disabled && 'cursor-not-allowed opacity-50',
          className
        )}
      >
        <span className={cn('truncate', !current && 'text-fg-5')}>{current?.label || placeholder}</span>
      </div>
    );
  }

  const handleSelect = (nextValue: string) => {
    if (disabled) return;
    onChange(nextValue);
    setOpen(false);
  };

  const menu = open && menuStyle
    ? createPortal(
      <div
        role="listbox"
        className="fixed z-[220] overflow-hidden rounded-xl border border-edge-h bg-[var(--th-dropdown)] p-1.5 shadow-[0_24px_64px_rgba(2,6,23,0.22)] backdrop-blur-xl"
        style={{
          left: menuStyle.left,
          top: menuStyle.top,
          width: menuStyle.width,
        }}
      >
        <div className="overflow-y-auto" style={{ maxHeight: menuStyle.maxHeight }}>
          {options.map(option => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => handleSelect(option.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors duration-200',
                  selected
                    ? 'bg-panel text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
                    : 'text-fg-3 hover:bg-panel-alt hover:text-fg-2'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-fg-4">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>,
      document.body
    )
    : null;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(currentOpen => !currentOpen)}
        className={cn(
          'flex h-8 w-full items-center rounded-md border border-edge bg-inset px-2.5 pr-8 text-left text-[13px] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_1px_2px_rgba(15,23,42,0.05)]',
          'transition-[border-color,box-shadow,background] duration-200 outline-none',
          'hover:border-edge-h hover:bg-panel',
          'focus-visible:border-edge-h focus-visible:shadow-[0_0_0_4px_var(--th-glow-a)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open && 'border-edge-h bg-panel shadow-[0_0_0_4px_var(--th-glow-a)]'
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', !current && 'text-fg-5')}>
          {current?.label || placeholder}
        </span>
        <span className={cn('pointer-events-none absolute inset-y-0 right-3 flex items-center text-fg-4 transition-transform duration-200', open && 'rotate-180')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {menu}
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
      <div
        className="absolute inset-0 backdrop-blur-[10px] backdrop-saturate-125"
        style={{ background: 'linear-gradient(180deg, color-mix(in oklab, var(--th-overlay) 68%, transparent), color-mix(in oklab, var(--th-overlay) 92%, transparent))' }}
        onClick={onClose}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(circle at center, color-mix(in oklab, white 12%, transparent), transparent 38%)' }}
      />
      <div
        className={cn(
          'glass-strong relative max-h-[min(88vh,860px)] w-full overflow-hidden rounded-[24px] border border-edge-h shadow-[0_32px_96px_rgba(2,6,23,0.28),0_8px_24px_rgba(15,23,42,0.08)] animate-scale',
          wide ? 'max-w-[720px]' : 'max-w-[480px]'
        )}
        style={{
          ...panelStyle,
          background: 'linear-gradient(180deg, color-mix(in oklab, var(--th-modal-bg) 90%, white 10%), color-mix(in oklab, var(--th-modal-bg) 97%, white 3%))',
        }}
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
    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-5">{children}</div>
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
