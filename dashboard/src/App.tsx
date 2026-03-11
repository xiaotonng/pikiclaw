import { useState, useEffect, useCallback } from 'react';
import { useStore } from './store';
import { createT } from './i18n';
import { Sidebar } from './components/Sidebar';
import { ConfigTab } from './components/ConfigTab';
import { SessionsTab } from './components/SessionsTab';
import { PluginsTab } from './components/PluginsTab';
import { TelegramModal, FeishuModal, WorkdirModal, SessionDetailModal } from './components/Modals';
import { Badge, Dot, Toasts } from './components/ui';
import { api } from './api';
import type { SessionInfo } from './types';

export function App() {
  const { state, tab, toasts, toast, reload, locale } = useStore();
  const t = createT(locale);

  // Modal states
  const [tgOpen, setTgOpen] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);
  const [wdOpen, setWdOpen] = useState(false);
  const [sesOpen, setSesOpen] = useState(false);
  const [sesAgent, setSesAgent] = useState('');
  const [sesId, setSesId] = useState('');
  const [sesInfo, setSesInfo] = useState<SessionInfo | null>(null);

  const [prompted, setPrompted] = useState(false);
  useEffect(() => {
    if (state && !prompted && !state.config.telegramBotToken && !state.config.feishuAppId) {
      setPrompted(true);
      setTimeout(() => setFsOpen(true), 400);
    }
  }, [state, prompted]);

  const handleOpenSession = useCallback((agent: string, sid: string, ses: SessionInfo) => {
    setSesAgent(agent);
    setSesId(sid);
    setSesInfo(ses);
    setSesOpen(true);
  }, []);

  const handleRestart = useCallback(async () => {
    if (!confirm(t('modal.confirmRestart'))) return;
    try { await api.restart(); toast(t('modal.restarting')); } catch { toast(t('modal.restartFailed'), false); }
  }, [toast, t]);

  // Header badge
  let badgeVariant: 'ok' | 'warn' | 'accent' | 'muted' = 'muted';
  let badgeContent = t('status.loading');
  let dotVariant: 'ok' | 'warn' | 'idle' = 'warn';
  let dotPulse = true;
  if (state) {
    if (state.ready && state.bot) {
      badgeVariant = 'ok'; badgeContent = t('status.running'); dotVariant = 'ok'; dotPulse = true;
    } else if (state.ready) {
      badgeVariant = 'accent'; badgeContent = t('status.ready'); dotVariant = 'ok'; dotPulse = false;
    } else {
      badgeVariant = 'warn'; badgeContent = t('status.needsConfig'); dotVariant = 'warn'; dotPulse = true;
    }
  }

  const tabTitles: Record<string, string> = { config: t('tab.config'), sessions: t('tab.sessions'), plugins: t('tab.plugins') };

  return (
    <div className="noise-overlay">
      {/* BG: aurora orbs + dot grid */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="grid-bg absolute inset-0 opacity-60" />
        <div className="absolute -top-48 -right-48 w-[600px] h-[600px] rounded-full" style={{ background: 'radial-gradient(ellipse, var(--th-orb1), transparent 70%)', animation: 'drift 20s ease-in-out infinite' }} />
        <div className="absolute -bottom-48 -left-48 w-[500px] h-[500px] rounded-full" style={{ background: 'radial-gradient(ellipse, var(--th-orb2), transparent 70%)', animation: 'drift 24s ease-in-out infinite reverse' }} />
        <div className="absolute top-1/3 right-1/4 w-[350px] h-[350px] rounded-full" style={{ background: 'radial-gradient(ellipse, var(--th-orb3), transparent 70%)', animation: 'drift 26s ease-in-out infinite 3s' }} />
      </div>

      <div className="relative min-h-screen flex">
        <Sidebar
          version={state?.version || '...'}
          onSwitchWorkdir={() => setWdOpen(true)}
          onRestart={handleRestart}
        />

        <main className="flex-1 overflow-y-auto max-h-screen">
          <header className="sticky top-0 z-30 px-8 py-4 bg-[var(--th-header)] border-b border-edge backdrop-blur-[20px] [backdrop-filter:blur(20px)_saturate(1.2)]">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold tracking-tight text-fg">{tabTitles[tab] || tab}</h2>
              <Badge variant={badgeVariant}>
                <Dot variant={dotVariant} pulse={dotPulse} />
                {badgeContent}
              </Badge>
            </div>
          </header>

          <div className="p-8 max-w-[1100px]">
            {tab === 'config' && <ConfigTab onOpenTelegram={() => setTgOpen(true)} onOpenFeishu={() => setFsOpen(true)} />}
            {tab === 'sessions' && <SessionsTab onOpenSession={handleOpenSession} />}
            {tab === 'plugins' && <PluginsTab />}
          </div>
        </main>
      </div>

      <TelegramModal open={tgOpen} onClose={() => setTgOpen(false)} />
      <FeishuModal open={fsOpen} onClose={() => setFsOpen(false)} />
      <WorkdirModal open={wdOpen} onClose={() => setWdOpen(false)} />
      <SessionDetailModal open={sesOpen} onClose={() => setSesOpen(false)} agent={sesAgent} sessionId={sesId} session={sesInfo} />
      <Toasts items={toasts} />
    </div>
  );
}
