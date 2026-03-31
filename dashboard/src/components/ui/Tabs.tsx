import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../utils';

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
