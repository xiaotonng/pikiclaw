import { useStore } from '../store';
import { createT } from '../i18n';
import { Card, SectionLabel, Badge } from './ui';

export function PluginsTab() {
  const { locale } = useStore();
  const t = createT(locale);

  const plugins = [
    {
      name: 'Skill',
      descKey: 'plugins.customSkills',
      color: '#818cf8',
      bg: 'rgba(129,140,248,0.08)',
      glow: 'rgba(129,140,248,0.12)',
      icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="1.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
    },
    {
      name: 'MCP',
      descKey: 'plugins.mcp',
      color: '#a78bfa',
      bg: 'rgba(167,139,250,0.08)',
      glow: 'rgba(167,139,250,0.12)',
      icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.5"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>,
    },
    {
      name: t('plugins.service'),
      descKey: 'plugins.service',
      isServiceLabel: true,
      color: '#34d399',
      bg: 'rgba(52,211,153,0.08)',
      glow: 'rgba(52,211,153,0.12)',
      icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
    },
  ];

  return (
    <div className="animate-in space-y-8">
      <section>
        <SectionLabel>{t('plugins.title')}</SectionLabel>
        <div className="grid grid-cols-3 gap-3">
          {plugins.map(p => (
            <Card key={p.name} className="!p-5 flex flex-col items-center justify-center text-center min-h-[140px] opacity-50" glow>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: p.bg, boxShadow: `0 0 16px ${p.glow}` }}>
                {p.icon}
              </div>
              <div className="text-[13px] font-medium text-fg-2 mb-0.5">{p.name}</div>
              <div className="text-[11px] text-fg-5">{p.isServiceLabel ? 'Webhook & API' : t(p.descKey)}</div>
              <Badge variant="muted" className="mt-2 !text-[10px]">{t('plugins.comingSoon')}</Badge>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
