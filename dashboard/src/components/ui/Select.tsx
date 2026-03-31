import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils';

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

function containsNode(container: HTMLElement | null, target: EventTarget | null): boolean {
  return !!(container && target instanceof Node && container.contains(target));
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
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (containsNode(rootRef.current, event.target) || containsNode(menuRef.current, event.target)) return;
      setOpen(false);
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
        ref={menuRef}
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

/* ── IconPicker — compact icon-only dropdown ── */
export function IconPicker({
  value,
  options,
  onChange,
  renderIcon,
}: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  renderIcon: (value: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<SelectMenuStyle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (containsNode(rootRef.current, event.target) || containsNode(menuRef.current, event.target)) return;
      setOpen(false);
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
        width: Math.max(rect.width, 160),
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

  const menu = open && menuStyle
    ? createPortal(
      <div
        ref={menuRef}
        role="listbox"
        className="fixed z-[220] overflow-hidden rounded-xl border border-edge-h bg-[var(--th-dropdown)] p-1.5 shadow-[0_24px_64px_rgba(2,6,23,0.22)] backdrop-blur-xl"
        style={{ left: menuStyle.left, top: menuStyle.top, width: menuStyle.width }}
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
                onClick={() => { onChange(option.value); setOpen(false); }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors duration-200',
                  selected
                    ? 'bg-panel text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]'
                    : 'text-fg-3 hover:bg-panel-alt hover:text-fg-2'
                )}
              >
                {renderIcon(option.value)}
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
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border border-edge bg-inset px-2 py-1.5',
          'transition-[border-color,box-shadow,background] duration-200 outline-none',
          'hover:border-edge-h hover:bg-panel',
          'focus-visible:border-edge-h focus-visible:shadow-[0_0_0_4px_var(--th-glow-a)]',
          open && 'border-edge-h bg-panel shadow-[0_0_0_4px_var(--th-glow-a)]'
        )}
      >
        {renderIcon(value)}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={cn('text-fg-5 transition-transform duration-200', open && 'rotate-180')}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {menu}
    </div>
  );
}
