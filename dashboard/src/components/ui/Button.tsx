import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../utils';

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
