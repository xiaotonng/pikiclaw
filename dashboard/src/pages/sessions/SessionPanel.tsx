import { useState, useEffect, useLayoutEffect, useRef, useCallback, memo, useMemo } from 'react';
import { useStore } from '../../store';
import { createT } from '../../i18n';
import { api } from '../../api';
import { loadSessionMessages, peekSessionMessages } from '../../session-preload';
import { cn, fmtRelative, getAgentMeta, shortenModel, sessionDisplayState, shouldPollSessionStreamState } from '../../utils';
import { Dot, Spinner } from '../../components/ui';
import { BrandIcon } from '../../components/BrandIcon';
import { hasPlan } from '../../components/PlanProgressCard';
import type { SessionInfo, StreamPlan } from '../../types';
import { TurnView, UserBubble, TurnDivider } from './TurnView';
import { LivePreview } from './LivePreview';
import { InputComposer } from './InputComposer';
import {
  normalizeTurnHistory,
  mergeOlderHistory,
  mergeLatestHistory,
  type Turn,
  type TurnHistoryWindow,
} from './utils';

const SESSION_PAGE_TURNS = 12;
const TOP_LOAD_THRESHOLD_PX = 160;
const BOTTOM_STICK_THRESHOLD_PX = 96;

/* ═══════════════════════════════════════════════════════════════
   SessionPanel
   ═══════════════════════════════════════════════════════════════ */
