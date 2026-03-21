import { useStore } from '../store';
import { createT } from '../i18n';
import { SectionLabel } from './ui';
import { Automation } from './ConfigTab';

export function AutomationTab({
  onOpenBrowserSetup,
  onOpenDesktopSetup,
}: {
  onOpenBrowserSetup: () => void;
  onOpenDesktopSetup: () => void;
}) {
  const { locale } = useStore();
  const t = createT(locale);

  return (
    <div className="animate-in space-y-8">
      <section className="space-y-4">
        <SectionLabel>{t('ext.title')}</SectionLabel>
        <Automation onOpenBrowserSetup={onOpenBrowserSetup} onOpenDesktopSetup={onOpenDesktopSetup} />
      </section>
    </div>
  );
}
