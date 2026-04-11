import { Suspense, lazy, useState, useEffect, useCallback, useMemo } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { useStore } from './store';
import { createT } from './i18n';
import { Sidebar } from './components/Sidebar';
import { Spinner, Toasts } from './components/ui';
import { api } from './api';
import { getDashboardTabMeta, type DashboardTab } from './tabs';
import { cn } from './utils';

const SessionsTab = lazy(async () => ({ default: (await import('./pages/sessions')).SessionWorkspace }));
const AgentTab = lazy(() => import('./pages/agents/AgentTab'));
const IMAccessTab = lazy(async () => ({ default: (await import('./pages/im/IMAccessTab')).IMAccessTab }));
const PermissionsTab = lazy(async () => ({ default: (await import('./pages/permissions/PermissionsTab')).PermissionsTab }));
const ExtensionsTab = lazy(async () => ({ default: (await import('./pages/extensions/ExtensionsTab')).ExtensionsTab }));
const SystemTab = lazy(async () => ({ default: (await import('./pages/system/SystemTab')).SystemTab }));
const TelegramModal = lazy(async () => ({ default: (await import('./components/Modals')).TelegramModal }));
const FeishuModal = lazy(async () => ({ default: (await import('./components/Modals')).FeishuModal }));
const WeixinModal = lazy(async () => ({ default: (await import('./components/Modals')).WeixinModal }));
const WorkdirModal = lazy(async () => ({ default: (await import('./components/Modals')).WorkdirModal }));
const BrowserSetupModal = lazy(async () => ({ default: (await import('./components/Modals')).BrowserSetupModal }));
const DesktopSetupModal = lazy(async () => ({ default: (await import('./components/Modals')).DesktopSetupModal }));

type ModalState =
  | null
  | { type: 'weixin' }
  | { type: 'telegram' }
  | { type: 'feishu' }
  | { type: 'workdir' }
  | { type: 'browser-setup' }
  | { type: 'desktop-setup' };

function locationToTab(pathname: string): DashboardTab {
  const map: Record<string, DashboardTab> = {
    '/': 'sessions',
    '/im': 'im',
    '/agents': 'agents',
    '/permissions': 'permissions',
    '/extensions': 'extensions',
    '/system': 'system',
  };
  return map[pathname] || 'sessions';
}

function PageWrapper({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1120px] px-5 py-3">
        <div className="mb-3 border-b border-edge pb-2">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-fg">{title}</h2>
            {description && <div className="mt-0.5 text-[13px] leading-relaxed text-fg-4">{description}</div>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-fg-4">
        <Spinner />
        Loading...
      </div>
    </div>
  );
}

