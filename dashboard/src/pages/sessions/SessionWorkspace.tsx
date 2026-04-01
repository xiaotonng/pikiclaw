import { Suspense, lazy, startTransition, useDeferredValue, useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import { useStore } from '../../store';
import { createT } from '../../i18n';
import { api } from '../../api';
import { loadWorkspaceSessions, prefetchSessionMessages } from '../../session-preload';
import { cn, fmtRelative, getAgentMeta, shortenModel, sessionDisplayState, shouldPollSessionStreamState, sessionListContextText, sessionListDisplayText } from '../../utils';
import { Badge, Dot, Spinner, Modal, ModalHeader, Button, IconPicker } from '../../components/ui';
import { BrandIcon } from '../../components/BrandIcon';
import { DirBrowser } from '../../components/DirBrowser';
import { PlanProgressCard, hasPlan } from '../../components/PlanProgressCard';
import type { SessionInfo, WorkspaceEntry, DirEntry, StreamPlan, OpenTarget } from '../../types';
import { InputComposer } from './InputComposer';

let sessionPanelModulePromise: Promise<typeof import('./SessionPanel')> | null = null;

function preloadSessionPanel() {
  sessionPanelModulePromise ??= import('./SessionPanel');
  return sessionPanelModulePromise;
}

const SessionPanel = lazy(async () => ({ default: (await preloadSessionPanel()).SessionPanel }));

/* ── Constants ── */
const PAGE_SIZE = 5;
const SIDEBAR_POLL_MS = 5_000;
const AUTO_PREFETCH_DELAY_MS = 240;
const HOVER_PREFETCH_DELAY_MS = 120;
const SESSION_PREFETCH_TURNS = 12;
const sKey = (agent: string, id: string) => `${agent}:${id}`;

type FilterMode = 'all' | 'running' | 'review';

function isOpenTarget(value: string | null | undefined): value is OpenTarget {
  return value === 'vscode'
    || value === 'cursor'
    || value === 'windsurf'
    || value === 'finder'
    || value === 'default';
}

function inferOpenTarget(hostApp: string | null, platform: string | null): OpenTarget {
  const normalized = String(hostApp || '').toLowerCase();
  if (normalized.includes('cursor')) return 'cursor';
  if (normalized.includes('windsurf')) return 'windsurf';
  if (normalized.includes('code')) return 'vscode';
  return platform === 'darwin' ? 'vscode' : 'default';
}

function targetLabelKey(target: OpenTarget) {
  switch (target) {
    case 'cursor': return 'hub.openTargetCursor';
    case 'windsurf': return 'hub.openTargetWindsurf';
    case 'finder': return 'hub.openTargetFinder';
    case 'default': return 'hub.openTargetDefault';
    case 'vscode':
    default:
      return 'hub.openTargetVsCode';
  }
}

/* ══════════════════════════════════════════════════════
   Main Three-Column Layout
   ══════════════════════════════════════════════════════ */
export const SessionWorkspace = memo(function SessionWorkspace({
  active = true,
}: {
  active?: boolean;
}) {
  // Granular selectors — only re-render when locale or runtimeWorkdir changes.
  // Store-level changes (toasts, host, tab, theme) do NOT trigger re-render here.
  const locale = useStore(s => s.locale);
  const runtimeWorkdir = useStore(s => s.state?.runtimeWorkdir ?? null);
  const t = useMemo(() => createT(locale), [locale]);

  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [sessionsMap, setSessionsMap] = useState<Record<string, SessionInfo[]>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [sidebarLoading, setSidebarLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState<{ agent: string; sessionId: string; workdir: string } | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showNewSession, setShowNewSession] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const deferredSearch = useDeferredValue(search);
  const initializedRef = useRef(false);
  const inflightLoadsRef = useRef<Record<string, boolean>>({});
  const autoPrefetchedSessionsRef = useRef<Set<string>>(new Set());
  const hoverPrefetchTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => () => {
    for (const timer of Object.values(hoverPrefetchTimersRef.current)) {
      clearTimeout(timer);
    }
  }, []);

  /* ── Load workspaces (API already includes runtimeWorkdir) ── */
  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await api.getWorkspaces();
      const list = res.ok ? res.workspaces : [];
      if (list.length) setWorkspaces(list);
      initializedRef.current = true;
    } catch {
      initializedRef.current = true;
    } finally {
      setSidebarLoading(false);
    }
  }, []);

  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

  /* ── Load sessions for a workspace ── */
  const loadSessionsForWorkspace = useCallback(async (
    wsPath: string,
    opts: { background?: boolean; force?: boolean } = {},
  ) => {
    if (inflightLoadsRef.current[wsPath]) return;
    inflightLoadsRef.current[wsPath] = true;
    if (!opts.background) {
      setLoadingMap(prev => ({ ...prev, [wsPath]: true }));
    }
    try {
      const res = await loadWorkspaceSessions(wsPath, { force: opts.force });
      startTransition(() => {
        setSessionsMap(prev => ({ ...prev, [wsPath]: res.sessions || [] }));
      });
    } catch {
      if (!opts.background) {
        startTransition(() => {
          setSessionsMap(prev => ({ ...prev, [wsPath]: [] }));
        });
      }
    } finally {
      inflightLoadsRef.current[wsPath] = false;
      if (!opts.background) {
        setLoadingMap(prev => ({ ...prev, [wsPath]: false }));
      }
    }
  }, []);

  const warmSession = useCallback((session: SessionInfo, workdir: string) => {
    const agent = session.agent || '';
    if (!agent || !session.sessionId) return;
    void preloadSessionPanel();
    prefetchSessionMessages({
      workdir,
      agent,
      sessionId: session.sessionId,
      rich: true,
      turnOffset: 0,
      turnLimit: SESSION_PREFETCH_TURNS,
    });
  }, []);

  const scheduleSessionWarmup = useCallback((session: SessionInfo, workdir: string, delayMs = HOVER_PREFETCH_DELAY_MS) => {
    const key = `${workdir}:${sKey(session.agent || '', session.sessionId)}`;
    const existing = hoverPrefetchTimersRef.current[key];
    if (existing) clearTimeout(existing);
    hoverPrefetchTimersRef.current[key] = setTimeout(() => {
      delete hoverPrefetchTimersRef.current[key];
      warmSession(session, workdir);
    }, delayMs);
  }, [warmSession]);

  const cancelScheduledWarmup = useCallback((session: SessionInfo, workdir: string) => {
    const key = `${workdir}:${sKey(session.agent || '', session.sessionId)}`;
    const existing = hoverPrefetchTimersRef.current[key];
    if (!existing) return;
    clearTimeout(existing);
    delete hoverPrefetchTimersRef.current[key];
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      void preloadSessionPanel();
    }, AUTO_PREFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    workspaces.forEach((ws, index) => {
      if (sessionsMap[ws.path] || loadingMap[ws.path]) return;
      const timer = setTimeout(() => {
        void loadSessionsForWorkspace(ws.path);
      }, index * 90);
      timers.push(timer);
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [active, loadSessionsForWorkspace, loadingMap, sessionsMap, workspaces]);

  useEffect(() => {
    if (!active || !initializedRef.current || workspaces.length === 0) return;
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      for (const ws of workspaces) {
        void loadSessionsForWorkspace(ws.path, { background: true, force: true });
      }
    };
    const id = setInterval(tick, SIDEBAR_POLL_MS);
    return () => clearInterval(id);
  }, [active, workspaces, loadSessionsForWorkspace]);

  useEffect(() => {
    if (!active || !initializedRef.current || workspaces.length === 0) return;

    const refreshVisibleWorkspaces = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      for (const ws of workspaces) {
        void loadSessionsForWorkspace(ws.path, { background: true, force: true });
      }
    };

    refreshVisibleWorkspaces();

    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const handleVisible = () => {
      if (document.visibilityState !== 'visible') return;
      refreshVisibleWorkspaces();
    };

    document.addEventListener('visibilitychange', handleVisible);
    window.addEventListener('focus', handleVisible);
    return () => {
      document.removeEventListener('visibilitychange', handleVisible);
      window.removeEventListener('focus', handleVisible);
    };
  }, [active, loadSessionsForWorkspace, workspaces]);

  useEffect(() => {
    if (!active) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    workspaces.forEach((ws, index) => {
      const candidate = (sessionsMap[ws.path] || [])[0];
      if (!candidate) return;
      const key = `${ws.path}:${sKey(candidate.agent || '', candidate.sessionId)}`;
      if (autoPrefetchedSessionsRef.current.has(key)) return;
      const timer = setTimeout(() => {
        autoPrefetchedSessionsRef.current.add(key);
        warmSession(candidate, ws.path);
      }, AUTO_PREFETCH_DELAY_MS + index * 120);
      timers.push(timer);
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [active, sessionsMap, warmSession, workspaces]);

  /* ── Add / remove workspace — stable callbacks ── */
  const handleAddWorkspace = useCallback(async (wsPath: string) => {
    try {
      const res = await api.addWorkspace(wsPath);
      if (res.ok) { setShowAddDialog(false); await loadWorkspaces(); loadSessionsForWorkspace(wsPath); }
    } catch {}
  }, [loadWorkspaces, loadSessionsForWorkspace]);

  const handleRemoveWorkspace = useCallback(async (wsPath: string) => {
    try {
      await api.removeWorkspace(wsPath);
      setWorkspaces(prev => prev.filter(w => w.path !== wsPath));
      setSessionsMap(prev => { const n = { ...prev }; delete n[wsPath]; return n; });
      setSelectedSession(prev => prev?.workdir === wsPath ? null : prev);
    } catch {}
  }, []);

  const handleRefreshWorkspace = useCallback((wsPath: string) => {
    void loadSessionsForWorkspace(wsPath, { force: true });
  }, [loadSessionsForWorkspace]);

  /* ── New session — transition after InputComposer creates it ── */
  const handleNewSessionCreated = useCallback((next: { agent: string; sessionId: string; workdir: string }) => {
    warmSession({ agent: next.agent, sessionId: next.sessionId, runState: 'running' }, next.workdir);
    setShowNewSession(null);
    startTransition(() => {
      setSelectedSession(next);
    });
    void loadSessionsForWorkspace(next.workdir, { force: true });
  }, [loadSessionsForWorkspace, warmSession]);

  /* ── Select session — stable callback that takes wsPath ── */
  const handleSelectSession = useCallback((session: SessionInfo, workdir: string) => {
    warmSession(session, workdir);
    setShowNewSession(null);
    startTransition(() => {
      setSelectedSession({ agent: session.agent || '', sessionId: session.sessionId, workdir });
    });
  }, [warmSession]);

  const handlePanelSessionChange = useCallback((next: { agent: string; sessionId: string; workdir: string }) => {
    warmSession({ agent: next.agent, sessionId: next.sessionId, runState: 'completed' }, next.workdir);
    startTransition(() => {
      setSelectedSession(next);
    });
    void loadSessionsForWorkspace(next.workdir, { force: true });
  }, [loadSessionsForWorkspace, warmSession]);

  /* ── Filter sessions — memoized per workspace to avoid new-array-on-every-render ── */
  const filterFn = useCallback((sessions: SessionInfo[]): SessionInfo[] => {
    let result = sessions;
    if (filter === 'running') result = result.filter(s => sessionDisplayState(s) === 'running');
    else if (filter === 'review') result = result.filter(s => sessionDisplayState(s) === 'incomplete');
    if (deferredSearch.trim()) {
      const q = deferredSearch.toLowerCase();
      result = result.filter(s =>
        (s.lastMessageText || '').toLowerCase().includes(q)
        || (s.lastQuestion || '').toLowerCase().includes(q)
        || (s.lastAnswer || '').toLowerCase().includes(q)
        || (s.title || '').toLowerCase().includes(q)
        || (s.agent || '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [deferredSearch, filter]);

  const filteredByWs = useMemo(() => {
    const out: Record<string, SessionInfo[]> = {};
    for (const ws of workspaces) {
      out[ws.path] = filterFn(sessionsMap[ws.path] || []);
    }
    return out;
  }, [workspaces, sessionsMap, filterFn]);

  /* ── Derived: selected session info ── */
  const selectedSessionInfo = useMemo((): SessionInfo | null => {
    if (!selectedSession) return null;
    return (sessionsMap[selectedSession.workdir] || []).find(
      s => s.sessionId === selectedSession.sessionId && s.agent === selectedSession.agent,
    ) ?? {
      // Fallback: session selected but not yet in sessionsMap (e.g. just created).
      // SessionPanel handles missing fields gracefully; real data replaces this
      // once loadSessionsForWorkspace completes.
      sessionId: selectedSession.sessionId,
      agent: selectedSession.agent,
      runState: 'running' as const,
    };
  }, [selectedSession, sessionsMap]);

  const selectedKey = selectedSession ? sKey(selectedSession.agent, selectedSession.sessionId) : null;

  return (
    <div className="h-full overflow-hidden p-4 flex gap-3 mx-auto max-w-[1680px]">
      {/* ═══ Left Panel — Session Navigator ═══ */}
      <div className="panel-isolated w-[252px] shrink-0 flex flex-col overflow-hidden rounded-xl border border-edge bg-panel backdrop-blur-sm" style={{ boxShadow: 'var(--th-card-shadow)' }}>
        {/* Search + Filter */}
        <div className="px-3 pt-3 pb-2 space-y-2">
          <div className="relative group">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-5/40 group-focus-within:text-fg-4 transition-colors">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('hub.search')}
              className="w-full rounded-lg border border-edge/40 bg-inset/50 pl-8 pr-7 py-1.5 text-[12px] text-fg outline-none placeholder:text-fg-5/30 focus:border-primary/30 focus:bg-inset focus:shadow-[0_0_0_3px_rgba(99,102,241,0.06)] transition-all duration-200"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-fg-5/30 hover:text-fg-4 transition-colors"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex items-center rounded-lg bg-inset/30 border border-edge/20 p-0.5">
            {(['all', 'running', 'review'] as FilterMode[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'flex-1 px-2 py-[5px] rounded-md text-[11px] font-medium transition-all duration-200',
                  filter === f
                    ? 'bg-panel-h text-fg-2 shadow-[0_1px_2px_rgba(0,0,0,0.1),inset_0_1px_0_rgba(255,255,255,0.04)]'
                    : 'text-fg-5/60 hover:text-fg-4',
                )}
              >
                {t(`hub.filter${f[0].toUpperCase() + f.slice(1)}` as 'hub.filterAll')}
              </button>
            ))}
          </div>
        </div>

        {/* Workspace list */}
        <div className="flex-1 overflow-y-auto">
          {sidebarLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner className="h-4 w-4 text-fg-5" />
            </div>
          ) : workspaces.length === 0 && !showAddDialog ? (
            <div className="py-12 text-center text-[13px] text-fg-5">{t('hub.noWorkspaces')}</div>
          ) : (
            workspaces.map(ws => (
              <WorkspaceGroup
                key={ws.path}
                workspace={ws}
                sessions={filteredByWs[ws.path] || []}
                loading={!!loadingMap[ws.path] || !(ws.path in sessionsMap)}
                selectedKey={selectedKey}
                onSelectSession={handleSelectSession}
                onNewSession={setShowNewSession}
                onRefresh={handleRefreshWorkspace}
                onRemove={handleRemoveWorkspace}
                onWarmSession={scheduleSessionWarmup}
                onCancelWarmSession={cancelScheduledWarmup}
                t={t}
              />
            ))
          )}
        </div>

        {/* Footer actions */}
        <div className="shrink-0 px-3 py-2 border-t border-edge/20">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAddDialog(v => !v)}
            className="w-full"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t('hub.addWorkspace')}
          </Button>
        </div>
      </div>

      {/* ═══ Center Panel — Conversation ═══ */}
      <div className="panel-scroll-safe flex-1 min-w-0 overflow-hidden rounded-xl border border-edge bg-panel" style={{ boxShadow: 'var(--th-card-shadow)' }}>
        {showNewSession ? (
          <NewSessionView
            key={showNewSession}
            workdir={showNewSession}
            workspaceName={workspaces.find(ws => ws.path === showNewSession)?.name || showNewSession.split('/').pop() || ''}
            onSessionCreated={handleNewSessionCreated}
            onClose={() => setShowNewSession(null)}
            t={t}
          />
        ) : !selectedSession ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="text-[14px] text-fg-4">{t('hub.selectSession')}</div>
              <div className="mt-1 text-[12px] text-fg-5">{t('hub.selectSessionHint')}</div>
            </div>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <div className="flex items-center gap-2 text-sm text-fg-4">
                  <Spinner />
                  Loading session...
                </div>
              </div>
            }
          >
            <SessionPanel
              key={sKey(selectedSession.agent, selectedSession.sessionId)}
              session={selectedSessionInfo!}
              workdir={selectedSession.workdir}
              active={active}
              onSessionChange={handlePanelSessionChange}
            />
          </Suspense>
        )}
      </div>

      {/* ═══ Right Panel — Auxiliary ═══ */}
      <RightPanel
        session={showNewSession ? undefined : selectedSessionInfo}
        workdir={selectedSession?.workdir || ''}
        active={active}
        t={t}
      />

      {/* Add workspace modal */}
      <AddWorkspaceModal
        open={showAddDialog}
        initialPath={runtimeWorkdir || undefined}
        onAdd={handleAddWorkspace}
        onClose={() => setShowAddDialog(false)}
        t={t}
      />
    </div>
  );
});

