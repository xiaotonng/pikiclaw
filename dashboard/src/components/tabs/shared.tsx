import type { ReactNode } from 'react';
import { Badge, Button, Card, Dot, Spinner } from '../ui';
import { cn } from '../../utils';

export type Tone = 'ok' | 'warn' | 'err' | 'accent' | 'muted';

export function TabHero({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow: string;
  title: string;
  description: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-edge bg-[linear-gradient(180deg,var(--color-panel),var(--color-panel-alt))] p-5 shadow-[0_1px_0_rgba(255,255,255,0.03),0_20px_48px_rgba(2,6,23,0.18)] xl:flex-row xl:items-end xl:justify-between">
      <div className="max-w-3xl">
        <Badge variant="accent">{eyebrow}</Badge>
        <div className="mt-3 text-[26px] font-semibold tracking-tight text-fg">{title}</div>
        <div className="mt-2 text-sm leading-relaxed text-fg-4">{description}</div>
      </div>
      {right && <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

export function StatusBadge({
  tone,
  label,
  loading,
}: {
  tone: Tone;
  label: string;
  loading?: boolean;
}) {
  return (
    <Badge variant={tone === 'accent' ? 'accent' : tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'err' ? 'err' : 'muted'}>
      {loading && <Spinner />}
      {label}
    </Badge>
  );
}

export function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-edge bg-panel-alt px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-5">{label}</div>
      <div className="mt-1 text-base font-semibold text-fg">{value}</div>
      {hint && <div className="mt-1 text-xs leading-relaxed text-fg-4">{hint}</div>}
    </div>
  );
}

export function DetailGrid({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; mono?: boolean }>;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map(item => (
        <div key={item.label} className="rounded-xl border border-edge bg-panel-alt px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-5">{item.label}</div>
          <div className={cn('mt-1 break-words text-sm leading-relaxed text-fg-2', item.mono && 'font-mono text-[12px] text-fg-3')}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export function StepList({
  steps,
}: {
  steps: string[];
}) {
  return (
    <ol className="space-y-2 text-sm leading-relaxed text-fg-3">
      {steps.map(step => (
        <li key={step} className="rounded-xl border border-edge bg-panel-alt px-3 py-2">
          {step}
        </li>
      ))}
    </ol>
  );
}

export function ActionBar({
  primary,
  secondary,
  tertiary,
}: {
  primary?: { label: string; onClick: () => void | Promise<void>; disabled?: boolean; loading?: boolean };
  secondary?: { label: string; onClick: () => void | Promise<void>; disabled?: boolean };
  tertiary?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        {primary && (
          <Button variant="primary" onClick={primary.onClick} disabled={primary.disabled}>
            {primary.loading && <Spinner />}
            {primary.label}
          </Button>
        )}
        {secondary && (
          <Button variant="outline" onClick={secondary.onClick} disabled={secondary.disabled}>
            {secondary.label}
          </Button>
        )}
      </div>
      {tertiary && <div className="text-xs leading-relaxed text-fg-4">{tertiary}</div>}
    </div>
  );
}

export function StatusRail({
  label,
  value,
  tone,
  pulse,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'err' | 'idle';
  pulse?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-edge bg-panel-alt px-3 py-1.5 text-xs text-fg-4">
      <Dot variant={tone} pulse={pulse} />
      <span className="font-semibold uppercase tracking-[0.16em] text-fg-5">{label}</span>
      <span className="text-fg-2">{value}</span>
    </div>
  );
}

export function SectionCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <Card className={cn('p-4', className)}>{children}</Card>;
}

export function SettingRowCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'glass overflow-hidden rounded-md border border-edge shadow-[0_1px_0_rgba(255,255,255,0.02),0_4px_12px_rgba(15,23,42,0.05)]',
        'transition-[border-color,background,transform,box-shadow] duration-200',
        'grid gap-x-5 gap-y-2 px-4 py-2.5',
        'xl:grid-cols-[minmax(0,205px)_minmax(220px,0.95fr)_minmax(0,1.15fr)_auto] xl:items-center',
        className
      )}
    >
      {children}
    </div>
  );
}

export function SettingRowLead({
  icon,
  title,
  subtitle,
  badge,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-panel-alt text-fg-3">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-[14px] font-semibold text-fg">{title}</div>
          {badge}
        </div>
        {subtitle && <div className="mt-0.5 text-[11px] leading-snug text-fg-5">{subtitle}</div>}
      </div>
    </div>
  );
}

export function SettingRowField({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export function SettingRowAction({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('flex justify-start xl:justify-end', className)}>{children}</div>;
}
