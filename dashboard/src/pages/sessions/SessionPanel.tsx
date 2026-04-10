import { useState, useEffect, useLayoutEffect, useRef, useCallback, memo, useMemo } from 'react';
import { useStore } from '../../store';
import { createT } from '../../i18n';
import { api } from '../../api';
import { loadSessionMessages, peekSessionMessages } from '../../session-preload';
import { useDashboardEvent, useDashboardReconnect, type DashboardEvent } from '../../ws';
import { cn, getAgentMeta, shortenModel, sessionDisplayState } from '../../utils';
import { Spinner } from '../../components/ui';
import { hasPlan } from '../../components/PlanProgressCard';
import type { SessionInfo, StreamPlan } from '../../types';
import { TurnView, UserBubble, TurnDivider } from './TurnView';
import { LivePreview, ThinkingDots } from './LivePreview';
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

/* ── Stale-while-revalidate: persist last-known history across mount/unmount ── */
const MAX_HISTORY_SNAPSHOTS = 20;
const historySnapshots = new Map<string, TurnHistoryWindow>();
function snapshotKey(agent: string, sessionId: string) { return `${agent}:${sessionId}`; }
function saveHistorySnapshot(key: string, h: TurnHistoryWindow) {
  historySnapshots.delete(key); // refresh LRU position
  historySnapshots.set(key, h);
  while (historySnapshots.size > MAX_HISTORY_SNAPSHOTS) {
    historySnapshots.delete(historySnapshots.keys().next().value!);
  }
}

/* ═══════════════════════════════════════════════════════════════
   SessionPanel
   ═══════════════════════════════════════════════════════════════ */
