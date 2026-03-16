import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useStore } from '../store';
import { createT } from '../i18n';
import { api } from '../api';
import { Badge, Button, Card, Dot, SectionLabel } from './ui';
import { BrandBadge } from './BrandIcon';
import { cn, fmtTime, getAgentMeta, sessionDisplayDetail, sessionDisplayState } from '../utils';
import type { AgentInfo, SessionInfo, SessionsPageResult } from '../types';

const PAGE_SIZE = 6;

function sessionErrorText(error: unknown, t: (key: string) => string): string {
  if (error instanceof Error && /timed out/i.test(error.message)) return t('modal.requestTimeout');
  return t('modal.loadFailed');
}

function SessionCard({
  session,
  onOpen,
  dimmed = false,
  t,
}: {
  session: SessionInfo;
  onOpen: () => void;
  dimmed?: boolean;
  t: (key: string) => string;
}) {
  const sid = session.sessionId || '';
  const title = session.title || sid.slice(0, 16) || 'Session';
  const truncTitle = title.length > 28 ? title.slice(0, 28) + '...' : title;
  const displayState = sessionDisplayState(session);
  const detail = sessionDisplayDetail(session);
  const dotVariant = displayState === 'running' ? 'ok' : displayState === 'incomplete' || session.isCurrent ? 'warn' : 'idle';
  const stateBadge = displayState === 'running'
    ? <Badge variant="ok" className="!h-5 !px-2 !text-[10px]">{t('status.running')}</Badge>
    : displayState === 'incomplete'
      ? <Badge variant="warn" className="!h-5 !px-2 !text-[10px]">{t('sessions.incomplete')}</Badge>
      : <Badge variant="muted" className="!h-5 !px-2 !text-[10px]">{t('sessions.completed')}</Badge>;

  return (
    <Card
      onClick={onOpen}
      interactive
      className={cn('mb-2 bg-panel-alt p-4 last:mb-0 transition-all duration-200', dimmed && 'opacity-65')}
      title={title}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex-1 truncate text-[14px] font-medium text-fg-2">{truncTitle}</div>
        <Dot variant={dotVariant} pulse={session.running} />
      </div>
      <div className="flex flex-wrap items-center gap-2.5 text-[12px] text-fg-5">
        <span>{fmtTime(session.createdAt)}</span>
        {session.model && <span className="font-mono">{session.model}</span>}
        {session.isCurrent && <Badge variant="accent" className="!h-5 !px-2 !text-[10px]">{t('sessions.current')}</Badge>}
        {stateBadge}
      </div>
      {displayState === 'incomplete' && detail && (
        <div className="mt-1 truncate text-[11px] text-amber-200/80">{detail}</div>
      )}
      <div className="mt-1.5 truncate text-[11px] font-mono text-fg-6">{sid}</div>
    </Card>
  );
}

function SessionCardSkeleton() {
  return (
    <div className="mb-2 rounded-xl border border-edge bg-panel-alt p-4 last:mb-0">
      <div className="mb-2 flex items-center gap-2">
        <div className="h-4 flex-1 rounded-md bg-panel animate-shimmer" />
        <div className="h-2 w-2 rounded-full bg-fg-5" />
      </div>
      <div className="mb-2 flex gap-2">
        <div className="h-3 w-20 rounded-md bg-panel animate-shimmer" />
        <div className="h-3 w-24 rounded-md bg-panel animate-shimmer" />
      </div>
      <div className="h-3 w-40 rounded-md bg-panel animate-shimmer" />
    </div>
  );
}

function SessionsLoadingState({ count = 3 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, index) => (
        <SessionCardSkeleton key={index} />
      ))}
    </div>
  );
}