export const SessionPanel = memo(function SessionPanel({
  session, workdir, active = true, onSessionChange,
}: {
  session: SessionInfo;
  workdir: string;
  active?: boolean;
  onSessionChange?: (next: { agent: string; sessionId: string; workdir: string }) => void;
}) {
  const locale = useStore(s => s.locale);
  const t = useMemo(() => createT(locale), [locale]);
  const meta = getAgentMeta(session.agent || '');
  const displayState = sessionDisplayState(session);

  const [history, setHistory] = useState<TurnHistoryWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [liveStream, setLiveStream] = useState<{
    phase: 'streaming' | 'done';
    text: string;
    thinking: string;
    activity?: string;
    plan?: StreamPlan | null;
  } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamPhase, setStreamPhase] = useState<string | null>(null);
  const [streamPollNonce, setStreamPollNonce] = useState(0);
  const [streamTaskId, setStreamTaskId] = useState<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingImageUrls, setPendingImageUrls] = useState<string[]>([]);
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const pendingImageUrlsRef = useRef<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const scrollToBottomRef = useRef(false);
  const loadingLatestRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const localStreamPendingRef = useRef(false);

  const clearPending = useCallback(() => {
    setPendingPrompt(null);
    setPendingImageUrls(prev => { for (const u of prev) URL.revokeObjectURL(u); return []; });
    pendingImageUrlsRef.current = [];
  }, []);

  const handleSendStart = useCallback((prompt: string, imageUrls?: string[]) => {
    // Revoke any previous pending images
    for (const u of pendingImageUrlsRef.current) URL.revokeObjectURL(u);
    setPendingPrompt(prompt || null);
    const urls = imageUrls || [];
    setPendingImageUrls(urls);
    pendingImageUrlsRef.current = urls;
  }, []);

  const fetchTurnWindow = useCallback(async (
    query: { turnOffset?: number; turnLimit?: number; lastNTurns?: number },
    opts: { force?: boolean } = {},
  ) => {
    try {
      const res = await loadSessionMessages({
        workdir,
        agent: session.agent || '',
        sessionId: session.sessionId,
        rich: true,
        turnOffset: query.turnOffset,
        turnLimit: query.turnLimit,
        lastNTurns: query.lastNTurns,
      }, { force: opts.force });
      if (!res.ok) return null;
      return normalizeTurnHistory(res);
    } catch {
      return null;
    }
  }, [workdir, session.agent, session.sessionId]);

  const loadLatestTurns = useCallback(async ({ keepOlder, force = false }: { keepOlder: boolean; force?: boolean }) => {
    if (loadingLatestRef.current) return false;
    loadingLatestRef.current = true;
    try {
      const next = await fetchTurnWindow({ turnOffset: 0, turnLimit: SESSION_PAGE_TURNS }, { force });
      if (!next) return false;
      setHistory(current => {
        if (!current || !keepOlder) return next;
        return mergeLatestHistory(current, next);
      });
      return true;
    } finally {
      loadingLatestRef.current = false;
    }
  }, [fetchTurnWindow]);

  const loadOlderTurns = useCallback(async () => {
    if (!history?.hasOlder || loadingOlderRef.current) return;
    const el = scrollRef.current;
    if (el) prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const next = await fetchTurnWindow({
        turnOffset: Math.max(0, history.totalTurns - history.startTurn),
        turnLimit: SESSION_PAGE_TURNS,
      });
      if (next) setHistory(current => current ? mergeOlderHistory(current, next) : next);
      else prependAnchorRef.current = null;
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [fetchTurnWindow, history]);

  const requestStreamPolling = useCallback(() => {
    localStreamPendingRef.current = true;
    setStreamPollNonce(current => current + 1);
  }, []);

  const handleRecallTask = useCallback(async (taskId: string) => {
    try {
      await api.recallSessionMessage(taskId);
      clearPending();
      setStreamTaskId(null);
    } catch {}
  }, [clearPending]);

  const handleSteerTask = useCallback(async (taskId: string) => {
    try { await api.steerSession(taskId); } catch {}
  }, []);

  useEffect(() => {
    let c = false;
    const cachedLatest = peekSessionMessages({
      workdir,
      agent: session.agent || '',
      sessionId: session.sessionId,
      rich: true,
      turnOffset: 0,
      turnLimit: SESSION_PAGE_TURNS,
    }, { allowStale: true });
    setLoading(true);
    setHistory(cachedLatest?.ok ? normalizeTurnHistory(cachedLatest) : null);
    setLiveStream(null);
    setStreaming(false);
    setStreamPhase(null);
    stickToBottomRef.current = true;
    scrollToBottomRef.current = true;
    if (cachedLatest?.ok) setLoading(false);
    loadLatestTurns({ keepOlder: false, force: !!cachedLatest?.ok }).finally(() => { if (!c) setLoading(false); });
    return () => { c = true; };
  }, [loadLatestTurns, session.agent, session.sessionId, workdir]);

  /* ── Poll stream state — works identically across multiple tabs ── */
  useEffect(() => {
    if (!active) return;
    void loadLatestTurns({ keepOlder: true, force: true });
  }, [active, loadLatestTurns]);

  useEffect(() => {
    if (!active) return;
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
      pollTimer = setInterval(() => { void poll(); }, 800);
    };

    const poll = async () => {
      if (!mounted) return;
      try {
        const res = await api.getSessionStreamState(session.agent || '', session.sessionId);
        if (!mounted) return;
        const state = res.state;
        const phase = state?.phase ?? null;
        const keepPolling = shouldPollSessionStreamState(displayState, localStreamPendingRef.current, phase, prevPhase);
        if (!state) {
          // No active stream — if we were streaming, stream ended externally
          if (prevPhase === 'streaming') {
            setStreaming(false);
            if (stickToBottomRef.current) scrollToBottomRef.current = true;
            void loadLatestTurns({ keepOlder: true, force: true }).then(loaded => {
              if (loaded) { clearPending(); setLiveStream(null); }
            });
          } else if (prevPhase === 'done') {
            clearPending();
            setLiveStream(null);
          }
          if (prevPhase === 'queued' || prevPhase === 'streaming' || prevPhase === 'done') {
            localStreamPendingRef.current = false;
          }
          setStreamTaskId(null);
          setStreamPhase(null);
          prevPhase = null;
          if (keepPolling) ensurePolling();
          else stopPolling();
          return;
        }
        setStreamPhase(state.phase);
        setStreamTaskId(state.phase === 'queued' ? (state.taskId || null) : null);
        if (state.phase === 'streaming') {
          setLiveStream({
            phase: 'streaming',
            text: state.text || '',
            thinking: state.thinking || '',
            activity: state.activity,
            plan: state.plan ?? null,
          });
          setStreaming(true);
          if (stickToBottomRef.current) scrollToBottomRef.current = true;
        } else if (state.phase === 'queued') {
          setLiveStream(null);
          setStreaming(false);
        } else if (state.phase === 'done') {
          setLiveStream((hasPlan(state.plan) || state.text || state.thinking || state.activity) ? {
            phase: 'done',
            text: state.text || '',
            thinking: state.thinking || '',
            activity: state.activity || '',
            plan: state.plan ?? null,
          } : null);
          setStreaming(false);
          if (prevPhase !== 'done') {
            if (stickToBottomRef.current) scrollToBottomRef.current = true;
            void loadLatestTurns({ keepOlder: true, force: true }).then(loaded => {
              if (loaded) clearPending();
              setLiveStream(null);
            });
          }
          localStreamPendingRef.current = false;
        }
        if (keepPolling) ensurePolling();
        else stopPolling();
        prevPhase = state.phase;
      } catch {
        // Network error — ignore, will retry next tick
      }
    };

    if (shouldPollSessionStreamState(displayState, localStreamPendingRef.current, null, null)) ensurePolling();
    poll(); // initial poll
    return () => {
      mounted = false;
      stopPolling();
    };
  }, [active, displayState, loadLatestTurns, session.agent, session.sessionId, streamPollNonce]);

  /* ── Fallback: poll messages for IM-triggered sessions (no stream snapshot) ── */
  useEffect(() => {
    if (!active) return;
    if (displayState !== 'running') return;
    if (streaming) return; // stream-state polling is active, no need
    const id = setInterval(() => { void loadLatestTurns({ keepOlder: true, force: true }); }, 3000);
    return () => clearInterval(id);
  }, [active, displayState, loadLatestTurns, streaming]);

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const el = scrollRef.current;
    if (!anchor || !el) return;
    prependAnchorRef.current = null;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [history?.turns.length]);

  useLayoutEffect(() => {
    if (!scrollToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    scrollToBottomRef.current = false;
    el.scrollTop = el.scrollHeight;
  }, [history?.turns.length, liveStream]);

  // Scroll to bottom when a pending prompt appears
  useLayoutEffect(() => {
    if (!pendingPrompt) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pendingPrompt]);

  useEffect(() => {
    if (!history?.hasOlder || loading || loadingOlder) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + TOP_LOAD_THRESHOLD_PX) {
      void loadOlderTurns();
    }
  }, [history?.hasOlder, history?.turns.length, loadOlderTurns, loading, loadingOlder]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = remaining <= BOTTOM_STICK_THRESHOLD_PX;
    if (el.scrollTop <= TOP_LOAD_THRESHOLD_PX) void loadOlderTurns();
  }, [loadOlderTurns]);

  const title = session.title || session.lastQuestion?.slice(0, 80) || session.sessionId.slice(0, 16);
  const turns = history?.turns || [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header ── */}
      <div className="shrink-0 flex items-center gap-2 px-4 h-10 border-b border-edge/50 bg-panel/40 backdrop-blur-md z-10">
        <BrandIcon brand={session.agent || ''} size={14} />
        <span className="text-[10px] font-medium shrink-0" style={{ color: meta.color }}>{meta.shortLabel}</span>
        <span className="flex-1 min-w-0 text-[13px] font-medium text-fg truncate">{title}</span>
        <span className="flex items-center gap-1 text-[10px] text-fg-5/60 shrink-0">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="opacity-60">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <span className="max-w-[80px] truncate">{workdir.split('/').pop()}</span>
        </span>
        {session.model && (
          <span className="text-[10px] font-mono text-fg-5/60 px-1.5 py-0.5 rounded bg-inset/40 shrink-0">{shortenModel(session.model)}</span>
        )}
        {!!session.numTurns && (
          <span className="flex items-center gap-0.5 text-[10px] text-fg-5/50 tabular-nums shrink-0">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="opacity-50">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
            {session.numTurns}
          </span>
        )}
        <Dot
          variant={displayState === 'running' ? 'ok' : displayState === 'incomplete' ? 'warn' : 'idle'}
          pulse={displayState === 'running'}
        />
        <span className="text-[10px] text-fg-5/50 tabular-nums shrink-0">
          {fmtRelative(session.runUpdatedAt || session.createdAt)}
        </span>
      </div>

      {/* ── Messages ── */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <div className="flex items-center justify-center py-20"><Spinner className="h-5 w-5 text-fg-4" /></div>
        ) : turns.length === 0 && !pendingPrompt && !pendingImageUrls.length && !liveStream ? (
          <div className="py-20 text-center text-[13px] text-fg-5">{t('hub.noMessages')}</div>
        ) : (
          <div className="max-w-[900px] mx-auto px-6 py-6 space-y-0">
            {(history?.hasOlder || loadingOlder) && (
              <div className="mb-4 flex items-center justify-center gap-2 text-[11px] text-fg-5">
                {loadingOlder ? <Spinner className="h-3 w-3 text-fg-5" /> : <span className="h-1.5 w-1.5 rounded-full bg-fg-5/35" />}
                <span>{loadingOlder ? t('hub.loadingOlderTurns') : t('hub.loadOlderTurnsHint')}</span>
              </div>
            )}
            {turns.map((turn, i) => (
              <TurnView key={`${history?.startTurn || 0}:${i}`} turn={turn} agent={session.agent || ''} meta={meta} t={t}
                onResend={(txt) => {
                  scrollToBottomRef.current = true;
                  handleSendStart(txt);
                  api.sendSessionMessage(workdir, session.agent || '', session.sessionId, txt)
                    .then((res) => { if (res.ok) requestStreamPolling(); })
                    .catch(() => { clearPending(); });
                }}
                onEdit={(txt) => setEditDraft(txt)} />
            ))}
            {/* Optimistic pending message — persists until turn history refreshes */}
            {(pendingPrompt || pendingImageUrls.length > 0) && (
              <div className="session-turn">
                <UserBubble text={pendingPrompt || ''} blocks={pendingImageUrls.map(u => ({ type: 'image' as const, content: u }))} t={t} />
                {!liveStream && (
                  <div className="flex items-center gap-1.5 justify-end mt-1 mb-5 mr-1">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute h-full w-full rounded-full bg-fg-4/30 animate-ping" />
                      <span className="relative h-2 w-2 rounded-full bg-fg-4/50" />
                    </span>
                    <span className="text-[11px] text-fg-5">{t('hub.sending')}</span>
                  </div>
                )}
              </div>
            )}
            {/* Live stream preview */}
            {liveStream && (
              <div className="mb-6">
                {!pendingPrompt && !pendingImageUrls.length && <TurnDivider agent={session.agent || ''} meta={meta} />}
                {(pendingPrompt || pendingImageUrls.length > 0) && <TurnDivider agent={session.agent || ''} meta={meta} />}
                <LivePreview stream={liveStream} t={t} />
              </div>
            )}
            <div className="h-4" />
          </div>
        )}
      </div>

      {/* ── Input ── */}
      <InputComposer
        session={session}
        workdir={workdir}
        onStreamQueued={requestStreamPolling}
        onSendStart={handleSendStart}
        onSessionChange={onSessionChange}
        t={t}
        streamPhase={streamPhase}
        streamTaskId={streamTaskId}
        onRecall={handleRecallTask}
        onSteer={handleSteerTask}
        editDraft={editDraft}
        onEditDraftConsumed={() => setEditDraft(null)}
      />
    </div>
  );
});
