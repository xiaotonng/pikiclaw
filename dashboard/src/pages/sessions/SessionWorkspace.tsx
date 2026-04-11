import { Suspense, lazy, startTransition, useDeferredValue, useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import { useStore } from '../../store';
import { createT } from '../../i18n';
import { api } from '../../api';
import { loadWorkspaceSessions, prefetchSessionMessages } from '../../session-preload';
import { useDashboardEvent, useDashboardReconnect } from '../../ws';
import {
  applyLiveSessionState,
  cn,
  fmtTime,
  fmtRelative,
  getAgentMeta,
  normalizeLiveSessionState,
  shortenModel,
  sessionDisplayState,
  sessionListContextText,
  sessionListDisplayText,
  type LiveSessionState,
} from '../../utils';
import { Dot, Spinner, Modal, ModalHeader, Button, IconPicker } from '../../components/ui';
import { BrandIcon } from '../../components/BrandIcon';
import { DirBrowser } from '../../components/DirBrowser';
import type { SessionInfo, WorkspaceEntry, DirEntry, OpenTarget } from '../../types';
import { InputComposer } from './InputComposer';
import { UserBubble } from './TurnView';
import { ThinkingDots } from './LivePreview';

let sessionPanelModulePromise: Promise<typeof import('./SessionPanel')> | null = null;

function preloadSessionPanel() {
  sessionPanelModulePromise ??= import('./SessionPanel');
  return sessionPanelModulePromise;
}

const SessionPanel = lazy(async () => ({ default: (await preloadSessionPanel()).SessionPanel }));

/* ── Constants ── */
const PAGE_SIZE = 5;
const AUTO_PREFETCH_DELAY_MS = 240;
const HOVER_PREFETCH_DELAY_MS = 120;
const SESSION_PREFETCH_TURNS = 12;
const LIVE_SESSION_STATE_MAX_AGE_MS = 15 * 60 * 1000;
const sKey = (agent: string, id: string) => `${agent}:${id}`;

let _slotKeySeq = 0;
function nextMountKey() { return `mk-${Date.now().toString(36)}-${(++_slotKeySeq).toString(36)}`; }

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
  // Multi-session window state: fixed-size slots determined by layoutMode
  // mountKey stays stable across session promotion (pending→native) so the
  // React tree keeps the panel mounted instead of remounting and losing state.
  type SessionSlot = { agent: string; sessionId: string; workdir: string; mountKey: string };
  // Layout: 1/2/3/6 visible session slots
  type LayoutMode = 1 | 2 | 3 | 6;

  // Restore workspace layout from sessionStorage (default by screen width)
  const [layoutMode, setLayoutModeRaw] = useState<LayoutMode>(() => {
    try {
      const v = sessionStorage.getItem('pikiclaw-layout-mode');
      if (v === '1' || v === '2' || v === '3' || v === '6') return Number(v) as LayoutMode;
    } catch {}
    const w = window.innerWidth;
    return w >= 1920 ? 3 : w >= 1280 ? 2 : 1;
  });
  const [openSessions, setOpenSessionsRaw] = useState<SessionSlot[]>(() => {
    try {
      const v = sessionStorage.getItem('pikiclaw-open-sessions');
      if (v) {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) return parsed.map((s: any) => ({ ...s, mountKey: s.mountKey || nextMountKey() }));
      }
    } catch {}
    return [];
  });
  const [activeSlotIndex, setActiveSlotIndexRaw] = useState(() => {
    try {
      const v = sessionStorage.getItem('pikiclaw-active-slot');
      if (v != null) { const n = Number(v); if (Number.isFinite(n) && n >= 0) return n; }
    } catch {}
    return 0;
  });

  // Persist wrappers — write to sessionStorage on every change
  const setLayoutMode = useCallback((mode: LayoutMode) => {
    setLayoutModeRaw(mode);
    try { sessionStorage.setItem('pikiclaw-layout-mode', String(mode)); } catch {}
  }, []);
  const setOpenSessions = useCallback((updater: SessionSlot[] | ((prev: SessionSlot[]) => SessionSlot[])) => {
    setOpenSessionsRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      try { sessionStorage.setItem('pikiclaw-open-sessions', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const setActiveSlotIndex = useCallback((updater: number | ((prev: number) => number)) => {
    setActiveSlotIndexRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      try { sessionStorage.setItem('pikiclaw-active-slot', String(next)); } catch {}
      return next;
    });
  }, []);

  // When layout shrinks, trim open sessions to fit
  useEffect(() => {
    setOpenSessions(prev => prev.length > layoutMode ? prev.slice(0, layoutMode) : prev);
    setActiveSlotIndex(prev => prev >= layoutMode ? layoutMode - 1 : prev);
  }, [layoutMode]);

  // Floating file-tree panel — at most one open at a time
  const [fileTreeOpen, setFileTreeOpen] = useState(false);

  // Refs so setSelectedSession stays stable and all callers see current values
  const layoutModeRef = useRef(layoutMode);
  layoutModeRef.current = layoutMode;
  const activeSlotRef = useRef(activeSlotIndex);
  activeSlotRef.current = activeSlotIndex;
  // Track which grid slot the NewSessionView occupies (updated during render IIFE)
  const newSessionSlotRef = useRef(-1);

  // Compat shim: selectedSession points to the active slot
  const selectedSession = openSessions[activeSlotIndex] ?? null;
  const setSelectedSession = useCallback((next: SessionSlot | null) => {
    if (!next) {
      setOpenSessions([]);
      setActiveSlotIndex(0);
      return;
    }
    const withKey = next.mountKey ? next : { ...next, mountKey: nextMountKey() };
    setOpenSessions(prev => {
      const existingIdx = prev.findIndex(s => s.agent === withKey.agent && s.sessionId === withKey.sessionId);
      if (existingIdx >= 0) {
        // Already open — just activate
        setActiveSlotIndex(existingIdx);
        return prev;
      }
      // Room available — fill leftmost empty slot (= end of dense array)
      if (prev.length < layoutModeRef.current) {
        const newList = [...prev, withKey];
        setActiveSlotIndex(newList.length - 1);
        return newList;
      }
      // All slots full — replace active slot (evict what user is currently viewing)
      const newList = [...prev];
      newList[activeSlotRef.current] = withKey;
      return newList;
    });
  }, []);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showNewSession, setShowNewSession] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [liveSessionStates, setLiveSessionStates] = useState<Record<string, LiveSessionState>>({});
  const deferredSearch = useDeferredValue(search);
  const initializedRef = useRef(false);
  const inflightLoadsRef = useRef<Record<string, boolean>>({});
  const sessionsMapRef = useRef(sessionsMap);
  sessionsMapRef.current = sessionsMap;
  const liveSessionStatesRef = useRef(liveSessionStates);
  liveSessionStatesRef.current = liveSessionStates;
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
        setSessionsMap(prev => {
          const incoming = res.sessions || [];
          const existing = prev[wsPath] || [];
          // Preserve optimistic stubs not yet present in API response
          const incomingIds = new Set(incoming.map(s => sKey(s.agent || '', s.sessionId)));
          const stubs = existing.filter(s => {
            if (s.runState !== 'running') return false;
            const key = sKey(s.agent || '', s.sessionId);
            if (incomingIds.has(key)) return false;
            const live = liveSessionStatesRef.current[key];
            return !(live?.resolvedKey && live.resolvedKey !== key);
          });
          return { ...prev, [wsPath]: stubs.length ? [...stubs, ...incoming] : incoming };
        });
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

  // Re-fetch workspace list + sessions when the active workdir changes (e.g. user switches directory)
  const runtimeWorkdirRef = useRef(runtimeWorkdir);
  useEffect(() => {
    if (runtimeWorkdir === runtimeWorkdirRef.current) return;
    runtimeWorkdirRef.current = runtimeWorkdir;
    if (!runtimeWorkdir || !initializedRef.current) return;
    loadWorkspaces().then(() => {
      void loadSessionsForWorkspace(runtimeWorkdir, { force: true });
    });
  }, [runtimeWorkdir, loadWorkspaces, loadSessionsForWorkspace]);

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
    if (active) void preloadSessionPanel();
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

  // SSE-driven: refresh session list when server signals a change (targeted by session key).
  // Debounce per-workspace to avoid redundant API calls on rapid phase transitions
  // (e.g. null → queued → streaming within 100ms).
  const sessionsChangedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useDashboardEvent(
    active && initializedRef.current && workspaces.length > 0 ? 'sessions-changed' : null,
    useCallback((event) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const eventKey = event.key;
      // Find workspace(s) that contain this session, or refresh all if unknown
      const targets = eventKey
        ? workspaces.filter(ws => (sessionsMapRef.current[ws.path] || []).some(s => sKey(s.agent || '', s.sessionId) === eventKey))
        : workspaces;
      // If the session isn't in any known workspace yet (new session), refresh all
      const toRefresh = targets.length ? targets : workspaces;
      const timers = sessionsChangedTimers.current;
      for (const ws of toRefresh) {
        if (timers.has(ws.path)) clearTimeout(timers.get(ws.path)!);
        timers.set(ws.path, setTimeout(() => {
          timers.delete(ws.path);
          void loadSessionsForWorkspace(ws.path, { background: true, force: true });
        }, 300));
      }
    }, [workspaces, loadSessionsForWorkspace]),
  );

  const hydrateSession = useCallback((session: SessionInfo): SessionInfo => {
    const agent = session.agent || '';
    if (!agent || !session.sessionId) return session;
    return applyLiveSessionState(session, liveSessionStates[sKey(agent, session.sessionId)] || null);
  }, [liveSessionStates]);

  useDashboardEvent(
    'stream-update',
    useCallback((event) => {
      const key = event.key;
      if (!key) return;
      setLiveSessionStates(prev => {
        const next: Record<string, LiveSessionState> = {};
        const cutoff = Date.now() - LIVE_SESSION_STATE_MAX_AGE_MS;
        for (const [entryKey, entry] of Object.entries(prev)) {
          if (entry.updatedAt >= cutoff) next[entryKey] = entry;
        }

        const live = normalizeLiveSessionState(key, event.snapshot ?? null);
        if (!live) {
          // Stream ended (null snapshot).  Don't delete the entry — keep it as
          // phase 'done' so the sidebar doesn't flash back to the stale
          // sessionsMap 'running' state before the sessions-changed API
          // refresh completes.  The 15-min TTL handles eventual cleanup.
          const prev = next[key];
          if (prev && prev.phase !== 'done') {
            next[key] = { ...prev, phase: 'done', updatedAt: Date.now() };
          }
          return next;
        }

        next[key] = live;
        if (live.resolvedKey !== key) {
          next[live.resolvedKey] = { ...live, key: live.resolvedKey };
        }
        return next;
      });
    }, []),
  );

  // Refresh all workspaces after WS reconnect (covers missed events)
  useDashboardReconnect(useCallback(() => {
    if (!active || !initializedRef.current || workspaces.length === 0) return;
    for (const ws of workspaces) {
      void loadSessionsForWorkspace(ws.path, { background: true, force: true });
    }
  }, [active, workspaces, loadSessionsForWorkspace]));

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

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const handleRemoveWorkspace = useCallback((wsPath: string) => {
    setConfirmRemove(wsPath);
  }, []);

  const executeRemoveWorkspace = useCallback(async () => {
    const wsPath = confirmRemove;
    if (!wsPath) return;
    setRemoving(true);
    try {
      await api.removeWorkspace(wsPath);
      setWorkspaces(prev => prev.filter(w => w.path !== wsPath));
      setSessionsMap(prev => { const n = { ...prev }; delete n[wsPath]; return n; });
      setOpenSessions(prev => prev.filter(s => s.workdir !== wsPath));
      setActiveSlotIndex(0);
      setConfirmRemove(null);
    } catch {}
    finally { setRemoving(false); }
  }, [confirmRemove]);

  const handleRefreshWorkspace = useCallback((wsPath: string) => {
    void loadSessionsForWorkspace(wsPath, { force: true });
  }, [loadSessionsForWorkspace]);

  /* ── New session — transition after InputComposer creates it ── */
  const [newSessionPendingPrompt, setNewSessionPendingPrompt] = useState<string | null>(null);

  const handleNewSessionCreated = useCallback((next: { agent: string; sessionId: string; workdir: string }, pendingPrompt?: string) => {
    warmSession({ agent: next.agent, sessionId: next.sessionId, runState: 'running' }, next.workdir);
    setSessionsMap(prev => {
      const existing = prev[next.workdir] || [];
      const alreadyPresent = existing.some(s => s.sessionId === next.sessionId && s.agent === next.agent);
      if (alreadyPresent) return prev;
      const stub: SessionInfo = {
        sessionId: next.sessionId,
        agent: next.agent,
        runState: 'running',
        lastQuestion: pendingPrompt,
        createdAt: new Date().toISOString(),
        runUpdatedAt: new Date().toISOString(),
      };
      return { ...prev, [next.workdir]: [stub, ...existing] };
    });
    const targetSlot = newSessionSlotRef.current;
    const slot: SessionSlot = { ...next, mountKey: nextMountKey() };
    // CRITICAL: setNewSessionPendingPrompt MUST be inside startTransition so it commits
    // atomically with the slot/active changes. If set outside, the "pending" render still
    // shows the OLD active panel which would consume the prompt before the new panel mounts.
    startTransition(() => {
      setNewSessionPendingPrompt(pendingPrompt || null);
      setShowNewSession(null);
      setOpenSessions(prev => {
        if (targetSlot >= prev.length) return [...prev, slot];
        const updated = [...prev];
        updated[targetSlot] = slot;
        return updated;
      });
      setActiveSlotIndex(targetSlot >= 0 ? targetSlot : 0);
    });
    void loadSessionsForWorkspace(next.workdir, { background: true, force: true });
  }, [loadSessionsForWorkspace, warmSession]);

  /* ── Select session — stable callback that takes wsPath ── */
  const handleSelectSession = useCallback((session: SessionInfo, workdir: string) => {
    warmSession(session, workdir);
    setShowNewSession(null);
    startTransition(() => {
      setSelectedSession({ agent: session.agent || '', sessionId: session.sessionId, workdir });
    });
  }, [warmSession]);

  const handlePanelSessionChange = useCallback((next: { agent: string; sessionId: string; workdir: string }, fromSlotIdx?: number) => {
    warmSession({ agent: next.agent, sessionId: next.sessionId, runState: 'running' }, next.workdir);
    startTransition(() => {
      if (fromSlotIdx != null) {
        // Session promotion: update sessionId but preserve mountKey so the
        // panel stays mounted and doesn't lose streaming state.
        setOpenSessions(prev => {
          if (fromSlotIdx >= prev.length) return prev;
          const updated = [...prev];
          updated[fromSlotIdx] = { ...prev[fromSlotIdx], agent: next.agent, sessionId: next.sessionId, workdir: next.workdir };
          return updated;
        });
        setActiveSlotIndex(fromSlotIdx);
      } else {
        setSelectedSession({ ...next, mountKey: nextMountKey() });
      }
    });
    void loadSessionsForWorkspace(next.workdir, { background: true, force: true });
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
      out[ws.path] = filterFn((sessionsMap[ws.path] || []).map(hydrateSession));
    }
    return out;
  }, [workspaces, sessionsMap, filterFn, hydrateSession]);

  /* ── Derived: resolve SessionInfo for each open slot ── */
  const resolveSlotInfo = useCallback((slot: SessionSlot): SessionInfo => {
    const resolved = (sessionsMap[slot.workdir] || []).find(
      s => s.sessionId === slot.sessionId && s.agent === slot.agent,
    ) ?? {
      sessionId: slot.sessionId,
      agent: slot.agent,
      runState: 'running' as const,
    };
    return hydrateSession(resolved);
  }, [hydrateSession, sessionsMap]);

  // All open session keys for sidebar highlight
  const openSessionKeys = useMemo(() => new Set(openSessions.map(s => sKey(s.agent, s.sessionId))), [openSessions]);
  const selectedKey = selectedSession ? sKey(selectedSession.agent, selectedSession.sessionId) : null;

  /* ── Close a session slot ── */
  const handleCloseSlot = useCallback((index: number) => {
    setOpenSessions(prev => {
      const next = prev.filter((_, i) => i !== index);
      // Adjust activeSlotIndex
      if (next.length === 0) {
        setActiveSlotIndex(0);
      } else if (activeSlotRef.current >= next.length) {
        setActiveSlotIndex(next.length - 1);
      }
      return next;
    });
  }, []);

  return (
    <div className="h-full overflow-hidden p-4 flex gap-3 mx-auto">
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
                isActive={ws.path === runtimeWorkdir}
                selectedKey={selectedKey}
                openSessionKeys={openSessionKeys}
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

        {/* Footer: layout toggle + add workspace */}
        <div className="shrink-0 border-t border-edge/20 px-3 py-2 space-y-1.5">
          {/* Layout mode selector: 1 / 2 / 3 / 6 slots */}
          <div className="flex items-center rounded-md bg-inset/30 border border-edge/20 p-0.5">
            {([1, 2, 3, 6] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setLayoutMode(mode)}
                className={cn(
                  'flex-1 flex items-center justify-center p-1.5 rounded transition-all',
                  layoutMode === mode ? 'bg-panel-h text-fg-2 shadow-[0_1px_2px_rgba(0,0,0,0.1)]' : 'text-fg-5/40 hover:text-fg-4',
                )}
                title={t(`hub.layout${mode}` as 'hub.layout1')}
              >
                {mode === 1 ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5" /></svg>
                ) : mode === 2 ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="2" width="6" height="12" rx="1.5" /><rect x="9" y="2" width="6" height="12" rx="1.5" /></svg>
                ) : mode === 3 ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="0.5" y="2" width="4" height="12" rx="1" /><rect x="6" y="2" width="4" height="12" rx="1" /><rect x="11.5" y="2" width="4" height="12" rx="1" /></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="0.5" y="1" width="4" height="5.5" rx="0.8" /><rect x="6" y="1" width="4" height="5.5" rx="0.8" /><rect x="11.5" y="1" width="4" height="5.5" rx="0.8" /><rect x="0.5" y="9.5" width="4" height="5.5" rx="0.8" /><rect x="6" y="9.5" width="4" height="5.5" rx="0.8" /><rect x="11.5" y="9.5" width="4" height="5.5" rx="0.8" /></svg>
                )}
              </button>
            ))}
          </div>
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

      {/* ═══ Center Panel — Grid of session slots ═══ */}
      <div
        className="flex-1 min-w-0 flex flex-col overflow-hidden gap-0"
      >
        <div
          className="flex-1 min-h-0 grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${layoutMode === 6 ? 3 : layoutMode}, 1fr)`,
            gridTemplateRows: layoutMode === 6 ? 'repeat(2, 1fr)' : '1fr',
          }}
        >
          {(() => {
            // Pick which slot the NewSessionView should occupy: prefer
            // the first empty slot so we don't cover an existing panel,
            // fall back to the active slot when all slots are full.
            const newSessionSlot = !showNewSession ? -1
              : openSessions.length < layoutMode ? openSessions.length
              : activeSlotIndex;
            newSessionSlotRef.current = newSessionSlot;
            return Array.from({ length: layoutMode }, (_, slotIdx) => {
              if (showNewSession && slotIdx === newSessionSlot) {
                return (
                  <div key={`new-${showNewSession}`} className="min-w-0 overflow-hidden rounded-xl border border-edge bg-panel flex flex-col" style={{ boxShadow: 'var(--th-card-shadow)' }}>
                    <NewSessionView
                      key={showNewSession}
                      workdir={showNewSession}
                      workspaceName={workspaces.find(ws => ws.path === showNewSession)?.name || showNewSession.split('/').pop() || ''}
                      onSessionCreated={handleNewSessionCreated}
                      onClose={() => setShowNewSession(null)}
                      t={t}
                    />
                  </div>
                );
              }
              const slot = openSessions[slotIdx] ?? null;
              if (!slot) {
                // Empty slot placeholder
                return (
                  <div
                    key={`empty-${slotIdx}`}
                    className="min-w-0 overflow-hidden rounded-xl border border-dashed border-edge/40 bg-panel/30 flex items-center justify-center"
                  >
                    <div className="text-center px-4">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="mx-auto text-fg-5/20 mb-2">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
                      </svg>
                      <div className="text-[12px] text-fg-5/40">{t('hub.emptySlot')}</div>
                    </div>
                  </div>
                );
              }
              const info = resolveSlotInfo(slot);
              const isActive = slotIdx === activeSlotIndex;
              return (
                <div
                  key={sKey(slot.agent, slot.sessionId)}
                  className={cn(
                    'min-w-0 overflow-hidden rounded-xl border bg-panel flex flex-col transition-[border-color,box-shadow] duration-200',
                    isActive
                      ? 'border-primary/40 ring-[3px] ring-primary/[0.06]'
                      : 'border-edge hover:border-edge-h',
                  )}
                  style={{ boxShadow: isActive ? 'var(--th-card-shadow), 0 0 0 1px rgba(14,165,233,0.08)' : 'var(--th-card-shadow)' }}
                  onClick={() => setActiveSlotIndex(slotIdx)}
                >
                  {/* Tab bar: [● workdir / title          created  updated  turns  📁  ×] */}
                  <div className={cn(
                    'shrink-0 flex items-center gap-2 px-2.5 h-8 border-b border-edge/30',
                    isActive ? 'bg-primary/[0.03]' : 'bg-panel/60',
                  )}>
                    {/* Left: status · workdir / title */}
                    {(() => {
                      const state = sessionDisplayState(info);
                      return <Dot variant={state === 'running' ? 'ok' : state === 'incomplete' ? 'warn' : 'idle'} pulse={state === 'running'} />;
                    })()}
                    <div className="flex-1 min-w-0 flex items-center gap-0">
                      <span className="shrink-0 text-[10px] font-medium text-fg-5">{slot.workdir.split('/').pop() || slot.workdir}</span>
                      <span className="shrink-0 text-fg-6 text-[10px] mx-1">/</span>
                      <span className="min-w-0 truncate text-[11px] font-medium text-fg-3">
                        {info.title || info.lastQuestion?.slice(0, 60) || slot.sessionId.slice(0, 12)}
                      </span>
                    </div>
                    {/* Right: meta + actions — always visible */}
                    <div className="shrink-0 flex items-center gap-2.5 pl-4 text-[9px] text-fg-5/50 tabular-nums">
                      <span title={t('hub.created')}>{fmtTime(info.createdAt)}</span>
                      {info.runUpdatedAt && <span title={t('hub.updated')}>{fmtRelative(info.runUpdatedAt)}</span>}
                      {!!info.numTurns && (
                        <span className="flex items-center gap-0.5">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="opacity-60">
                            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                          </svg>
                          {info.numTurns}
                        </span>
                      )}
                      <button
                        data-filetree-toggle
                        onClick={e => { e.stopPropagation(); setFileTreeOpen(v => !v); }}
                        className={cn(
                          'p-0.5 rounded transition-colors',
                          fileTreeOpen ? 'text-fg-3 bg-panel-h' : 'text-fg-5/40 hover:text-fg-3 hover:bg-panel-h',
                        )}
                        title={t('hub.files')}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg>
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleCloseSlot(slotIdx); }}
                        className="p-0.5 rounded text-fg-5/40 hover:text-fg-2 hover:bg-panel-h transition-colors"
                        title={t('hub.closePanel')}
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0">
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
                        key={slot.mountKey}
                        session={info}
                        workdir={slot.workdir}
                        active={active && isActive}
                        onSessionChange={(next) => handlePanelSessionChange(next, slotIdx)}
                        initialPendingPrompt={isActive ? newSessionPendingPrompt : null}
                        onPendingPromptConsumed={isActive ? () => setNewSessionPendingPrompt(null) : undefined}
                      />
                    </Suspense>
                  </div>
                </div>
              );
            });
          })()}
        </div>
      </div>

      {/* ═══ Floating File Tree ═══ */}
      {fileTreeOpen && selectedSession && (
        <FloatingFileTree
          workdir={selectedSession.workdir}
          onClose={() => setFileTreeOpen(false)}
          t={t}
        />
      )}

      {/* Add workspace modal */}
      <AddWorkspaceModal
        open={showAddDialog}
        initialPath={runtimeWorkdir || undefined}
        onAdd={handleAddWorkspace}
        onClose={() => setShowAddDialog(false)}
        t={t}
      />

      {/* Confirm remove workspace modal */}
      <Modal open={!!confirmRemove} onClose={() => !removing && setConfirmRemove(null)}>
        <ModalHeader title={t('hub.removeWorkspace')} onClose={() => !removing && setConfirmRemove(null)} />
        <div className="text-[13px] text-fg-3 leading-relaxed">
          {t('modal.confirmRemoveWorkspace')}
        </div>
        <div className="mt-1 text-[12px] text-fg-5">
          {t('modal.confirmRemoveWorkspaceHint')}
        </div>
        {confirmRemove && (
          <div className="mt-3 rounded-md bg-inset/50 border border-edge/30 px-3 py-2 font-mono text-[11px] text-fg-4 break-all">
            {confirmRemove}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setConfirmRemove(null)} disabled={removing}>{t('modal.cancel')}</Button>
          <Button variant="primary" onClick={executeRemoveWorkspace} disabled={removing}
            className="!bg-red-500/90 !border-red-500/50 hover:!bg-red-500 !text-white"
          >
            {removing ? t('modal.removing') : t('modal.remove')}
          </Button>
        </div>
      </Modal>
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
  onSessionCreated: (next: { agent: string; sessionId: string; workdir: string }, pendingPrompt?: string) => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingImageUrls, setPendingImageUrls] = useState<string[]>([]);
  const pendingRef = useRef<string | null>(null);

  const stubSession = useMemo((): SessionInfo => ({
    sessionId: '',
    agent: '',
    runState: 'completed',
  }), []);

  const noop = useCallback(() => {}, []);

  const handleSendStart = useCallback((prompt: string, imageUrls?: string[]) => {
    setPendingPrompt(prompt || null);
    pendingRef.current = prompt || null;
    setPendingImageUrls(imageUrls || []);
  }, []);

  const handleSessionCreated = useCallback((next: { agent: string; sessionId: string; workdir: string }) => {
    onSessionCreated(next, pendingRef.current || undefined);
  }, [onSessionCreated]);

  const hasPending = !!pendingPrompt || pendingImageUrls.length > 0;

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
        <Dot variant={hasPending ? 'ok' : 'idle'} pulse={hasPending} />
        {!hasPending && (
          <button
            onClick={onClose}
            className="p-1 rounded text-fg-5 hover:text-fg-2 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* ── Message area ── */}
      <div className="flex-1 overflow-y-auto">
        {hasPending ? (
          <div className="max-w-[900px] mx-auto px-6 py-6 space-y-0">
            <UserBubble text={pendingPrompt || ''} blocks={pendingImageUrls.map(u => ({ type: 'image' as const, content: u }))} t={t} />
            <div className="mt-3 mb-4 animate-in">
              <ThinkingDots className="text-fg-5" />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-1.5">
              <div className="text-[13px] text-fg-5">{t('hub.newSessionHint')}</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Input ── */}
      <InputComposer
        session={stubSession}
        workdir={workdir}
        onStreamQueued={noop}
        onSendStart={handleSendStart}
        onSessionChange={handleSessionCreated}
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
  isActive,
  selectedKey,
  openSessionKeys,
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
  isActive?: boolean;
  selectedKey: string | null;
  openSessionKeys?: Set<string>;
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
      >
        <svg
          width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={cn('shrink-0 text-fg-5 transition-transform duration-150', expanded && 'rotate-90')}
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span className={cn('flex-1 min-w-0 truncate text-[12px] font-semibold', isActive ? 'text-primary' : 'text-fg-3')}>
          {workspace.name}
        </span>
        {isActive && <Dot variant="ok" />}
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
          {!isActive && (
            <button
              onClick={e => { e.stopPropagation(); onRemove(wsPath); }}
              className="p-0.5 rounded text-fg-5 hover:text-red-400 transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
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
              {visible.map(session => {
                const sk = sKey(session.agent || '', session.sessionId);
                return (
                  <SessionCard
                    key={sk}
                    session={session}
                    isSelected={selectedKey === sk}
                    isOpen={openSessionKeys?.has(sk) ?? false}
                    onClick={() => onSelectSession(session, wsPath)}
                    onWarm={() => onWarmSession(session, wsPath)}
                    onCancelWarm={() => onCancelWarmSession(session, wsPath)}
                  />
                );
              })}
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
  isOpen,
  onClick,
  onWarm,
  onCancelWarm,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isOpen?: boolean;
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
        isSelected
          ? 'bg-selected hover:bg-selected-h'
          : isOpen
            ? 'bg-panel-h/30 hover:bg-panel-h/50'
            : 'hover:bg-panel-h/50',
      )}
      style={isOpen ? { borderLeft: `2px solid ${isSelected ? meta.color : `${meta.color}30`}`, paddingLeft: 10 } : undefined}
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
   Floating File Tree — toggled from session tab bar
   ══════════════════════════════════════════════════════ */
const FloatingFileTree = memo(function FloatingFileTree({
  workdir,
  onClose,
  t,
}: {
  workdir: string;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const hostApp = useStore(s => s.state?.hostApp ?? null);
  const platform = useStore(s => s.state?.platform ?? null);
  const toast = useStore(s => s.toast);
  const [openTarget, setOpenTarget] = useState<OpenTarget>(() => inferOpenTarget(hostApp, platform));

  const handleOpenPath = useCallback(async (targetPath: string) => {
    try {
      const res = await api.openInEditor(targetPath, openTarget);
      if (!res.ok) throw new Error(res.error || `Failed to open ${targetPath}`);
    } catch (error: any) {
      toast(error?.message || String(error), false);
    }
  }, [openTarget, toast]);

  return (
    <div
      className="fixed z-50 w-[280px] max-h-[calc(100vh-100px)] flex flex-col rounded-xl border border-edge bg-panel/95 backdrop-blur-md overflow-hidden"
      style={{
        boxShadow: '0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.12)',
        right: 16, top: 80,
      }}
    >
      {/* Title bar */}
      <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-b border-edge/30">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-fg-5">
          <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
        <span className="flex-1 text-[10px] font-semibold text-fg-4 uppercase tracking-wider">{t('hub.files')}</span>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-fg-5/40 hover:text-fg-2 transition-colors"
          title={t('hub.closePanel')}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Open target selector */}
      <div className="shrink-0 px-2.5 py-1.5 border-b border-edge/20 flex items-center gap-2">
        <IconPicker
          value={openTarget}
          options={(platform === 'darwin' ? ['vscode', 'finder'] : ['vscode']).map(v => ({
            value: v,
            label: t(targetLabelKey(v as OpenTarget)),
          }))}
          onChange={value => { if (isOpenTarget(value)) setOpenTarget(value); }}
          renderIcon={v => <OpenTargetIcon target={v as OpenTarget} size={14} />}
        />
        <Button size="sm" variant="ghost" onClick={() => handleOpenPath(workdir)} className="flex-1 min-w-0 text-[11px]">
          {t('hub.openProject')}
        </Button>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto px-1 py-1.5">
        <FileTree
          basePath={workdir}
          openTarget={openTarget}
          onOpenPath={handleOpenPath}
          t={t}
        />
      </div>
    </div>
  );
});

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
