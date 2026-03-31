import type { ReactNode, HTMLAttributes } from 'react';
import { cn } from '../../utils';

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