/* ══════════════════════════════════════════════════════
   Add Workspace Modal — DirBrowser in a modal dialog
   ══════════════════════════════════════════════════════ */
function AddWorkspaceModal({
  open,
  initialPath,
  onAdd,
  onClose,
  t,
}: {
  open: boolean;
  initialPath?: string;
  onAdd: (path: string) => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const [selectedPath, setSelectedPath] = useState('');
  const handleSelect = useCallback((path: string) => setSelectedPath(path), []);

  useEffect(() => {
    if (open) setSelectedPath('');
  }, [open]);

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHeader title={t('hub.addWorkspace')} onClose={onClose} />
      <DirBrowser
        initialPath={initialPath}
        maxHeight={360}
        minHeight={200}
        onSelect={handleSelect}
        t={t}
      />
      <div className="flex gap-2 mt-4">
        <Button
          disabled={!selectedPath}
          onClick={() => selectedPath && onAdd(selectedPath)}
          className="flex-1"
        >
          {t('hub.add')}
        </Button>
        <Button variant="secondary" onClick={onClose} className="flex-1">
          {t('hub.cancel')}
        </Button>
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════
   New Session View — empty chat + InputComposer
   Looks identical to a regular session: header, empty
   message area, and the standard input bar at the bottom.
   ══════════════════════════════════════════════════════ */
function NewSessionView({
  workdir,
  workspaceName,
  onSessionCreated,
  onClose,
  t,
}: {
  workdir: string;
  workspaceName: string;
  onSessionCreated: (next: { agent: string; sessionId: string; workdir: string }) => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const stubSession = useMemo((): SessionInfo => ({
    sessionId: '',
    agent: '',
    runState: 'completed',
  }), []);

  const noop = useCallback(() => {}, []);
  const noopSend = useCallback((_prompt: string, _imageUrls?: string[]) => {}, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header ── */}
      <div className="shrink-0 flex items-center gap-2 px-4 h-10 border-b border-edge/50 bg-panel/40 backdrop-blur-md z-10">
        <span className="flex-1 min-w-0 text-[13px] font-medium text-fg truncate">{t('hub.newSession')}</span>
        <span className="flex items-center gap-1 text-[10px] text-fg-5/60 shrink-0">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="opacity-60">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <span className="max-w-[80px] truncate">{workspaceName}</span>
        </span>
        <Dot variant="idle" />
        <button
          onClick={onClose}
          className="p-1 rounded text-fg-5 hover:text-fg-2 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* ── Empty message area ── */}
      <div className="flex-1 overflow-y-auto flex items-center justify-center">
        <div className="text-center space-y-1.5">
          <div className="text-[13px] text-fg-5">{t('hub.newSessionHint')}</div>
        </div>
      </div>

      {/* ── Input ── */}
      <InputComposer
        session={stubSession}
        workdir={workdir}
        onStreamQueued={noop}
        onSendStart={noopSend}
        onSessionChange={onSessionCreated}
        t={t}
        streamPhase={null}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Workspace Group — collapsible, paginated (5 per page)
   Callbacks now take wsPath as a parameter so parent can
   pass stable function refs instead of inline closures.
   ══════════════════════════════════════════════════════ */
const WorkspaceGroup = memo(function WorkspaceGroup({
  workspace,
  sessions,
  loading,
  selectedKey,
  onSelectSession,
  onNewSession,
  onRefresh,
  onRemove,
  onWarmSession,
  onCancelWarmSession,
  t,
}: {
  workspace: WorkspaceEntry;
  sessions: SessionInfo[];
  loading: boolean;
  selectedKey: string | null;
  onSelectSession: (s: SessionInfo, wsPath: string) => void;
  onNewSession: (wsPath: string) => void;
  onRefresh: (wsPath: string) => void;
  onRemove: (wsPath: string) => void;
  onWarmSession: (s: SessionInfo, wsPath: string) => void;
  onCancelWarmSession: (s: SessionInfo, wsPath: string) => void;
  t: (key: string) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [hovered, setHovered] = useState(false);

  // Reset pagination when sessions change
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [sessions.length]);

  const visible = sessions.slice(0, visibleCount);
  const remaining = sessions.length - visibleCount;

  const wsPath = workspace.path;

  return (
    <div className="border-b border-edge/30">
      {/* Workspace header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-panel-h/50 transition-colors"
        onClick={() => setExpanded(v => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <svg
          width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={cn('shrink-0 text-fg-5 transition-transform duration-150', expanded && 'rotate-90')}
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span className="flex-1 min-w-0 truncate text-[12px] font-semibold text-fg-3">{workspace.name}</span>
        <span className="shrink-0 text-[10px] text-fg-5 tabular-nums">
          {loading ? '' : `(${sessions.length})`}
        </span>
        {hovered && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={e => { e.stopPropagation(); onNewSession(wsPath); }}
              className="p-0.5 rounded text-fg-5 hover:text-primary transition-colors"
              title={t('hub.newSession')}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              onClick={e => { e.stopPropagation(); onRefresh(wsPath); }}
              className="p-0.5 rounded text-fg-5 hover:text-fg-2 transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            <button
              onClick={e => { e.stopPropagation(); onRemove(wsPath); }}
              className="p-0.5 rounded text-fg-5 hover:text-red-400 transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Sessions */}
      {expanded && (
        <div className="pb-1">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Spinner className="h-3 w-3 text-fg-5" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="py-3 text-center text-[11px] text-fg-5">{t('sessions.noSessions')}</div>
          ) : (
            <>
              {visible.map(session => (
                <SessionCard
                  key={sKey(session.agent || '', session.sessionId)}
                  session={session}
                  isSelected={selectedKey === sKey(session.agent || '', session.sessionId)}
                  onClick={() => onSelectSession(session, wsPath)}
                  onWarm={() => onWarmSession(session, wsPath)}
                  onCancelWarm={() => onCancelWarmSession(session, wsPath)}
                />
              ))}
              {remaining > 0 && (
                <button
                  onClick={() => setVisibleCount(v => v + PAGE_SIZE)}
                  className="flex items-center gap-1.5 w-full px-3 py-1.5 text-[11px] text-fg-5 hover:text-fg-3 hover:bg-panel-h/50 transition-colors"
                >
                  <span>+ {t('hub.nMore').replace('{n}', String(remaining))}</span>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

/* ══════════════════════════════════════════════════════
   Session Card — 3 lines: agent+time, question, status dot
   ══════════════════════════════════════════════════════ */
const SessionCard = memo(function SessionCard({
  session,
  isSelected,
  onClick,
  onWarm,
  onCancelWarm,
}: {
  session: SessionInfo;
  isSelected: boolean;
  onClick: () => void;
  onWarm: () => void;
  onCancelWarm: () => void;
}) {
  const meta = getAgentMeta(session.agent || '');
  const displayState = sessionDisplayState(session);
  const displayText = sessionListDisplayText(session).slice(0, 500) || session.sessionId.slice(0, 16);
  const contextText = sessionListContextText(session, displayText).slice(0, 500);
  const modelShort = session.model ? shortenModel(session.model) : null;

  return (
    <button
      onClick={onClick}
      onMouseEnter={onWarm}
      onFocus={onWarm}
      onMouseLeave={onCancelWarm}
      onBlur={onCancelWarm}
      className={cn(
        'w-full px-3 py-2 text-left transition-all duration-100',
        'hover:bg-panel-h/60',
        isSelected && 'bg-panel-h/80',
      )}
      style={isSelected ? { borderLeft: `2px solid ${meta.color}`, paddingLeft: 10 } : undefined}
    >
      {/* Row 1: agent + model + turns + time */}
      <div className="flex items-center gap-1.5 text-[10px] text-fg-5">
        <BrandIcon brand={session.agent || ''} size={10} />
        <span className="font-medium shrink-0" style={{ color: meta.color }}>{meta.shortLabel}</span>
        {modelShort && (
          <span className="truncate max-w-[72px] font-mono text-fg-5/40 text-[9px]">{modelShort}</span>
        )}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {!!session.numTurns && (
            <span className="flex items-center gap-0.5 text-fg-5/50 tabular-nums">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="opacity-50">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              {session.numTurns}
            </span>
          )}
          <span className="tabular-nums">{fmtRelative(session.runUpdatedAt || session.createdAt)}</span>
        </div>
      </div>
      {/* Row 2: status dot + title */}
      <div className="mt-1 flex items-center gap-1.5">
        <Dot
          variant={displayState === 'running' ? 'ok' : displayState === 'incomplete' ? 'warn' : 'idle'}
          pulse={displayState === 'running'}
        />
        <span className="truncate text-[12px] leading-snug text-fg-2">{displayText}</span>
      </div>
      {contextText && (
        <div className="mt-0.5 pl-[11px]">
          <span className="block truncate text-[10px] leading-snug text-fg-5">{contextText}</span>
        </div>
      )}
    </button>
  );
});

/* ══════════════════════════════════════════════════════
   Right Panel — Cross-agent result / actions / artifacts
   ══════════════════════════════════════════════════════ */

type HubUserStatus = 'inbox' | 'active' | 'review' | 'done' | 'parked';
type HubOutcome = 'answer' | 'proposal' | 'implementation' | 'partial' | 'blocked' | 'conversation';


function titleCaseKey(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function resolveSessionStatus(session: SessionInfo): HubUserStatus {
  if (session.userStatus) return session.userStatus;
  switch (session.classification?.outcome) {
    case 'answer':
      return 'done';
    case 'partial':
      return 'active';
    case 'proposal':
    case 'implementation':
    case 'blocked':
    case 'conversation':
      return 'review';
    default:
      return 'inbox';
  }
}

function statusVariant(status: HubUserStatus): 'ok' | 'warn' | 'err' | 'muted' | 'accent' {
  switch (status) {
    case 'done':
      return 'ok';
    case 'review':
      return 'warn';
    case 'active':
      return 'accent';
    case 'parked':
    case 'inbox':
    default:
      return 'muted';
  }
}

function outcomeVariant(outcome: HubOutcome): 'ok' | 'warn' | 'err' | 'muted' | 'accent' {
  switch (outcome) {
    case 'blocked':
      return 'err';
    case 'partial':
      return 'warn';
    case 'implementation':
    case 'proposal':
      return 'accent';
    case 'answer':
      return 'ok';
    case 'conversation':
    default:
      return 'muted';
  }
}

function sessionSummaryText(session: SessionInfo, t: (key: string) => string): string {
  const summary = session.classification?.summary?.trim();
  if (summary) return summary;
  const answer = session.lastAnswer?.split('\n').find(line => line.trim())?.trim();
  if (answer) return answer.length > 180 ? answer.slice(0, 177) + '...' : answer;
  const detail = session.runDetail?.trim();
  if (detail) return detail;
  return t('hub.noSummary');
}

function sessionNextActionText(session: SessionInfo, displayState: 'running' | 'completed' | 'incomplete', t: (key: string) => string): string {
  const explicit = session.classification?.suggestedNextAction?.trim();
  if (explicit) return explicit;
  if (displayState === 'incomplete') return t('hub.continueTask');
  return t('hub.noNextAction');
}

const RightPanel = memo(function RightPanel({
  session,
  workdir,
  active,
  t,
}: {
  session: SessionInfo | null | undefined;
  workdir: string;
  active: boolean;
  t: (key: string) => string;
}) {
  const hostApp = useStore(s => s.state?.hostApp ?? null);
  const platform = useStore(s => s.state?.platform ?? null);
  const toast = useStore(s => s.toast);
  const displayState = session ? sessionDisplayState(session) : 'completed';
  const sessionAgent = session?.agent || '';
  const sessionId = session?.sessionId || '';
  const [openTarget, setOpenTarget] = useState<OpenTarget>('vscode');
  const [filesOpen, setFilesOpen] = useState(true);
  const [streamState, setStreamState] = useState<{
    phase: 'queued' | 'streaming' | 'done';
    activity?: string;
    thinking?: string;
    plan?: StreamPlan | null;
  } | null>(null);
  const openTargetTouchedRef = useRef(false);

  useEffect(() => {
    setOpenTarget(prev => {
      if (prev === 'finder' && platform !== 'darwin') return inferOpenTarget(hostApp, platform);
      if (openTargetTouchedRef.current) return prev;
      const next = inferOpenTarget(hostApp, platform);
      return prev === next ? prev : next;
    });
  }, [hostApp, platform]);

  useEffect(() => {
    if (!active || !session) {
      setStreamState(null);
      return;
    }
    let mounted = true;
    let prevPhase: 'queued' | 'streaming' | 'done' | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
    };

    const ensurePolling = () => {
      if (pollTimer) return;
      pollTimer = setInterval(() => { void poll(); }, 1200);
    };

    const poll = async () => {
      try {
        const res = await api.getSessionStreamState(session.agent || '', session.sessionId);
        if (!mounted) return;
        const phase = res.state?.phase ?? null;
        setStreamState(res.state ? {
          phase: res.state.phase,
          activity: res.state.activity,
          thinking: res.state.thinking,
          plan: res.state.plan ?? null,
        } : null);
        const keepPolling = shouldPollSessionStreamState(displayState, false, phase, prevPhase);
        if (keepPolling) ensurePolling();
        else stopPolling();
        prevPhase = phase;
      } catch {}
    };
    void poll();
    if (shouldPollSessionStreamState(displayState, false, null, null)) ensurePolling();
    return () => {
      mounted = false;
      stopPolling();
    };
  }, [active, displayState, session, sessionAgent, sessionId]);

  const openTargetOptions = (platform === 'darwin'
    ? ['vscode', 'finder']
    : ['vscode']
  ).map((value) => ({ value, label: t(targetLabelKey(value as OpenTarget)) }));

  const handleOpenPath = useCallback(async (targetPath: string) => {
    try {
      const res = await api.openInEditor(targetPath, openTarget);
      if (!res.ok) throw new Error(res.error || `Failed to open ${targetPath}`);
    } catch (error: any) {
      toast(error?.message || String(error), false);
    }
  }, [openTarget, toast]);


  if (!session || !workdir) {
    return (
      <div className="panel-isolated w-[252px] shrink-0 flex flex-col overflow-hidden rounded-xl border border-edge bg-panel backdrop-blur-sm" style={{ boxShadow: 'var(--th-card-shadow)' }}>
        <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-fg-5">{t('hub.selectSessionHint')}</div>
      </div>
    );
  }

  const resolvedStatus = resolveSessionStatus(session);
  const outcome = session.classification?.outcome || null;
  const summaryText = sessionSummaryText(session, t);
  const nextActionText = sessionNextActionText(session, displayState, t);
  const liveLabel = streamState?.activity?.trim() || (streamState?.thinking ? t('hub.thinkingLive') : '');
  const livePlan = hasPlan(streamState?.plan) ? streamState.plan : null;
  const artifactBasePath = session.workspacePath || workdir;
  const hasWorkspace = !!session.workspacePath;
  const linkedCount = session.linkedSessions?.length || 0;

  return (
    <div className="panel-isolated w-[252px] shrink-0 flex flex-col overflow-hidden rounded-xl border border-edge bg-panel backdrop-blur-sm" style={{ boxShadow: 'var(--th-card-shadow)' }}>
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="text-[12px] font-semibold text-fg-3">{t('hub.result')}</div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
        <div className="rounded-lg border border-edge/50 bg-panel-alt/40 px-3 py-3 space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={statusVariant(resolvedStatus)}>
              {t(`hub.status${titleCaseKey(resolvedStatus)}` as 'hub.statusDone')}
            </Badge>
            {outcome && (
              <Badge variant={outcomeVariant(outcome)}>
                {t(`hub.outcome${titleCaseKey(outcome)}` as 'hub.outcomeAnswer')}
              </Badge>
            )}
            {displayState === 'running' && <Badge variant="accent">{t('hub.live')}</Badge>}
          </div>

          <InfoBlock label={t('hub.summary')} content={summaryText} />
          <InfoBlock label={t('hub.nextAction')} content={nextActionText} muted={nextActionText === t('hub.noNextAction')} />

          {livePlan && (
            <PlanProgressCard
              plan={livePlan}
              phase={streamState?.phase ?? null}
              t={t}
              compact
            />
          )}

          {liveLabel && (
            <div className="rounded-md border border-ok/15 bg-ok/[0.06] px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="h-[6px] w-[6px] rounded-full bg-ok animate-pulse shrink-0" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ok">{t('hub.live')}</span>
              </div>
              <div className="mt-1 pl-[14px] text-[11px] text-fg-4 font-mono break-words">{liveLabel}</div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <MetaStat label={t('hub.lastUpdated')} value={fmtRelative(session.runUpdatedAt || session.createdAt)} />
            <MetaStat label={t('hub.turns')} value={session.numTurns ? String(session.numTurns) : '—'} />
            <MetaStat label={t('hub.workspace')} value={hasWorkspace ? t('hub.artifacts') : t('hub.projectFiles')} />
            <MetaStat label={t('hub.linked')} value={linkedCount ? String(linkedCount) : '—'} />
          </div>
        </div>

        <div className="px-2 flex items-center gap-2">
          <IconPicker
            value={openTarget}
            options={openTargetOptions}
            onChange={value => {
              if (!isOpenTarget(value)) return;
              openTargetTouchedRef.current = true;
              setOpenTarget(value);
            }}
            renderIcon={v => <OpenTargetIcon target={v as OpenTarget} size={18} />}
          />
          <Button size="sm" variant="outline" onClick={() => handleOpenPath(workdir)} className="flex-1 min-w-0">
            {t('hub.openProject')}
          </Button>
        </div>

        <SectionHeader
          title={hasWorkspace ? t('hub.artifacts') : t('hub.projectFiles')}
          open={filesOpen}
          onToggle={() => setFilesOpen(v => !v)}
        />
        {filesOpen && (
          artifactBasePath ? (
            <div className="space-y-2">
              <div className="rounded-lg border border-edge/40 bg-panel-alt/20 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-5">
                  {hasWorkspace ? t('hub.workspacePath') : t('hub.projectPath')}
                </div>
                <div className="mt-1 break-all font-mono text-[10px] leading-[1.5] text-fg-4">{artifactBasePath}</div>
                {!hasWorkspace && <div className="mt-1 text-[10px] leading-[1.5] text-fg-5">{t('hub.projectFilesHint')}</div>}
              </div>
              <FileTree basePath={artifactBasePath} includeHidden={hasWorkspace} openTarget={openTarget} onOpenPath={handleOpenPath} t={t} />
            </div>
          ) : (
            <div className="py-3 text-center text-[11px] text-fg-5">{t('hub.noFiles')}</div>
          )
        )}
      </div>
    </div>
  );
});

function InfoBlock({ label, content, muted }: { label: string; content: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-5">{label}</div>
      <div className={cn('mt-1 text-[12px] leading-[1.6] text-fg-2', muted && 'text-fg-5')}>{content}</div>
    </div>
  );
}

function MetaStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-edge/30 bg-panel/40 px-2 py-1.5">
      <div className="text-[10px] text-fg-5">{label}</div>
      <div className="mt-0.5 text-[11px] font-medium text-fg-2">{value}</div>
    </div>
  );
}

function OpenTargetIcon({ target, size = 16 }: { target: OpenTarget; size?: number; subtle?: boolean }) {
  if (target === 'default') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0 text-fg-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />
        <path d="M9 2h5v5" />
        <path d="M14 2L7 9" />
      </svg>
    );
  }
  return <BrandIcon brand={target} size={size} />;
}

/* ── Section Header (collapsible) ── */
function SectionHeader({ title, badge, open, onToggle }: {
  title: string; badge?: number; open: boolean; onToggle: () => void;
}) {
  return (
    <button onClick={onToggle} className="flex items-center gap-1.5 w-full px-1 pt-2.5 pb-1">
      <svg
        width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        className={cn('shrink-0 text-fg-5/50 transition-transform duration-150', open && 'rotate-90')}
      >
        <polyline points="9 6 15 12 9 18" />
      </svg>
      <span className="text-[10px] font-semibold text-fg-5 uppercase tracking-wider">{title}</span>
      {badge != null && badge > 0 && (
        <span className="ml-auto text-[9px] font-medium text-fg-5 bg-panel-h rounded-full px-1.5 py-0.5 tabular-nums">{badge}</span>
      )}
    </button>
  );
}

/* ── Lazy-loading File Tree ── */
interface TreeNode {
  entry: DirEntry;
  expanded: boolean;
  children: TreeNode[] | null;
  loading: boolean;
}

function FileTree({
  basePath,
  includeHidden = false,
  openTarget,
  onOpenPath,
  t,
}: {
  basePath: string;
  includeHidden?: boolean;
  openTarget: OpenTarget;
  onOpenPath: (path: string) => void;
  t: (key: string) => string;
}) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [rootLoading, setRootLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setRootLoading(true);
    api.lsDir(basePath, true, includeHidden)
      .then(res => {
        if (!cancelled && res.ok) {
          setNodes(res.dirs.slice(0, 50).map(e => ({ entry: e, expanded: false, children: null, loading: false })));
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setRootLoading(false); });
    return () => { cancelled = true; };
  }, [basePath, includeHidden]);

  const toggleDir = useCallback((targetPath: string) => {
    const toggle = (list: TreeNode[]): TreeNode[] =>
      list.map(n => {
        if (n.entry.path === targetPath) {
          if (n.expanded) return { ...n, expanded: false };
          if (n.children === null) {
            api.lsDir(targetPath, true, includeHidden)
              .then(res => {
                if (res.ok) {
                  setNodes(prev => updateNode(prev, targetPath, {
                    children: res.dirs.slice(0, 50).map(e => ({ entry: e, expanded: false, children: null, loading: false })),
                    loading: false,
                  }));
                }
              })
              .catch(() => {
                setNodes(prev => updateNode(prev, targetPath, { children: [], loading: false }));
              });
            return { ...n, loading: true, expanded: true };
          }
          return { ...n, expanded: true };
        }
        if (n.children) return { ...n, children: toggle(n.children) };
        return n;
      });
    setNodes(prev => toggle(prev));
  }, [includeHidden]);

  if (rootLoading) return <div className="flex justify-center py-3"><Spinner className="h-3 w-3 text-fg-5" /></div>;
  if (nodes.length === 0) return <div className="py-3 text-center text-[11px] text-fg-5">—</div>;
  return <div className="space-y-px"><TreeLevel nodes={nodes} depth={0} onToggle={toggleDir} openTarget={openTarget} onOpenPath={onOpenPath} t={t} /></div>;
}

function TreeLevel({ nodes, depth, onToggle, openTarget, onOpenPath, t }: {
  nodes: TreeNode[];
  depth: number;
  onToggle: (path: string) => void;
  openTarget: OpenTarget;
  onOpenPath: (path: string) => void;
  t: (key: string) => string;
}) {
  return <>{nodes.map(node => <TreeItem key={node.entry.path} node={node} depth={depth} onToggle={onToggle} openTarget={openTarget} onOpenPath={onOpenPath} t={t} />)}</>;
}

function TreeItem({ node, depth, onToggle, openTarget, onOpenPath, t }: {
  node: TreeNode;
  depth: number;
  onToggle: (path: string) => void;
  openTarget: OpenTarget;
  onOpenPath: (path: string) => void;
  t: (key: string) => string;
}) {
  const { entry, expanded, children, loading } = node;
  const indent = depth * 14;
  const [hovered, setHovered] = useState(false);
  const openTargetLabel = t(targetLabelKey(openTarget));
  const openTitle = t('hub.openWithTarget').replace('{target}', openTargetLabel);

  return (
    <>
      <div
        onClick={entry.isDir ? () => onToggle(entry.path) : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          'flex items-center gap-1.5 py-1 rounded text-[11px] text-fg-3 transition-colors',
          entry.isDir ? 'hover:bg-panel-h/50 cursor-pointer' : 'hover:bg-panel-h/50 cursor-default',
        )}
        style={{ paddingLeft: 8 + indent, paddingRight: 8 }}
      >
        {entry.isDir ? (
          loading ? <Spinner className="h-2 w-2 text-fg-5 shrink-0" /> : (
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={cn('shrink-0 text-fg-5/40 transition-transform duration-150', expanded && 'rotate-90')}>
              <polyline points="9 6 15 12 9 18" />
            </svg>
          )
        ) : <span className="w-2 shrink-0" />}

        {entry.isDir ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" className="shrink-0 text-blue-400/70">
            <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" fill="currentColor" opacity="0.25" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-fg-5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" />
          </svg>
        )}

        <span className="truncate flex-1">{entry.name}</span>

        {hovered && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={e => { e.stopPropagation(); onOpenPath(entry.path); }}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-fg-5 hover:text-blue-400 transition-colors"
              title={openTitle}
            >
              <OpenTargetIcon target={openTarget} subtle />
            </button>
            {!entry.isDir && <CopyPathButton filePath={entry.path} t={t} />}
          </div>
        )}
      </div>
      {entry.isDir && expanded && children && children.length > 0 && (
        <TreeLevel nodes={children} depth={depth + 1} onToggle={onToggle} openTarget={openTarget} onOpenPath={onOpenPath} t={t} />
      )}
    </>
  );
}

function CopyPathButton({ filePath, t }: { filePath: string; t: (key: string) => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(filePath).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
      className={cn('p-0.5 rounded transition-colors', copied ? 'text-ok' : 'text-fg-5 hover:text-fg-3')}
      title={t('hub.copied')}
    >
      {copied
        ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
        : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
      }
    </button>
  );
}

/* ── Helper: update a node deep in the tree by path ── */
function updateNode(nodes: TreeNode[], targetPath: string, patch: Partial<TreeNode>): TreeNode[] {
  return nodes.map(n => {
    if (n.entry.path === targetPath) return { ...n, ...patch };
    if (n.children) return { ...n, children: updateNode(n.children, targetPath, patch) };
    return n;
  });
}
