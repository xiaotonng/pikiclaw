import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../utils';

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

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cn('mb-2 block text-sm font-medium text-fg-3', className)}>{children}</label>;
}
