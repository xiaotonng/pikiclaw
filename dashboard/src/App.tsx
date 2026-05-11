import { Suspense, lazy, useState, useEffect, useCallback, useMemo } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { useStore } from './store';
import { createT } from './i18n';
import { Sidebar, type RestartPhase } from './components/Sidebar';
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
const SlackModal = lazy(async () => ({ default: (await import('./components/Modals')).SlackModal }));
const DiscordModal = lazy(async () => ({ default: (await import('./components/Modals')).DiscordModal }));
const DingtalkModal = lazy(async () => ({ default: (await import('./components/Modals')).DingtalkModal }));
const WeComModal = lazy(async () => ({ default: (await import('./components/Modals')).WeComModal }));
const WorkdirModal = lazy(async () => ({ default: (await import('./components/Modals')).WorkdirModal }));
const BrowserSetupModal = lazy(async () => ({ default: (await import('./components/Modals')).BrowserSetupModal }));

type ModalState =
  | null
  | { type: 'weixin' }
  | { type: 'telegram' }
  | { type: 'feishu' }
  | { type: 'slack' }
  | { type: 'discord' }
  | { type: 'dingtalk' }
  | { type: 'wecom' }
  | { type: 'workdir' }
  | { type: 'browser-setup' };

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
      && !state.config.slackBotToken
      && !state.config.discordBotToken
      && !state.config.dingtalkClientId
      && !state.config.wecomBotId
    ) {
      setPrompted(true);
      setTimeout(() => setModal({ type: 'weixin' }), 400);
    }
  }, [state, prompted, location.pathname]);

  // Restart: phase-based overlay
  const [restartPhase, setRestartPhase] = useState<RestartPhase>(null);

  const onRestartClick = useCallback(() => {
    if (restartPhase === 'restarting' || restartPhase === 'reconnecting') return;
    if (restartPhase === 'confirm') {
      // Confirmed — fire restart
      setRestartPhase('restarting');
      (async () => {
        try {
          const result = await api.restart();
          if (!result.ok) {
            toast(result.error || t('modal.restartFailed'), false);
            setRestartPhase(null);
            return;
          }
          setRestartPhase('reconnecting');
          let recovered = false;
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 600));
            try { await api.getState(); recovered = true; break; } catch {}
          }
          if (recovered) {
            await reload();
            toast(t('modal.restartSuccess'));
          } else {
            toast(t('modal.restartFailed'), false);
          }
        } catch {
          toast(t('modal.restartFailed'), false);
        }
        setRestartPhase(null);
      })();
    } else {
      setRestartPhase('confirm');
      setTimeout(() => setRestartPhase(p => (p === 'confirm' ? null : p)), 3000);
    }
  }, [restartPhase, toast, t, reload]);

  const tabMeta = getDashboardTabMeta(tab, t);

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
          restartPhase={restartPhase}
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
                      onOpenSlack={() => setModal({ type: 'slack' })}
                      onOpenDiscord={() => setModal({ type: 'discord' })}
                      onOpenDingtalk={() => setModal({ type: 'dingtalk' })}
                      onOpenWeCom={() => setModal({ type: 'wecom' })}
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
                    <ExtensionsTab onOpenBrowserSetup={() => setModal({ type: 'browser-setup' })} />
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
          {modal.type === 'slack' && <SlackModal open onClose={closeModal} />}
          {modal.type === 'discord' && <DiscordModal open onClose={closeModal} />}
          {modal.type === 'dingtalk' && <DingtalkModal open onClose={closeModal} />}
          {modal.type === 'wecom' && <WeComModal open onClose={closeModal} />}
          {modal.type === 'browser-setup' && <BrowserSetupModal open onClose={closeModal} onSaved={() => reload()} />}
          {modal.type === 'workdir' && <WorkdirModal open onClose={closeModal} />}
        </Suspense>
      )}
      <Toasts items={toasts} />

      {/* Full-page restart overlay */}
      {(restartPhase === 'restarting' || restartPhase === 'reconnecting') && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--th-bg)]/80 backdrop-blur-sm animate-in">
          <div className="flex flex-col items-center gap-4">
            <div className="relative h-10 w-10">
              <svg
                width="40" height="40" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
                className="animate-spin text-fg-2" style={{ animationDuration: '1.2s' }}
              >
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </div>
            <span className="text-sm font-medium text-fg-3">
              {restartPhase === 'restarting' ? t('modal.restarting') : t('modal.reconnecting')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
