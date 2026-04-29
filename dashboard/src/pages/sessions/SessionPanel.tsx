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
  session, workdir, active = true, onSessionChange, initialPendingPrompt, initialPendingImageUrls, onPendingPromptConsumed,
}: {
  session: SessionInfo;
  workdir: string;
  active?: boolean;
  onSessionChange?: (next: { agent: string; sessionId: string; workdir: string }) => void;
  initialPendingPrompt?: string | null;
  /** Blob-URL previews for images attached to the first message of a new session.
   *  Ownership transfers to this panel: we revoke them once the turn completes. */
  initialPendingImageUrls?: string[];
  onPendingPromptConsumed?: () => void;
}) {
  const locale = useStore(s => s.locale);
  const globalEffort = useStore(s => s.agentStatus?.agents?.find(a => a.agent === session.agent)?.selectedEffort ?? null);
  const agentEffort = session.thinkingEffort || globalEffort;
  const t = useMemo(() => createT(locale), [locale]);
  const meta = getAgentMeta(session.agent || '');
  const displayState = sessionDisplayState(session);

  const hasInitialPending = !!initialPendingPrompt || !!(initialPendingImageUrls && initialPendingImageUrls.length);
  const [history, setHistory] = useState<TurnHistoryWindow | null>(null);
  const [loading, setLoading] = useState(!hasInitialPending);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [liveStream, setLiveStream] = useState<{
    taskId: string | null;
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
  const [queuedTaskIds, setQueuedTaskIds] = useState<string[]>([]);
  const [queuedTasks, setQueuedTasks] = useState<Array<{ taskId: string; prompt: string }>>([]);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(initialPendingPrompt || null);
  const [pendingImageUrls, setPendingImageUrls] = useState<string[]>(initialPendingImageUrls || []);
  const [pendingQueued, setPendingQueued] = useState(false);
  // The taskId backing pendingPrompt — needed because steer can promote a
  // queued task to streaming while OTHER tasks remain queued (so the
  // "no more queued" heuristic for clearing pendingQueued is wrong on its own).
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const pendingTaskIdRef = useRef<string | null>(null);
  pendingTaskIdRef.current = pendingTaskId;
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const pendingImageUrlsRef = useRef<string[]>(initialPendingImageUrls || []);
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
  const localStreamPendingRef = useRef(hasInitialPending);
  const clearPendingOnLoadRef = useRef(false);
  // When a task ends, we wait for loadLatestTurns to commit its final text to
  // history before clearing liveStream. We remember which task triggered the
  // clear so that if a new task has already started streaming into liveStream
  // by the time history arrives, we don't accidentally wipe the new task's
  // preview. `true` = no specific task (used for non-handoff shutdown paths).
  const clearLiveStreamOnLoadRef = useRef<{ taskId: string | null } | true | false>(false);
  const initialPendingConsumedRef = useRef(false);
  const promotingRef = useRef(false);

  // Consume initialPendingPrompt/initialPendingImageUrls from new-session flow.
  // State (pendingPrompt, pendingImageUrls, loading, localStreamPendingRef) is already initialized
  // from the props so the very first render shows the user message — no spinner flash.
  // This effect only triggers the remaining side effects (polling + parent notify).
  useEffect(() => {
    if (initialPendingConsumedRef.current || !hasInitialPending) return;
    initialPendingConsumedRef.current = true;
    setStreamPollNonce(n => n + 1);
    onPendingPromptConsumed?.();
  }, [hasInitialPending, onPendingPromptConsumed]);

  const clearPending = useCallback(() => {
    setPendingPrompt(null);
    setPendingImageUrls(prev => { for (const u of prev) URL.revokeObjectURL(u); return []; });
    pendingImageUrlsRef.current = [];
    setPendingQueued(false);
    setPendingTaskId(null);
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
    // pendingTaskId resolves async via onSendTaskAssigned once the API returns.
    setPendingTaskId(null);
  }, []);

  const handleSendTaskAssigned = useCallback((taskId: string) => {
    setPendingTaskId(taskId);
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

  const loadLatestTurns = useCallback(async ({ keepOlder, force = false, scrollToBottom = false }: { keepOlder: boolean; force?: boolean; scrollToBottom?: boolean }) => {
    if (loadingLatestRef.current) return false;
    loadingLatestRef.current = true;
    try {
      const next = await fetchTurnWindow({ turnOffset: 0, turnLimit: SESSION_PAGE_TURNS }, { force });
      if (!next) return false;
      // Set scroll flag right before setHistory so React batches both into
      // the same render and the layoutEffect sees the flag when turns update.
      if (scrollToBottom) scrollToBottomRef.current = true;
      setHistory(current => {
        if (!current || !keepOlder) return next;
        return mergeLatestHistory(current, next);
      });
      // Clear pending + liveStream in the same synchronous block as setHistory so
      // React batches all updates into a single render (avoids flash/scroll jump)
      if (clearPendingOnLoadRef.current) {
        clearPendingOnLoadRef.current = false;
        clearPending();
      }
      if (clearLiveStreamOnLoadRef.current) {
        const pending = clearLiveStreamOnLoadRef.current;
        clearLiveStreamOnLoadRef.current = false;
        // If the pending clear was scoped to a specific (finished) task, only
        // drop liveStream when it still belongs to that task. A new task that
        // started streaming during the fetch has already replaced liveStream,
        // and its content must be preserved.
        const scopedTaskId = pending !== true ? pending.taskId : null;
        const owned = !!liveStreamRef.current
          && (pending === true || liveStreamRef.current.taskId === scopedTaskId);
        if (owned) setLiveStream(null);
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
    // Update sessionKeyRef immediately so subsequent WS events match the new key,
    // then notify parent — but do NOT return: the snapshot carries live stream data
    // that must be applied to avoid swallowing content during promotion.
    if (state?.sessionId && state.sessionId !== session.sessionId) {
      promotingRef.current = true;
      sessionKeyRef.current = `${session.agent}:${state.sessionId}`;
      onSessionChange?.({ agent: session.agent || '', sessionId: state.sessionId, workdir });
    }
    if (!state) {
      const prev = prevPhaseRef.current;
      setStreaming(false);
      if (prev === 'streaming') {
        // Delay liveStream clearing — same pattern as the 'done' handler
        clearPendingOnLoadRef.current = true;
        clearLiveStreamOnLoadRef.current = true;
        void loadLatestTurns({ keepOlder: true, force: true, scrollToBottom: stickToBottomRef.current });
      } else {
        setLiveStream(null);
      }
      if (prev === 'done') {
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
      setQueuedTaskIds([]);
      setQueuedTasks([]);
      prevPhaseRef.current = null;
      return;
    }
    setStreamPhase(state.phase);
    setStreamTaskId(state.taskId || null);
    setQueuedTaskIds(state.queuedTaskIds && state.queuedTaskIds.length ? state.queuedTaskIds : []);
    setQueuedTasks(state.queuedTasks && state.queuedTasks.length ? state.queuedTasks : []);
    if (state.phase === 'streaming') {
      // Steer handoff: a previous task just ended ('done' triggered loadLatestTurns
      // and armed clearLiveStreamOnLoadRef). The new task's initial snapshot carries
      // an empty text — overwriting liveStream here would flash the previous task's
      // partial response away before loadLatestTurns has a chance to commit it to
      // history. Skip the empty overwrite; the new task's subsequent text events
      // (or the loadLatestTurns completion) will replace liveStream naturally.
      const handingOffPrevTask = clearLiveStreamOnLoadRef.current
        && !!liveStreamRef.current
        && liveStreamRef.current.taskId !== null
        && liveStreamRef.current.taskId !== (state.taskId || null)
        && !(state.text || '').trim();
      if (!handingOffPrevTask) {
        setLiveStream({
          taskId: state.taskId || null,
          phase: 'streaming',
          text: state.text || '',
          thinking: state.thinking || '',
          activity: state.activity,
          plan: state.plan ?? null,
        });
      }
      setStreaming(true);
      // Reveal the optimistic bubble once the latest-sent task is the one
      // streaming. Falls back to the FIFO "nothing left queued" heuristic for
      // the legacy case where pendingTaskId hasn't resolved yet (very fast
      // start before the send API returns).
      const isPendingsTask = !!state.taskId && pendingTaskIdRef.current === state.taskId;
      const hasMoreQueued = !!state.queuedTaskIds?.length;
      if (isPendingsTask || !hasMoreQueued) setPendingQueued(false);
      if (stickToBottomRef.current) scrollToBottomRef.current = true;
    } else if (state.phase === 'queued') {
      setLiveStream(null);
      setStreaming(false);
    } else if (state.phase === 'done') {
      // Don't clear liveStream here — keep it visible so the scroll position stays
      // stable while loadLatestTurns fetches the full history.  The live preview is
      // cleared atomically with the history update inside loadLatestTurns to avoid
      // the intermediate "empty" render that causes a scroll jump.
      setStreaming(false);
      const hasMoreQueued = !!state.queuedTaskIds?.length;
      if (prevPhaseRef.current !== 'done') {
        if (!hasMoreQueued) clearPendingOnLoadRef.current = true;
        // Scope the pending clear to the finishing task so a steer handoff can
        // start a new task's stream without losing its preview when the history
        // fetch resolves.
        clearLiveStreamOnLoadRef.current = { taskId: state.taskId || null };
        void loadLatestTurns({ keepOlder: true, force: true, scrollToBottom: stickToBottomRef.current });
      }
      if (!hasMoreQueued) localStreamPendingRef.current = false;
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
      // Only wipe the optimistic pending state if it belongs to THIS task —
      // recalling an older queued task shouldn't erase the still-in-flight
      // latest-sent message's bubble.
      if (pendingTaskIdRef.current === taskId) clearPending();
      // Optimistic: clear the specific task reference so UI responds immediately
      setQueuedTaskIds(prev => prev.filter(id => id !== taskId));
      setQueuedTasks(prev => prev.filter(t => t.taskId !== taskId));
      setStreamTaskId(prev => prev === taskId ? null : prev);
    } catch {}
  }, [clearPending]);

  const handleSteerTask = useCallback(async (taskId: string) => {
    try { await api.steerSession(taskId); } catch {}
  }, []);

  const sk = snapshotKey(session.agent || '', session.sessionId);
  useEffect(() => {
    // During session promotion (pending→native), the sessionId prop changes but the
    // panel stays mounted (stable mountKey). Skip the full reset to preserve live
    // stream state — only refresh history with the new session ID.
    if (promotingRef.current) {
      promotingRef.current = false;
      void loadLatestTurns({ keepOlder: true, force: true });
      return;
    }
    let c = false;
    const cachedLatest = peekSessionMessages({
      workdir,
      agent: session.agent || '',
      sessionId: session.sessionId,
      rich: true,
      turnOffset: 0,
      turnLimit: SESSION_PAGE_TURNS,
    }, { allowStale: true });
    const isNewSession = hasInitialPending && !initialPendingConsumedRef.current;
    // Stale-while-revalidate: API cache → history snapshot → loading spinner
    const initialHistory = cachedLatest?.ok
      ? normalizeTurnHistory(cachedLatest)
      : historySnapshots.get(sk) || null;
    setLoading(isNewSession ? false : !initialHistory);
    setHistory(initialHistory);
    setLiveStream(null);
    setStreaming(false);
    setStreamPhase(null);
    setQueuedTaskIds([]);
    setQueuedTasks([]);
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
  // Must wait until the stream snapshot is gone (streamPhase null, no queued
  // tasks). Otherwise a steer/recall mid-flight — where session.running can
  // briefly flip to false between task A finishing and queued task B starting —
  // would clear pendingPrompt and "lose" the optimistic bubble for the queued
  // message until loadLatestTurns later picks it up as a persisted turn.
  useEffect(() => {
    if (displayState !== 'running' && !streaming && !liveStream
        && !streamPhase && queuedTaskIds.length === 0) {
      clearPending();
      localStreamPendingRef.current = false;
    }
  }, [displayState, streaming, liveStream, streamPhase, queuedTaskIds.length, clearPending]);

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
    // Catch any post-layout height shifts (CSS animations, LivePreview→TurnView swap)
    requestAnimationFrame(() => {
      if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
  }, [history, liveStream]);

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
  // BUT: when there's a pending follow-up prompt whose turn hasn't appeared in history
  // yet, the liveStream is for the NEW turn — don't strip the previous turn's response.
  const turns = useMemo(() => {
    if (!liveStream || !rawTurns.length) return rawTurns;
    const last = rawTurns[rawTurns.length - 1];
    if (!last.assistant) return rawTurns;
    // If a pending prompt exists and doesn't match the last turn's user message,
    // the live stream is for a new follow-up turn, not the last one in history.
    if (pendingPrompt && last.user?.text?.trim() !== pendingPrompt.trim()) return rawTurns;
    return [...rawTurns.slice(0, -1), { ...last, assistant: null }];
  }, [rawTurns, liveStream, pendingPrompt]);

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
        onSendTaskAssigned={handleSendTaskAssigned}
        onSessionChange={onSessionChange}
        t={t}
        streamPhase={streamPhase}
        streamTaskId={streamTaskId}
        queuedTaskIds={queuedTaskIds}
        queuedTasks={queuedTasks}
        pendingPrompt={pendingPrompt}
        onRecall={handleRecallTask}
        onSteer={handleSteerTask}
        editDraft={editDraft}
        onEditDraftConsumed={() => setEditDraft(null)}
      />
    </div>
  );
});
