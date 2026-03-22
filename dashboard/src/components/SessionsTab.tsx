import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useStore } from '../store';
import { createT } from '../i18n';
import { api } from '../api';
import { Badge, Button, Card } from './ui';
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
  const title = session.title || 'Session';
  const displayState = sessionDisplayState(session);
  const detail = sessionDisplayDetail(session);
  const updatedAt = session.runUpdatedAt || session.createdAt || '';
  const stateBadge = displayState === 'running'
    ? <Badge variant="ok" className="!h-5 !px-2 !text-[10px]">{t('status.running')}</Badge>
    : displayState === 'incomplete'
      ? <Badge variant="warn" className="!h-5 !px-2 !text-[10px]">{t('sessions.incomplete')}</Badge>
      : <Badge variant="muted" className="!h-5 !px-2 !text-[10px]">{t('sessions.completed')}</Badge>;

  return (
    <Card
      onClick={onOpen}
      className={cn('cursor-pointer bg-panel-alt p-3 transition-colors duration-200 hover:border-edge-h', dimmed && 'opacity-65')}
      title={title}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-fg">{title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-5">
            {updatedAt && <span>{fmtTime(updatedAt)}</span>}
            {session.model && <span className="font-mono">{session.model}</span>}
            {session.isCurrent && <Badge variant="accent" className="!h-5 !px-2 !text-[10px]">{t('sessions.current')}</Badge>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {stateBadge}
        </div>
      </div>
      {displayState === 'incomplete' && detail && (
        <div className="mt-1.5 text-[11px] leading-relaxed text-amber-200/80">{detail}</div>
      )}
    </Card>
  );
}

function SessionCardSkeleton() {
  return (
    <div className="rounded-md border border-edge bg-panel-alt p-3">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="h-4 w-48 rounded-md bg-panel animate-shimmer" />
          <div className="mt-1.5 h-3 w-40 rounded-md bg-panel animate-shimmer" />
        </div>
        <div className="h-5 w-16 rounded-full bg-panel animate-shimmer" />
      </div>
    </div>
  );
}

function SessionsLoadingState({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }, (_, index) => (
        <SessionCardSkeleton key={index} />
      ))}
    </div>
  );
}

function AgentSessionsSection({
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
    return <div className="py-8 text-sm leading-relaxed text-fg-5">{bootstrapping ? t('sessions.loading') : t('sessions.noAgent')}</div>;
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max gap-3">
      {agents.map(agentInfo => {
        const meta = getAgentMeta(agentInfo.agent);
        const pageData = pages[agentInfo.agent];
        const sessions = pageData?.sessions || [];
        const loading = !!loadingByAgent[agentInfo.agent];
        const showInitialLoading = loading && !pageData;

        return (
          <Card key={agentInfo.agent} className="flex min-h-[420px] w-[360px] shrink-0 flex-col overflow-hidden !p-0">
            <div className="flex flex-wrap items-center gap-2.5 border-b border-edge px-3 py-2.5">
              <BrandBadge brand={agentInfo.agent} size={24} iconSize={14} className="rounded-md" />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-fg">{meta.label}</div>
                {pageData && (
                  <div className="mt-0.5 text-[11px] text-fg-5">
                    {pageData.page + 1} / {Math.max(pageData.totalPages, 1)}
                  </div>
                )}
              </div>
              <Badge variant="muted" className="!text-[11px]">
                {pageData ? pageData.total : '—'}
              </Badge>
              <div className="flex items-center gap-1.5">
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

            <div className="flex flex-1 flex-col gap-2 bg-panel-alt p-2.5">
              {showInitialLoading ? (
                <SessionsLoadingState />
              ) : pageData?.error ? (
                <div className="rounded-md border border-edge bg-panel px-2.5 py-4 text-center">
                  <div className="mb-2 text-[13px] leading-relaxed text-fg-5">{pageData.error}</div>
                  <Button size="sm" variant="ghost" onClick={() => onRetry(agentInfo.agent)}>
                    {t('sessions.retry')}
                  </Button>
                </div>
              ) : sessions.length === 0 ? (
                <div className="rounded-md border border-edge bg-panel px-2.5 py-4 text-center text-[13px] leading-relaxed text-fg-5">
                  {loading ? t('sessions.loading') : t('sessions.noSessions')}
                </div>
              ) : (
                <div className="space-y-2">
                  {sessions.map(session => (
                    <SessionCard
                      key={session.sessionId}
                      session={session}
                      dimmed={loading}
                      t={t}
                      onOpen={() => onOpenSession(agentInfo.agent, session.sessionId || '', session)}
                    />
                  ))}
                </div>
              )}
            </div>
          </Card>
        );
      })}
      </div>
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
    <div className="animate-in space-y-3">
      <AgentSessionsSection
        agents={installedAgents}
        pages={pages}
        loadingByAgent={loadingByAgent}
        bootstrapping={bootstrapping}
        onOpenSession={onOpenSession}
        onRetry={agent => { void loadAgentPage(agent, 0); }}
        onPageChange={(agent, page) => { void loadAgentPage(agent, page); }}
        t={t}
      />
    </div>
  );
}
