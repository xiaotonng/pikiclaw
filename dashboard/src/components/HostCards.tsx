import { useStore } from '../store';
import { createT } from '../i18n';
import { fmtBytes, cn } from '../utils';
import { Card, Skeleton } from './ui';

export function HostCards() {
  const { host, locale } = useStore();
  const t = createT(locale);
  if (!host) return <div className="grid grid-cols-4 gap-3">{[0, 1, 2, 3].map(i => <Card key={i}><Skeleton className="w-12 mb-2" /><Skeleton className="w-20" /></Card>)}</div>;

  const total = host.totalMem || 0;
  const used = host.memoryUsed || (total - (host.freeMem || 0));
  const pct = host.memoryPercent || (total > 0 ? (used / total) * 100 : 0);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
      <Card glow>
        <div className="text-[10px] uppercase tracking-wider text-fg-5 mb-1">{t('sessions.host')}</div>
        <div className="text-[13px] font-medium text-fg-2 truncate">{host.hostName || '—'}</div>
      </Card>
      <Card glow>
        <div className="text-[10px] uppercase tracking-wider text-fg-5 mb-1">{t('sessions.cpu')}</div>
        <div className="text-[13px] font-medium text-fg-2">{host.cpuCount} cores</div>
        {host.cpuUsage && <div className="text-[10px] text-fg-5">{host.cpuUsage.usedPercent.toFixed(0)}%</div>}
      </Card>
      <Card glow>
        <div className="text-[10px] uppercase tracking-wider text-fg-5 mb-1">{t('sessions.memory')}</div>
        <div className="text-[13px] font-medium text-fg-2">{fmtBytes(used)} / {fmtBytes(total)}</div>
        <div className="h-1 rounded-full bg-panel mt-1.5 overflow-hidden">
          <div className={cn('h-1 rounded-full transition-all duration-500', pct > 80 ? 'bg-red-500 shadow-[0_0_8px_var(--th-err-glow)]' : pct > 60 ? 'bg-amber-500 shadow-[0_0_8px_var(--th-warn-glow)]' : 'bg-indigo-500 shadow-[0_0_8px_var(--th-glow-a)]')} style={{ width: `${pct.toFixed(0)}%` }} />
        </div>
      </Card>
      <Card glow>
        {host.disk ? (
          <>
            <div className="text-[10px] uppercase tracking-wider text-fg-5 mb-1">{t('sessions.disk')}</div>
            <div className="text-[13px] font-medium text-fg-2">{host.disk.used}/{host.disk.total}</div>
            <div className="text-[10px] text-fg-5">{host.disk.percent}</div>
          </>
        ) : host.battery ? (
          <>
            <div className="text-[10px] uppercase tracking-wider text-fg-5 mb-1">{t('sessions.battery')}</div>
            <div className="text-[13px] font-medium text-fg-2">{host.battery.percent}</div>
            <div className="text-[10px] text-fg-5">{host.battery.state}</div>
          </>
        ) : (
          <>
            <div className="text-[10px] uppercase tracking-wider text-fg-5 mb-1">Arch</div>
            <div className="text-[13px] font-medium text-fg-2">{host.arch || '—'}</div>
          </>
        )}
      </Card>
    </div>
  );
}
