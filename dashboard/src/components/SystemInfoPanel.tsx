import { cn, fmtBytes } from '../utils';
import type { HostInfo } from '../types';
import { Skeleton } from './ui';
import { SectionCard } from './tabs/shared';

type MetricTone = 'ok' | 'warn' | 'err' | 'muted';

export interface SystemMetricItem {
  key: string;
  label: string;
  value: string;
  detail?: string | string[];
  tone?: MetricTone;
  mono?: boolean;
  progressPercent?: number | null;
}

function toneClassName(tone: MetricTone | undefined): string {
  switch (tone) {
    case 'ok':
      return 'text-emerald-200';
    case 'warn':
      return 'text-amber-200';
    case 'err':
      return 'text-red-200';
    default:
      return 'text-fg-2';
  }
}

function progressClassName(percent: number): string {
  if (percent >= 85) return 'bg-red-500 shadow-[0_0_8px_var(--th-err-glow)]';
  if (percent >= 65) return 'bg-amber-500 shadow-[0_0_8px_var(--th-warn-glow)]';
  return 'bg-primary shadow-[0_0_8px_var(--th-glow-a)]';
}

function safePercent(value: number | null | undefined): number | null {
  if (!Number.isFinite(value ?? NaN)) return null;
  return Math.max(0, Math.min(100, Number(value)));
}

function formatLoad(value: number | null | undefined): string | null {
  if (!Number.isFinite(value ?? NaN)) return null;
  return Number(value).toFixed(2);
}

export function formatHostSummary(host: HostInfo | null): string {
  if (!host) return '';
  return [host.hostName || '—', host.platform, host.arch].filter(Boolean).join(' · ');
}

export function buildHostMetricItems(host: HostInfo | null, t: (key: string) => string): SystemMetricItem[] {
  if (!host) return [];

  const totalMem = host.totalMem || 0;
  const usedMem = host.memoryUsed || (totalMem - (host.freeMem || 0));
  const memoryPercent = safePercent(host.memoryPercent || (totalMem > 0 ? (usedMem / totalMem) * 100 : 0));
  const cpuPercent = safePercent(host.cpuUsage?.usedPercent);
  const loadAverage = host.loadAverage || null;
  const loadOne = formatLoad(loadAverage?.one);
  const loadFive = formatLoad(loadAverage?.five);
  const loadFifteen = formatLoad(loadAverage?.fifteen);
  const loadRatio = safePercent(loadAverage ? (loadAverage.one / Math.max(host.cpuCount || 1, 1)) * 100 : null);

  const items: SystemMetricItem[] = [
    {
      key: 'cpu',
      label: t('sessions.cpu'),
      value: cpuPercent != null ? `${cpuPercent.toFixed(0)}%` : `${host.cpuCount} cores`,
      detail: [
        `${host.cpuCount} cores`,
        host.cpuModel || '',
      ].filter(Boolean),
      tone: cpuPercent != null && cpuPercent >= 85 ? 'warn' : 'ok',
      progressPercent: cpuPercent,
    },
    ...(loadOne && loadFive && loadFifteen ? [{
      key: 'cpu-load',
      label: t('system.cpuLoad'),
      value: `1m ${loadOne}`,
      detail: [`5m ${loadFive}`, `15m ${loadFifteen}`],
      tone: loadRatio != null && loadRatio >= 85 ? 'warn' : 'muted',
      progressPercent: loadRatio,
    }] : []),
    {
      key: 'memory',
      label: t('sessions.memory'),
      value: `${fmtBytes(usedMem)} / ${fmtBytes(totalMem)}`,
      detail: memoryPercent != null ? `${memoryPercent.toFixed(0)}%` : undefined,
      tone: memoryPercent != null && memoryPercent >= 85 ? 'warn' : 'ok',
      progressPercent: memoryPercent,
    },
  ];

  if (host.disk) {
    const diskPercent = safePercent(parseFloat(String(host.disk.percent).replace('%', '')));
    items.push({
      key: 'disk',
      label: t('sessions.disk'),
      value: `${host.disk.used} / ${host.disk.total}`,
      detail: host.disk.percent,
      tone: diskPercent != null && diskPercent >= 85 ? 'warn' : 'muted',
      progressPercent: diskPercent,
    });
  } else if (host.battery) {
    const batteryPercent = safePercent(parseFloat(String(host.battery.percent).replace('%', '')));
    items.push({
      key: 'battery',
      label: t('sessions.battery'),
      value: host.battery.percent,
      detail: host.battery.state,
      tone: batteryPercent != null && batteryPercent <= 20 ? 'warn' : 'muted',
      progressPercent: batteryPercent,
    });
  }

  return items;
}

export function SystemInfoGrid({
  items,
  loading,
  compact,
  className,
}: {
  items: SystemMetricItem[];
  loading?: boolean;
  compact?: boolean;
  className?: string;
}) {
  if (loading) {
    const count = compact ? 2 : 4;
    return (
      <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-3', className)}>
        {Array.from({ length: count }, (_, index) => (
          <SectionCard key={index} className="space-y-3 !p-4">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-2 w-full" />
          </SectionCard>
        ))}
      </div>
    );
  }

  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-3', className)}>
      {items.map(item => (
        <SectionCard key={item.key} className={cn('space-y-2.5 !p-4', compact && '!p-3.5')}>
          <div className="text-[10px] uppercase tracking-[0.14em] text-fg-5">{item.label}</div>
          <div className={cn('text-[13px] font-medium leading-snug', toneClassName(item.tone), item.mono && 'font-mono text-[12px]')}>{item.value}</div>
          {Array.isArray(item.detail) ? (
            <div className="space-y-1 text-[10px] leading-relaxed text-fg-5">
              {item.detail.map(line => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : item.detail ? (
            <div className="text-[10px] leading-relaxed text-fg-5">{item.detail}</div>
          ) : null}
          {item.progressPercent != null && (
            <div className="h-1 overflow-hidden rounded-full bg-panel">
              <div
                className={cn('h-1 rounded-full transition-all duration-500', progressClassName(item.progressPercent))}
                style={{ width: `${item.progressPercent.toFixed(0)}%` }}
              />
            </div>
          )}
        </SectionCard>
      ))}
    </div>
  );
}
