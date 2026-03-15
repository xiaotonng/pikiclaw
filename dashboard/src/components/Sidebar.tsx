import { useStore } from '../store';
import { createT } from '../i18n';
import { Button, TabsList, TabsTrigger } from './ui';

const IconSun = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
const IconMoon = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>;

export function Sidebar({
  version,
  confirmingRestart,
  onRestartClick,
}: {
  version: string;
  confirmingRestart: boolean;
  onRestartClick: () => void;
}) {
  const { tab, setTab, theme, setTheme, locale, setLocale } = useStore();
  const t = createT(locale);

  const tabs = [
    { key: 'config', label: t('tab.config') },
    { key: 'extensions', label: t('tab.extensions') },
    { key: 'sessions', label: t('tab.sessions') },
  ];

  return (
    <header className="sticky top-0 z-40 bg-[var(--th-sidebar)] border-b border-edge backdrop-blur-[20px] [backdrop-filter:blur(20px)_saturate(1.2)]">
      <div className="max-w-[1100px] mx-auto px-6 h-16 flex items-center gap-5">
        {/* Logo */}
        <div className="flex items-center gap-3 shrink-0 mr-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-[linear-gradient(145deg,rgba(226,232,240,0.18),rgba(148,163,184,0.08))] shadow-[0_10px_32px_var(--th-glow-a)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-fg" strokeWidth="2.2" strokeLinecap="round"><path d="M13 2L3 14h8l-1 8 11-13h-8l1-7z"/></svg>
          </div>
          <div className="leading-none">
            <div className="text-[15px] font-semibold tracking-tight text-gradient">Pikiclaw</div>
          </div>
          <span className="rounded-md border border-edge bg-panel px-2 py-0.5 text-[11px] font-mono text-fg-4">
            v{version}
          </span>
        </div>

        {/* Tab navigation */}
        <nav>
          <TabsList>
            {tabs.map(t => (
              <TabsTrigger
                key={t.key}
                active={tab === t.key}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </nav>

        {/* Spacer */}
        <div className="flex-1 min-w-0" />

        {/* Right-side actions */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant={confirmingRestart ? 'secondary' : 'outline'}
            size="sm"
            onClick={onRestartClick}
            title={confirmingRestart ? t('modal.confirmRestart') : t('sidebar.restart')}
            className={confirmingRestart ? 'border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/10 hover:text-amber-100' : ''}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            <span className="hidden md:inline">{confirmingRestart ? t('modal.confirmRestart') : t('sidebar.restart')}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            {theme === 'dark' ? IconSun : IconMoon}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}
            className="font-mono font-semibold tracking-wider"
          >
            {locale === 'zh-CN' ? 'EN' : '\u4e2d'}
          </Button>
        </div>
      </div>
    </header>
  );
}