export function App() {
  // Granular selectors -- each subscription triggers re-render only when its slice changes.
  // Actions (toast, reload) are stable refs and never cause re-renders.
  const state = useStore(s => s.state);
  const toasts = useStore(s => s.toasts);
  const locale = useStore(s => s.locale);
  const toast = useStore(s => s.toast);
  const reload = useStore(s => s.reload);

  const location = useLocation();
  const tab = locationToTab(location.pathname);
  const [sessionsTabReady, setSessionsTabReady] = useState(tab === 'sessions');

  const t = useMemo(() => createT(locale), [locale]);
  const [modal, setModal] = useState<ModalState>(null);
  const closeModal = useCallback(() => setModal(null), []);

  const version = state?.version || '...';

  const [prompted, setPrompted] = useState(false);
  useEffect(() => {
    if (tab === 'sessions') setSessionsTabReady(true);
  }, [tab]);

  useEffect(() => {
    if (
      state
      && !prompted
      && location.pathname !== '/'
      && !state.config.weixinBotToken
      && !state.config.telegramBotToken
      && !state.config.feishuAppId
    ) {
      setPrompted(true);
      setTimeout(() => setModal({ type: 'weixin' }), 400);
    }
  }, [state, prompted, location.pathname]);

  const [restarting, setRestarting] = useState(false);

  const handleRestart = useCallback(async () => {
    try {
      const result = await api.restart();
      if (!result.ok) {
        toast(result.error || t('modal.restartFailed'), false);
        return;
      }
      setRestarting(true);
      // Poll until the server is back (new process responds)
      let recovered = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 600));
        try {
          await api.getState();
          recovered = true;
          break;
        } catch { /* server still down */ }
      }
      if (recovered) {
        await reload();
        toast(t('modal.restartSuccess'));
      } else {
        toast(t('modal.restartFailed'), false);
      }
      setRestarting(false);
    } catch {
      toast(t('modal.restartFailed'), false);
      setRestarting(false);
    }
  }, [toast, t, reload]);

  const tabMeta = getDashboardTabMeta(tab, t);

  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const onRestartClick = useCallback(() => {
    if (restarting) return;
    if (confirmingRestart) {
      setConfirmingRestart(false);
      handleRestart();
    } else {
      setConfirmingRestart(true);
      setTimeout(() => setConfirmingRestart(false), 3000);
    }
  }, [restarting, confirmingRestart, handleRestart]);

  return (
    <div className="noise-overlay">
      <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ contain: 'strict' }}>
        <div className="grid-bg absolute inset-0 opacity-50" />
        <div className="absolute -top-36 right-0 h-[420px] w-[420px] rounded-full" style={{ background: 'radial-gradient(ellipse, var(--th-orb1), transparent 72%)', animation: 'drift 24s ease-in-out infinite', willChange: 'transform' }} />
        <div className="absolute -bottom-40 -left-20 h-[360px] w-[360px] rounded-full" style={{ background: 'radial-gradient(ellipse, var(--th-orb2), transparent 74%)', animation: 'drift 28s ease-in-out infinite reverse', willChange: 'transform' }} />
      </div>

      <div className="relative h-screen flex flex-col overflow-hidden">
        <Sidebar
          version={version}
          confirmingRestart={confirmingRestart}
          restarting={restarting}
          onRestartClick={onRestartClick}
        />

        <main className="flex-1 overflow-hidden">
          {sessionsTabReady && (
            <Suspense fallback={<RouteFallback />}>
              <div
                className={cn('h-full', tab !== 'sessions' && 'hidden')}
                aria-hidden={tab !== 'sessions'}
              >
                <SessionsTab active={tab === 'sessions'} />
              </div>
            </Suspense>
          )}

          {tab !== 'sessions' && (
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/im" element={
                  <PageWrapper title={tabMeta.title} description={tabMeta.description}>
                    <IMAccessTab
                      onOpenWeixin={() => setModal({ type: 'weixin' })}
                      onOpenTelegram={() => setModal({ type: 'telegram' })}
                      onOpenFeishu={() => setModal({ type: 'feishu' })}
                    />
                  </PageWrapper>
                } />
                <Route path="/agents" element={
                  <PageWrapper title={tabMeta.title} description={tabMeta.description}>
                    <AgentTab />
                  </PageWrapper>
                } />
                <Route path="/permissions" element={
                  <PageWrapper title={tabMeta.title} description={tabMeta.description}>
                    <PermissionsTab />
                  </PageWrapper>
                } />
                <Route path="/extensions" element={
                  <PageWrapper title={tabMeta.title} description={tabMeta.description}>
                    <ExtensionsTab onOpenBrowserSetup={() => setModal({ type: 'browser-setup' })} onOpenDesktopSetup={() => setModal({ type: 'desktop-setup' })} />
                  </PageWrapper>
                } />
                <Route path="/system" element={
                  <PageWrapper title={tabMeta.title} description={tabMeta.description}>
                    <SystemTab onOpenWorkdir={() => setModal({ type: 'workdir' })} />
                  </PageWrapper>
                } />
              </Routes>
            </Suspense>
          )}
        </main>
      </div>

      {modal && (
        <Suspense fallback={null}>
          {modal.type === 'weixin' && <WeixinModal open onClose={closeModal} />}
          {modal.type === 'telegram' && <TelegramModal open onClose={closeModal} />}
          {modal.type === 'feishu' && <FeishuModal open onClose={closeModal} />}
          {modal.type === 'browser-setup' && <BrowserSetupModal open onClose={closeModal} onSaved={() => reload()} />}
          {modal.type === 'desktop-setup' && <DesktopSetupModal open onClose={closeModal} onSaved={() => reload()} />}
          {modal.type === 'workdir' && <WorkdirModal open onClose={closeModal} />}
        </Suspense>
      )}
      <Toasts items={toasts} />
    </div>
  );
}
