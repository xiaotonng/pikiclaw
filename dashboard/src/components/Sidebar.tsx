import { useStore } from '../store';
import { createT } from '../i18n';
import { cn } from '../utils';

const IconConfig = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
const IconTerminal = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
const IconGrid = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>;
const IconFolder = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>;
const IconRestart = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>;
const IconSun = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
const IconMoon = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>;

export function Sidebar({ version, onSwitchWorkdir, onRestart }: {
  version: string;
  onSwitchWorkdir: () => void;
  onRestart: () => void;
}) {
  const { state, tab, setTab, theme, setTheme, locale, setLocale } = useStore();
  const t = createT(locale);
  const workdir = state?.bot?.workdir || state?.runtimeWorkdir || '';

  const tabs = [
    { key: 'config', label: t('tab.config'), icon: IconConfig },
    { key: 'sessions', label: t('tab.sessions'), icon: IconTerminal },
    { key: 'plugins', label: t('tab.plugins'), icon: IconGrid },
  ];

  return (
    <aside className="w-[220px] shrink-0 flex flex-col bg-[var(--th-sidebar)] border-r border-edge backdrop-blur-[20px]">
      {/* Logo */}
      <div className="px-5 py-6 flex items-center gap-3">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-[0_0_20px_var(--th-glow-a)]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        </div>
        <div className="leading-none">
          <div className="text-sm font-semibold tracking-tight text-gradient">Codeclaw</div>
          <div className="inline-flex items-center mt-1">
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-indigo-500/8 text-indigo-500/70 shadow-[inset_0_0_0_1px_rgba(129,140,248,0.15)]">
              v{version}
            </span>
          </div>
        </div>
      </div>

      <hr className="h-px bg-edge border-none" />

      {/* Nav */}
      <nav className="flex-1 p-2 space-y-0.5">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-2.5 w-full px-3.5 py-2.5 rounded-[10px] text-[13px] font-medium cursor-pointer border-none text-left transition-all duration-200',
              tab === t.key
                ? 'text-fg bg-panel-h shadow-[inset_0_0_0_1px_var(--th-edge)]'
                : 'text-fg-4 bg-transparent hover:text-fg-3 hover:bg-panel'
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <hr className="h-px bg-edge border-none" />

      {/* Footer controls */}
      <div className="p-2 space-y-0.5">
        <button onClick={onSwitchWorkdir} className="flex items-center gap-2.5 w-full px-3.5 py-2 rounded-[10px] text-xs text-fg-4 bg-transparent border-none cursor-pointer hover:text-fg-3 hover:bg-panel transition-all duration-200">
          {IconFolder} {t('sidebar.switchDir')}
        </button>
        <button onClick={onRestart} className="flex items-center gap-2.5 w-full px-3.5 py-2 rounded-[10px] text-xs text-fg-4 bg-transparent border-none cursor-pointer hover:text-fg-3 hover:bg-panel transition-all duration-200">
          {IconRestart} {t('sidebar.restart')}
        </button>
      </div>

      <hr className="h-px bg-edge border-none" />

      {/* Theme + Language toggles */}
      <div className="px-2 py-2 flex items-center gap-1">
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-fg-4 bg-transparent border-none cursor-pointer hover:text-fg-2 hover:bg-panel transition-all duration-200"
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        >
          {theme === 'dark' ? IconSun : IconMoon}
        </button>
        <button
          onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}
          className="flex items-center justify-center h-8 px-2 rounded-lg text-[10px] font-mono font-semibold text-fg-4 bg-transparent border-none cursor-pointer hover:text-fg-2 hover:bg-panel transition-all duration-200 tracking-wider"
        >
          {locale === 'zh-CN' ? 'EN' : '中'}
        </button>
      </div>

      {/* Workdir */}
      <div className="px-3 py-2 border-t border-edge">
        <div
          className="text-[10px] font-mono text-fg-5 truncate cursor-pointer hover:text-fg-4 transition-colors"
          title={workdir || t('sidebar.notSet')}
          onClick={onSwitchWorkdir}
        >
          {workdir || t('sidebar.notSet')}
        </div>
      </div>

      {/* Status */}
      <div className="px-4 py-3 border-t border-edge">
        <div className="text-[10px] font-mono text-fg-6 space-y-0.5">
          {state && <div>PID {state.pid}  Node {state.nodeVersion}</div>}
        </div>
      </div>
    </aside>
  );
}
