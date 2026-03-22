import { createT } from '../../i18n';
import { useStore } from '../../store';
import { buildHostMetricItems, formatHostSummary, SystemInfoGrid } from '../SystemInfoPanel';
import { Button } from '../ui';
import { SectionCard } from './shared';

export function SystemTab({
  onOpenWorkdir,
}: {
  onOpenWorkdir: () => void;
}) {
  const { state, host, locale } = useStore();
  const t = createT(locale);
  const currentWorkdir = state?.bot?.workdir || state?.runtimeWorkdir || state?.config.workdir || '';
  const hostSummary = formatHostSummary(host);

  return (
    <div className="animate-in space-y-3">
      <SectionCard className="space-y-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="text-base font-semibold tracking-tight text-fg">{t('config.workdir')}</div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-fg-4">{t('config.workspaceHint')}</div>
            <div className="mt-2.5 break-words font-mono text-[12px] leading-relaxed text-fg-2">
              {currentWorkdir || t('sidebar.notSet')}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onOpenWorkdir}>
            {t('sidebar.switchDir')}
          </Button>
        </div>
      </SectionCard>

      <SectionCard className="space-y-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="text-base font-semibold tracking-tight text-fg">{t('app.systemInfo')}</div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-fg-4">
              {hostSummary || t('status.loading')}
            </div>
          </div>
          <div className="text-[12px] leading-relaxed text-fg-5">
            {state?.version ? `Pikiclaw v${state.version}` : 'Pikiclaw'}
            {state?.nodeVersion ? ` · Node ${state.nodeVersion}` : ''}
          </div>
        </div>

        <SystemInfoGrid items={buildHostMetricItems(host, t)} loading={!host} />
      </SectionCard>
    </div>
  );
}
