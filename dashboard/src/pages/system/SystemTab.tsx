import { useMemo } from 'react';
import { createT } from '../../i18n';
import { useStore } from '../../store';
import { buildHostMetricItems, formatHostSummary, SystemInfoList } from '../../components/SystemInfoPanel';
import { Button } from '../../components/ui';
import { SectionCard } from '../shared';
import { PermissionsTab } from '../permissions/PermissionsTab';

export function SystemTab({
  onOpenWorkdir,
}: {
  onOpenWorkdir: () => void;
}) {
  const state = useStore(s => s.state);
  const host = useStore(s => s.host);
  const locale = useStore(s => s.locale);
  const t = useMemo(() => createT(locale), [locale]);
  const currentWorkdir = state?.bot?.workdir || state?.runtimeWorkdir || state?.config.workdir || '';
  const hostSummary = formatHostSummary(host);

  return (
    <div className="animate-in space-y-3">
      <SectionCard className="!p-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold tracking-tight text-fg">{t('config.workdir')}</span>
            </div>
            <div className="mt-0.5 break-all font-mono text-[12px] leading-relaxed text-fg-2">
              {currentWorkdir || t('sidebar.notSet')}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onOpenWorkdir}>
            {t('sidebar.switchDir')}
          </Button>
        </div>
      </SectionCard>

      <SectionCard className="space-y-2 !p-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[13px] font-semibold tracking-tight text-fg">{t('app.systemInfo')}</span>
            <span className="truncate text-[11px] text-fg-5">{hostSummary || t('status.loading')}</span>
          </div>
          <div className="text-[11px] text-fg-5">
            {state?.version ? `Pikiclaw v${state.version}` : 'Pikiclaw'}
            {state?.nodeVersion ? ` · Node ${state.nodeVersion}` : ''}
          </div>
        </div>

        <SystemInfoList items={buildHostMetricItems(host, t)} loading={!host} />
      </SectionCard>

      <SectionCard className="space-y-2 !p-3.5">
        <div className="text-[13px] font-semibold tracking-tight text-fg">{t('tab.permissions')}</div>
        <PermissionsTab />
      </SectionCard>
    </div>
  );
}
