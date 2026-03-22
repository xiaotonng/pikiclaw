import { useStore } from '../store';
import { createT } from '../i18n';
import { SectionLabel } from './ui';
import AgentTab from './tabs/AgentTab';
import { IMAccessTab } from './tabs/IMAccessTab';
import { PermissionsTab } from './tabs/PermissionsTab';

export function ConfigTab({
  onOpenWeixin,
  onOpenTelegram,
  onOpenFeishu,
}: {
  onOpenWeixin: () => void;
  onOpenTelegram: () => void;
  onOpenFeishu: () => void;
}) {
  const { locale } = useStore();
  const t = createT(locale);

  return (
    <div className="animate-in space-y-8">
      <section className="space-y-4">
        <SectionLabel>{t('config.imAccess')}</SectionLabel>
        <IMAccessTab
          onOpenWeixin={onOpenWeixin}
          onOpenTelegram={onOpenTelegram}
          onOpenFeishu={onOpenFeishu}
        />
      </section>

      <section className="space-y-4">
        <SectionLabel>{t('config.aiAgent')}</SectionLabel>
        <AgentTab />
      </section>

      <section className="space-y-4">
        <SectionLabel>{t('config.sysPerms')}</SectionLabel>
        <PermissionsTab />
      </section>
    </div>
  );
}
