import { useState, useEffect, useCallback } from 'react';
import { useStore } from './store';
import { resolveAppStatusBadge } from './app-status';
import { createT } from './i18n';
import { fmtBytes } from './utils';
import { Sidebar } from './components/Sidebar';
import { ConfigTab } from './components/ConfigTab';
import { SessionsTab } from './components/SessionsTab';
import { ExtensionsTab } from './components/ExtensionsTab';
import { TelegramModal, FeishuModal, WorkdirModal, SessionDetailModal, PlaywrightSetupModal, DesktopSetupModal } from './components/Modals';
import { Badge, Button, Dot, Toasts } from './components/ui';
import { api } from './api';
import type { SessionInfo } from './types';

/* eslint-disable @typescript-eslint/no-unused-vars */

type ModalState =
  | null
  | { type: 'telegram' }
  | { type: 'feishu' }
  | { type: 'workdir' }
  | { type: 'playwright-setup' }
  | { type: 'desktop-setup' }
  | { type: 'session'; agent: string; sessionId: string; session: SessionInfo | null };

export function App() {
  const { state, tab, toasts, toast, reload, locale, host } = useStore();
  const t = createT(locale);
  const [modal, setModal] = useState<ModalState>(null);
  const closeModal = useCallback(() => setModal(null), []);

  const [prompted, setPrompted] = useState(false);
  useEffect(() => {
    if (state && !prompted && !state.config.telegramBotToken && !state.config.feishuAppId) {
      setPrompted(true);
      setTimeout(() => setModal({ type: 'feishu' }), 400);
    }
  }, [state, prompted]);

  const handleOpenSession = useCallback((agent: string, sid: string, ses: SessionInfo) => {
    setModal({ type: 'session', agent, sessionId: sid, session: ses });
  }, []);

  const handleRestart = useCallback(async () => {
    try {
      const result = await api.restart();
      if (!result.ok) {
        toast(result.error || t('modal.restartFailed'), false);
        return;
      }
      toast(t('modal.restarting'));
    } catch {
      toast(t('modal.restartFailed'), false);
    }
  }, [toast, t]);

  const { badgeVariant, badgeContent, dotVariant, dotPulse } = resolveAppStatusBadge(state, t);

  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const onRestartClick = useCallback(() => {
    if (confirmingRestart) {
      setConfirmingRestart(false);
      handleRestart();
    } else {
      setConfirmingRestart(true);
      setTimeout(() => setConfirmingRestart(false), 3000);
    }
  }, [confirmingRestart, handleRestart]);

  const hostSummary = host ? `${host.hostName || '—'}  ·  ${host.cpuCount} cores  ·  ${fmtBytes(host.memoryUsed || (host.totalMem || 0) - (host.freeMem || 0))} / ${fmtBytes(host.totalMem || 0)}` : '';
  const currentWorkdir = state?.bot?.workdir || state?.runtimeWorkdir || state?.config.workdir || '';

  const tabTitles: Record<string, string> = { config: t('tab.config'), extensions: t('tab.extensions'), sessions: t('tab.sessions') };

  return (
    <div className="noise-overlay">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="grid-bg absolute inset-0 opacity-50" />
        <div className="absolute -top-36 right-0 h-[420px] w-[420px] rounded-full" style={{ background: 'radial-gradient(ellipse, var(--th-orb1), transparent 72%)', animation: 'drift 24s ease-in-out infinite' }} />
        <div className="absolute -bottom-40 -left-20 h-[360px] w-[360px] rounded-full" style={{ background: 'radial-gradient(ellipse, var(--th-orb2), transparent 74%)', animation: 'drift 28s ease-in-out infinite reverse' }} />
      </div>

      <div className="relative min-h-screen flex flex-col">
        <Sidebar
          version={state?.version || '...'}
          confirmingRestart={confirmingRestart}
          onRestartClick={onRestartClick}
        />

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1100px] px-6 py-8">
            <div className="mb-8 space-y-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 items-center gap-4">
                  <h2 className="shrink-0 text-lg font-semibold tracking-tight text-fg">{tabTitles[tab] || tab}</h2>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <Badge variant={badgeVariant}>
                    <Dot variant={dotVariant} pulse={dotPulse} />
                    {badgeContent}
                  </Badge>
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-edge bg-panel-alt px-4 py-3 md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
                  <Badge variant="muted">{t('app.systemInfo')}</Badge>
                  {hostSummary && <span className="min-w-0 truncate text-[13px] font-mono text-fg-5">{hostSummary}</span>}
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">{t('config.workdir')}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-3">{currentWorkdir || t('sidebar.notSet')}</span>
                </div>
                <Button variant="outline" size="sm" onClick={() => setModal({ type: 'workdir' })}>
                  {t('sidebar.switchDir')}
                </Button>
              </div>
            </div>
            {tab === 'config' && <ConfigTab onOpenTelegram={() => setModal({ type: 'telegram' })} onOpenFeishu={() => setModal({ type: 'feishu' })} />}
            {tab === 'extensions' && <ExtensionsTab onOpenPlaywrightSetup={() => setModal({ type: 'playwright-setup' })} onOpenDesktopSetup={() => setModal({ type: 'desktop-setup' })} />}
            {tab === 'sessions' && <SessionsTab onOpenSession={handleOpenSession} />}
          </div>
        </main>
      </div>

      <TelegramModal open={modal?.type === 'telegram'} onClose={closeModal} />
      <FeishuModal open={modal?.type === 'feishu'} onClose={closeModal} />
      <PlaywrightSetupModal open={modal?.type === 'playwright-setup'} onClose={closeModal} onSaved={() => reload()} />
      <DesktopSetupModal open={modal?.type === 'desktop-setup'} onClose={closeModal} onSaved={() => reload()} />
      <WorkdirModal open={modal?.type === 'workdir'} onClose={closeModal} />
      <SessionDetailModal
        open={modal?.type === 'session'}
        onClose={closeModal}
        agent={modal?.type === 'session' ? modal.agent : ''}
        sessionId={modal?.type === 'session' ? modal.sessionId : ''}
        session={modal?.type === 'session' ? modal.session : null}
      />
      <Toasts items={toasts} />
    </div>
  );
}
