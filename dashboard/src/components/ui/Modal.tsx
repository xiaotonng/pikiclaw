import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { cn } from '../../utils';
import { Button } from './Button';

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