export const SessionPanel = memo(function SessionPanel({
  session, workdir, active = true, onSessionChange, initialPendingPrompt, onPendingPromptConsumed,
}: {
  session: SessionInfo;
  workdir: string;
  active?: boolean;
  onSessionChange?: (next: { agent: string; sessionId: string; workdir: string }) => void;
  initialPendingPrompt?: string | null;
  onPendingPromptConsumed?: () => void;
}) {
  const locale = useStore(s => s.locale);
  const agentEffort = useStore(s => s.agentStatus?.agents?.find(a => a.agent === session.agent)?.selectedEffort ?? null);
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
  const [queuedTaskId, setQueuedTaskId] = useState<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingImageUrls, setPendingImageUrls] = useState<string[]>([]);
  const [pendingQueued, setPendingQueued] = useState(false);
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const pendingImageUrlsRef = useRef<string[]>([]);
  const liveStreamRef = useRef(liveStream);
  const streamingRef = useRef(streaming);
  liveStreamRef.current = liveStream;
  streamingRef.current = streaming;
  const scrollRef = useRef<HTMLDivElement>(null);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const scrollToBottomRef = useRef(false);
  const loadingLatestRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const localStreamPendingRef = useRef(false);
  const clearPendingOnLoadRef = useRef(false);
  const initialPendingConsumedRef = useRef(false);

  // Consume initialPendingPrompt from new-session flow — show immediately and start polling
  useEffect(() => {
    if (initialPendingConsumedRef.current || !initialPendingPrompt) return;
    initialPendingConsumedRef.current = true;
    setPendingPrompt(initialPendingPrompt);
    localStreamPendingRef.current = true;
    setStreamPollNonce(n => n + 1);
    onPendingPromptConsumed?.();
  }, [initialPendingPrompt, onPendingPromptConsumed]);

  const clearPending = useCallback(() => {
    setPendingPrompt(null);
    setPendingImageUrls(prev => { for (const u of prev) URL.revokeObjectURL(u); return []; });
    pendingImageUrlsRef.current = [];
    setPendingQueued(false);
  }, []);

  const handleSendStart = useCallback((prompt: string, imageUrls?: string[]) => {
    // Revoke any previous pending images
    for (const u of pendingImageUrlsRef.current) URL.revokeObjectURL(u);
    setPendingPrompt(prompt || null);
    const urls = imageUrls || [];
    setPendingImageUrls(urls);
    pendingImageUrlsRef.current = urls;
    // If a stream is active, the message will be queued — don't show in conversation yet
    setPendingQueued(!!liveStreamRef.current || streamingRef.current);
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
      // Clear pending in the same synchronous block as setHistory so React batches
      // both updates into a single render (avoids flash of duplicate user bubble)
      if (clearPendingOnLoadRef.current) {
        clearPendingOnLoadRef.current = false;
        clearPending();
      }
      return true;
    } finally {
      loadingLatestRef.current = false;
    }
  }, [fetchTurnWindow, clearPending]);

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

  const prevPhaseRef = useRef<'queued' | 'streaming' | 'done' | null>(null);

  /** Apply a stream snapshot to local state — called from both WS push and poll fallback.
   *  All open panels receive full updates regardless of active state. */
  const applyStreamSnapshot = useCallback((state: any | null) => {
    // Detect session promotion: backend promoted pending_XXX → native ID.
    // Navigate to the promoted session so subsequent messages use the correct ID.
    if (state?.sessionId && state.sessionId !== session.sessionId) {
      onSessionChange?.({ agent: session.agent || '', sessionId: state.sessionId, workdir });
      return;
    }
    if (!state) {
      const prev = prevPhaseRef.current;
      setLiveStream(null);
      setStreaming(false);
      if (prev === 'streaming') {
        if (stickToBottomRef.current) scrollToBottomRef.current = true;
        clearPendingOnLoadRef.current = true;
        void loadLatestTurns({ keepOlder: true, force: true });
      } else if (prev === 'done') {
        clearPending();
      } else if (prev === null && localStreamPendingRef.current) {
        // Do NOT clear pending here — for slow uploads (e.g. images via FormData),
        // the poll may return null before the stream actually starts. The pending
        // bubble should stay visible until the stream begins or the safety cleanup
        // effect fires (displayState !== 'running' && !streaming && !liveStream).
        void loadLatestTurns({ keepOlder: true, force: true });
      }
      localStreamPendingRef.current = false;
      setStreamTaskId(null);
      setStreamPhase(null);
      setQueuedTaskId(null);
      prevPhaseRef.current = null;
      return;
    }
    setStreamPhase(state.phase);
    setStreamTaskId(state.taskId || null);
    setQueuedTaskId(state.queuedTaskId || null);
    if (state.phase === 'streaming') {
      setLiveStream({
        phase: 'streaming',
        text: state.text || '',
        thinking: state.thinking || '',
        activity: state.activity,
        plan: state.plan ?? null,
      });
      setStreaming(true);
      // Queued task is now active — show its bubble in conversation
      if (!state.queuedTaskId) setPendingQueued(false);
      if (stickToBottomRef.current) scrollToBottomRef.current = true;
    } else if (state.phase === 'queued') {
      setLiveStream(null);
      setStreaming(false);
    } else if (state.phase === 'done') {
      // Clear liveStream immediately to prevent duplicate rendering with refreshed turns.
      // The pending prompt + ThinkingDots serves as a transition indicator until turns load.
      setLiveStream(null);
      setStreaming(false);
      if (prevPhaseRef.current !== 'done') {
        if (stickToBottomRef.current) scrollToBottomRef.current = true;
        if (!state.queuedTaskId) clearPendingOnLoadRef.current = true;
        void loadLatestTurns({ keepOlder: true, force: true });
      }
      if (!state.queuedTaskId) localStreamPendingRef.current = false;
    }
    prevPhaseRef.current = state.phase;
  }, [clearPending, loadLatestTurns, session.sessionId, session.agent, onSessionChange, workdir]);

  const requestStreamPolling = useCallback(() => {
    localStreamPendingRef.current = true;
    setStreamPollNonce(current => current + 1);
  }, []);

  const handleRecallTask = useCallback(async (taskId: string) => {
    try {
      await api.recallSessionMessage(taskId);
      clearPending();
      // Optimistic: clear the specific task reference so UI responds immediately
      setQueuedTaskId(prev => prev === taskId ? null : prev);
      setStreamTaskId(prev => prev === taskId ? null : prev);
    } catch {}
  }, [clearPending]);

  const handleSteerTask = useCallback(async (taskId: string) => {
    try { await api.steerSession(taskId); } catch {}
  }, []);

  const sk = snapshotKey(session.agent || '', session.sessionId);
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
    const isNewSession = !!initialPendingPrompt && !initialPendingConsumedRef.current;
    // Stale-while-revalidate: API cache → history snapshot → loading spinner
    const initialHistory = cachedLatest?.ok
      ? normalizeTurnHistory(cachedLatest)
      : historySnapshots.get(sk) || null;
    setLoading(isNewSession ? false : !initialHistory);
    setHistory(initialHistory);
    setLiveStream(null);
    setStreaming(false);
    setStreamPhase(null);
    setQueuedTaskId(null);
    stickToBottomRef.current = true;
    scrollToBottomRef.current = true;
    if (!isNewSession) {
      loadLatestTurns({ keepOlder: false, force: true }).finally(() => { if (!c) setLoading(false); });
    }
    return () => { c = true; };
  }, [loadLatestTurns, session.agent, session.sessionId, workdir, sk]);

  // Persist history snapshot for stale-while-revalidate on re-mount
  useEffect(() => {
    if (history && history.turns.length > 0) saveHistorySnapshot(sk, history);
  }, [sk, history]);

  /* ── Poll stream state — works identically across multiple tabs ── */
  useEffect(() => {
    if (!active) return;
    void loadLatestTurns({ keepOlder: true, force: true });
  }, [active, loadLatestTurns]);

  /* ── WS-driven: apply stream snapshots for ALL open panels (active or not).
     Active panels get full liveStream text; inactive panels get phase/status only. ── */
  const sessionKeyRef = useRef(`${session.agent}:${session.sessionId}`);
  sessionKeyRef.current = `${session.agent}:${session.sessionId}`;

  useDashboardEvent(
    'stream-update',
    useCallback((event: DashboardEvent) => {
      if (event.key !== sessionKeyRef.current) return;
      applyStreamSnapshot(event.snapshot ?? null);
    }, [applyStreamSnapshot]),
  );

  /* ── Initial stream-state fetch (WS handles all subsequent updates).
     Runs for ALL open panels so inactive panels know the current phase. ── */
  useEffect(() => {
    let mounted = true;
    void api.getSessionStreamState(session.agent || '', session.sessionId).then(res => {
      if (mounted) applyStreamSnapshot(res.state);
    }).catch(() => {});
    return () => { mounted = false; };
  }, [applyStreamSnapshot, session.agent, session.sessionId, streamPollNonce]);

  /* ── Refresh stream state after WS reconnect (covers missed events) ── */
  useDashboardReconnect(useCallback(() => {
    void api.getSessionStreamState(session.agent || '', session.sessionId).then(res => {
      applyStreamSnapshot(res.state);
    }).catch(() => {});
    void loadLatestTurns({ keepOlder: true, force: true });
  }, [applyStreamSnapshot, session.agent, session.sessionId, loadLatestTurns]));

  /* ── Safety: clear stale pending state when session stops running ── */
  useEffect(() => {
    if (displayState !== 'running' && !streaming && !liveStream) {
      clearPending();
      localStreamPendingRef.current = false;
    }
  }, [displayState, streaming, liveStream, clearPending]);

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

  const rawTurns = history?.turns || [];
  // When a live stream is active, the last turn's assistant response may already be
  // present in fetched history (partial or complete).  Suppress it to avoid rendering
  // the same response twice (once in TurnView, once in LivePreview).
  const turns = useMemo(() => {
    if (!liveStream || !rawTurns.length) return rawTurns;
    const last = rawTurns[rawTurns.length - 1];
    if (!last.assistant) return rawTurns;
    return [...rawTurns.slice(0, -1), { ...last, assistant: null }];
  }, [rawTurns, liveStream]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
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
              <TurnView key={`${history?.startTurn || 0}:${i}`} turn={turn} agent={session.agent || ''} meta={meta} model={session.model ? shortenModel(session.model) : undefined} effort={agentEffort} t={t}
                onResend={(txt) => {
                  scrollToBottomRef.current = true;
                  handleSendStart(txt);
                  api.sendSessionMessage(workdir, session.agent || '', session.sessionId, txt)
                    .then((res) => { if (res.ok) requestStreamPolling(); })
                    .catch(() => { clearPending(); });
                }}
                onEdit={(txt) => setEditDraft(txt)} />
            ))}
            {/* Optimistic pending message — hidden while queued behind an active stream (pendingQueued),
                and deduped against the last loaded user turn to avoid double-rendering after history refresh. */}
            {(pendingPrompt || pendingImageUrls.length > 0) && !pendingQueued
              && !clearPendingOnLoadRef.current
              && !(pendingPrompt && turns.length > 0 && turns[turns.length - 1]?.user?.text?.trim() === pendingPrompt.trim()) && (
              <div className="session-turn">
                <UserBubble text={pendingPrompt || ''} blocks={pendingImageUrls.map(u => ({ type: 'image' as const, content: u }))} t={t} />
                {!liveStream && (
                  <div className="mt-3 mb-5 animate-in">
                    <ThinkingDots className="text-fg-5" />
                  </div>
                )}
              </div>
            )}
            {/* Live stream preview */}
            {liveStream && (
              <div className="mb-6">
                {!pendingPrompt && !pendingImageUrls.length && <TurnDivider agent={session.agent || ''} meta={meta} model={session.model ? shortenModel(session.model) : undefined} effort={agentEffort} />}
                {(pendingPrompt || pendingImageUrls.length > 0) && <TurnDivider agent={session.agent || ''} meta={meta} model={session.model ? shortenModel(session.model) : undefined} effort={agentEffort} />}
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
        queuedTaskId={queuedTaskId}
        pendingPrompt={pendingPrompt}
        onRecall={handleRecallTask}
        onSteer={handleSteerTask}
        editDraft={editDraft}
        onEditDraftConsumed={() => setEditDraft(null)}
      />
    </div>
  );
});