function SwimLanes({
  agents,
  pages,
  loadingByAgent,
  bootstrapping,
  onOpenSession,
  onRetry,
  onPageChange,
  t,
}: {
  agents: AgentInfo[];
  pages: Record<string, SessionsPageResult>;
  loadingByAgent: Record<string, boolean>;
  bootstrapping: boolean;
  onOpenSession: (agent: string, sid: string, ses: SessionInfo) => void;
  onRetry: (agent: string) => void;
  onPageChange: (agent: string, page: number) => void;
  t: (key: string) => string;
}) {
  if (!agents.length) {
    return <div className="py-8 text-[15px] text-fg-5">{bootstrapping ? t('sessions.loading') : t('sessions.noAgent')}</div>;
  }

  return (
    <div className="flex gap-5 overflow-x-auto pb-2" style={{ minHeight: 200 }}>
      {agents.map(agentInfo => {
        const meta = getAgentMeta(agentInfo.agent);
        const pageData = pages[agentInfo.agent];
        const sessions = pageData?.sessions || [];
        const loading = !!loadingByAgent[agentInfo.agent];
        const total = pageData?.total ?? 0;
        const showInitialLoading = loading && !pageData;

        return (
          <div key={agentInfo.agent} className="flex min-w-[280px] max-w-[360px] flex-1 flex-col">
            <Card className="flex flex-1 flex-col overflow-hidden !p-0">
              <div className="flex items-center gap-2.5 border-b border-edge px-4 py-3.5 text-[15px] font-semibold text-fg-2">
                <BrandBadge brand={agentInfo.agent} size={24} iconSize={14} className="rounded-md" />
                <span>{meta.label}</span>
                <Badge variant="muted" className="ml-auto !text-[11px]">{total}</Badge>
              </div>

              <div className="flex-1 bg-panel-alt p-2.5">
                {loading && pageData && <div className="mb-2 h-1.5 rounded-full bg-panel animate-shimmer" />}
                <div className="max-h-[56vh] overflow-y-auto">
                  {showInitialLoading ? (
                    <SessionsLoadingState />
                  ) : pageData?.error ? (
                    <div className="px-3 py-6 text-center">
                      <div className="mb-3 text-[13px] text-fg-5">{pageData.error}</div>
                      <Button size="sm" variant="ghost" onClick={() => onRetry(agentInfo.agent)}>
                        {t('sessions.retry')}
                      </Button>
                    </div>
                  ) : sessions.length === 0 ? (
                    <div className="py-6 text-center text-[14px] text-fg-5">
                      {loading ? t('sessions.loading') : t('sessions.noSessions')}
                    </div>
                  ) : (
                    sessions.map(session => (
                      <SessionCard
                        key={session.sessionId}
                        session={session}
                        dimmed={loading}
                        t={t}
                        onOpen={() => onOpenSession(agentInfo.agent, session.sessionId || '', session)}
                      />
                    ))
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 border-t border-edge px-3 py-2">
                <div className="text-[11px] font-mono text-fg-5">
                  {pageData ? `${pageData.page + 1} / ${Math.max(pageData.totalPages, 1)}` : t('sessions.loading')}
                </div>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!pageData || loading || pageData.page <= 0}
                    onClick={() => onPageChange(agentInfo.agent, Math.max((pageData?.page || 0) - 1, 0))}
                  >
                    {t('sessions.prev')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!pageData || loading || pageData.page + 1 >= pageData.totalPages}
                    onClick={() => onPageChange(agentInfo.agent, (pageData?.page || 0) + 1)}
                  >
                    {t('sessions.next')}
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        );
      })}
    </div>
  );
}

function installedAgentsFromState(state: { setupState?: { agents?: AgentInfo[] | null } | null } | null | undefined): AgentInfo[] {
  return (state?.setupState?.agents || []).filter((agent): agent is AgentInfo => !!agent?.installed);
}

export function SessionsTab({ onOpenSession }: { onOpenSession: (agent: string, sid: string, ses: SessionInfo) => void }) {
  const { state, reload, locale } = useStore();
  const t = createT(locale);
  const [pages, setPages] = useState<Record<string, SessionsPageResult>>({});
  const [loadingByAgent, setLoadingByAgent] = useState<Record<string, boolean>>({});
  const [bootstrapping, setBootstrapping] = useState(false);
  const requestSeqRef = useRef<Record<string, number>>({});
  const hydratedAgentsKeyRef = useRef<string | null>(null);

  const installedAgents = installedAgentsFromState(state);
  const installedAgentsKey = installedAgents.map(agent => agent.agent).join(',');

  const loadAgentPage = useEffectEvent(async (agent: string, page: number) => {
    const seq = (requestSeqRef.current[agent] ?? 0) + 1;
    requestSeqRef.current[agent] = seq;
    setLoadingByAgent(prev => ({ ...prev, [agent]: true }));

    try {
      const result = await api.getSessionsPage(agent, page, PAGE_SIZE, { timeoutMs: 20_000 });
      if (requestSeqRef.current[agent] !== seq) return;
      startTransition(() => {
        setPages(prev => ({ ...prev, [agent]: result }));
      });
    } catch (error) {
      if (requestSeqRef.current[agent] !== seq) return;
      const errorText = sessionErrorText(error, t);
      startTransition(() => {
        setPages(prev => ({
          ...prev,
          [agent]: {
            ok: false,
            sessions: [],
            error: errorText,
            page,
            limit: PAGE_SIZE,
            total: 0,
            totalPages: 1,
            hasMore: false,
          },
        }));
      });
    } finally {
      if (requestSeqRef.current[agent] === seq) {
        setLoadingByAgent(prev => ({ ...prev, [agent]: false }));
      }
    }
  });

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      const latestState = state ?? await reload();
      if (cancelled) return;

      const agents = installedAgentsFromState(latestState);
      const nextKey = agents.map(agent => agent.agent).join(',');
      if (nextKey === hydratedAgentsKeyRef.current) return;
      hydratedAgentsKeyRef.current = nextKey;

      if (!agents.length) {
        startTransition(() => setPages({}));
        setBootstrapping(false);
        return;
      }

      setBootstrapping(true);
      await Promise.all(agents.map(agent => loadAgentPage(agent.agent, 0)));
      if (!cancelled) setBootstrapping(false);
    };

    void hydrate();
    return () => { cancelled = true; };
  }, [installedAgentsKey, reload, state]);

  return (
    <div className="animate-in space-y-8">
      <section>
        <SectionLabel>{t('sessions.agentSessions')}</SectionLabel>
        <SwimLanes
          agents={installedAgents}
          pages={pages}
          loadingByAgent={loadingByAgent}
          bootstrapping={bootstrapping}
          onOpenSession={onOpenSession}
          onRetry={agent => { void loadAgentPage(agent, 0); }}
          onPageChange={(agent, page) => { void loadAgentPage(agent, page); }}
          t={t}
        />
      </section>
    </div>
  );
}
