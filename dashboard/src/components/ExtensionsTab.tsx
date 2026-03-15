import { useStore } from '../store';
import { createT } from '../i18n';
import { SectionLabel } from './ui';
import { Extensions } from './ConfigTab';

export function ExtensionsTab({
  onOpenPlaywrightSetup,
  onOpenDesktopSetup,
}: {
  onOpenPlaywrightSetup: () => void;
  onOpenDesktopSetup: () => void;
}) {
  const { locale } = useStore();
  const t = createT(locale);

  return (
    <div className="animate-in space-y-8">
      <section className="space-y-4">
        <SectionLabel>{t('ext.title')}</SectionLabel>
        <Extensions onOpenPlaywrightSetup={onOpenPlaywrightSetup} onOpenDesktopSetup={onOpenDesktopSetup} />
      </section>
    </div>
  );
}
