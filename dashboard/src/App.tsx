import { useState, useEffect, useCallback } from 'react';
import { useStore } from './store';
import { createT } from './i18n';
import { Sidebar } from './components/Sidebar';
import AgentTab from './components/tabs/AgentTab';
import { IMAccessTab } from './components/tabs/IMAccessTab';
import { PermissionsTab } from './components/tabs/PermissionsTab';
import { ExtensionsTab } from './components/tabs/ExtensionsTab';
import { SystemTab } from './components/tabs/SystemTab';
import { SessionsTab } from './components/SessionsTab';
import { TelegramModal, FeishuModal, WeixinModal, WorkdirModal, SessionDetailModal, BrowserSetupModal, DesktopSetupModal } from './components/Modals';
import { Toasts } from './components/ui';
import { api } from './api';
import { getDashboardTabMeta } from './tabs';
import type { SessionInfo } from './types';

/* eslint-disable @typescript-eslint/no-unused-vars */

type ModalState =
  | null
  | { type: 'weixin' }
  | { type: 'telegram' }
  | { type: 'feishu' }
  | { type: 'workdir' }
  | { type: 'browser-setup' }
  | { type: 'desktop-setup' }
  | { type: 'session'; agent: string; sessionId: string; session: SessionInfo | null };

export function App() {
  const { state, tab, toasts, toast, reload, locale } = useStore();
  const t = createT(locale);
  const [modal, setModal] = useState<ModalState>(null);
  const closeModal = useCallback(() => setModal(null), []);

  const [prompted, setPrompted] = useState(false);
  useEffect(() => {
    if (
      state
      && !prompted
      && !state.config.weixinBotToken
      && !state.config.telegramBotToken
      && !state.config.feishuAppId
    ) {
      setPrompted(true);
      setTimeout(() => setModal({ type: 'weixin' }), 400);
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

  const tabMeta = getDashboardTabMeta(tab, t);

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
          <div className="mx-auto max-w-[1120px] px-5 py-3">
            <div className="mb-3 border-b border-edge pb-2">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight text-fg">{tabMeta.title}</h2>
                {tabMeta.description && <div className="mt-0.5 text-[13px] leading-relaxed text-fg-4">{tabMeta.description}</div>}
              </div>
            </div>
            {tab === 'im' && (
              <IMAccessTab
                onOpenWeixin={() => setModal({ type: 'weixin' })}
                onOpenTelegram={() => setModal({ type: 'telegram' })}
                onOpenFeishu={() => setModal({ type: 'feishu' })}
              />
            )}
            {tab === 'agents' && <AgentTab />}
            {tab === 'permissions' && <PermissionsTab />}
            {tab === 'extensions' && <ExtensionsTab onOpenBrowserSetup={() => setModal({ type: 'browser-setup' })} onOpenDesktopSetup={() => setModal({ type: 'desktop-setup' })} />}
            {tab === 'sessions' && <SessionsTab onOpenSession={handleOpenSession} />}
            {tab === 'system' && <SystemTab onOpenWorkdir={() => setModal({ type: 'workdir' })} />}
          </div>
        </main>
      </div>

      <WeixinModal open={modal?.type === 'weixin'} onClose={closeModal} />
      <TelegramModal open={modal?.type === 'telegram'} onClose={closeModal} />
      <FeishuModal open={modal?.type === 'feishu'} onClose={closeModal} />
      <BrowserSetupModal open={modal?.type === 'browser-setup'} onClose={closeModal} onSaved={() => reload()} />
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
