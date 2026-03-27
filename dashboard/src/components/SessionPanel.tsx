import { useState, useEffect, useLayoutEffect, useRef, useCallback, memo, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../store';
import { createT } from '../i18n';
import { api } from '../api';
import { cn, EFFORT_OPTIONS, getAgentMeta, sessionDisplayState, shouldPollSessionStreamState } from '../utils';
import { Spinner } from './ui';
import { BrandIcon } from './BrandIcon';
import { PlanProgressCard, hasPlan } from './PlanProgressCard';
import type { SessionInfo, RichMessage, MessageBlock, AgentRuntimeStatus, SessionMessagesResult, StreamPlan } from '../types';

const SESSION_PAGE_TURNS = 12;
const TOP_LOAD_THRESHOLD_PX = 160;
const BOTTOM_STICK_THRESHOLD_PX = 96;

interface Turn { user: RichMessage | null; assistant: RichMessage | null }

interface TurnHistoryWindow {
  turns: Turn[];
  startTurn: number;
  endTurn: number;
  totalTurns: number;
  hasOlder: boolean;
}

/* ═══════════════════════════════════════════════════════════════
   SessionPanel
   ═══════════════════════════════════════════════════════════════ */
export const SessionPanel = memo(function SessionPanel({
  session, workdir,
}: {
  session: SessionInfo;
  workdir: string;
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
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const scrollToBottomRef = useRef(false);
  const loadingLatestRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const localStreamPendingRef = useRef(false);

  const fetchTurnWindow = useCallback(async (query: { turnOffset?: number; turnLimit?: number; lastNTurns?: number }) => {
    try {
      const res = await api.getSessionMessages(workdir, session.agent || '', session.sessionId, {
        rich: true,
        turnOffset: query.turnOffset,
        turnLimit: query.turnLimit,
        lastNTurns: query.lastNTurns,
      });
      if (!res.ok) return null;
      return normalizeTurnHistory(res);
    } catch {
      return null;
    }
  }, [workdir, session.agent, session.sessionId]);

  const loadLatestTurns = useCallback(async ({ keepOlder }: { keepOlder: boolean }) => {
    if (loadingLatestRef.current) return false;
    loadingLatestRef.current = true;
    try {
      const next = await fetchTurnWindow({ turnOffset: 0, turnLimit: SESSION_PAGE_TURNS });
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

  useEffect(() => {
    let c = false;
    setLoading(true);
    setHistory(null);
    setLiveStream(null);
    setStreaming(false);
    setStreamPhase(null);
    stickToBottomRef.current = true;
    scrollToBottomRef.current = true;
    loadLatestTurns({ keepOlder: false }).finally(() => { if (!c) setLoading(false); });
    return () => { c = true; };
  }, [loadLatestTurns]);

  /* ── Poll stream state — works identically across multiple tabs ── */
  useEffect(() => {
    let active = true;
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
      if (!active) return;
      try {
        const res = await api.getSessionStreamState(session.agent || '', session.sessionId);
        if (!active) return;
        const state = res.state;
        const phase = state?.phase ?? null;
        const keepPolling = shouldPollSessionStreamState(displayState, localStreamPendingRef.current, phase, prevPhase);
        if (!state) {
          // No active stream — if we were streaming, stream ended externally
          if (prevPhase === 'streaming') {
            setLiveStream(null);
            setStreaming(false);
            if (stickToBottomRef.current) scrollToBottomRef.current = true;
            void loadLatestTurns({ keepOlder: true });
          } else if (prevPhase === 'done') {
            setLiveStream(null);
          }
          if (prevPhase === 'queued' || prevPhase === 'streaming' || prevPhase === 'done') {
            localStreamPendingRef.current = false;
          }
          setStreamPhase(null);
          prevPhase = null;
          if (keepPolling) ensurePolling();
          else stopPolling();
          return;
        }
        setStreamPhase(state.phase);
        if (state.phase === 'streaming') {
          setPendingPrompt(null);
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
          setPendingPrompt(null);
          setLiveStream(hasPlan(state.plan) ? {
            phase: 'done',
            text: '',
            thinking: '',
            activity: '',
            plan: state.plan,
          } : null);
          setStreaming(false);
          if (prevPhase !== 'done') {
            if (stickToBottomRef.current) scrollToBottomRef.current = true;
            void loadLatestTurns({ keepOlder: true });
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
      active = false;
      stopPolling();
    };
  }, [displayState, loadLatestTurns, session.agent, session.sessionId, streamPollNonce]);

  /* ── Fallback: poll messages for IM-triggered sessions (no stream snapshot) ── */
  useEffect(() => {
    if (displayState !== 'running') return;
    if (streaming) return; // stream-state polling is active, no need
    const id = setInterval(() => { void loadLatestTurns({ keepOlder: true }); }, 3000);
    return () => clearInterval(id);
  }, [displayState, loadLatestTurns, streaming]);

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
      <div className="shrink-0 flex items-center gap-2.5 px-5 h-10 border-b border-edge/50 bg-panel/40 backdrop-blur-md z-10">
        <BrandIcon brand={session.agent || ''} size={14} />
        <span className="flex-1 min-w-0 text-[13px] font-medium text-fg truncate">{title}</span>
        {session.model && (
          <span className="text-[10px] font-mono text-fg-5 px-1.5 py-0.5 rounded bg-panel-alt/40">{session.model}</span>
        )}
        {displayState === 'running' && (
          <span className="flex items-center gap-1.5">
            <span className="h-[5px] w-[5px] rounded-full bg-ok animate-pulse" />
            <span className="text-[10px] text-ok font-medium">{t('status.running')}</span>
          </span>
        )}
      </div>

      {/* ── Messages ── */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <div className="flex items-center justify-center py-20"><Spinner className="h-5 w-5 text-fg-4" /></div>
        ) : turns.length === 0 && !pendingPrompt && !liveStream ? (
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
                  setPendingPrompt(txt);
                  api.sendSessionMessage(workdir, session.agent || '', session.sessionId, txt)
                    .then((res) => { if (res.ok) requestStreamPolling(); })
                    .catch(() => { setPendingPrompt(null); });
                }}
                onEdit={(txt) => setEditDraft(txt)} />
            ))}
            {/* Optimistic pending message — shown immediately after send */}
            {pendingPrompt && !liveStream && (
              <div className="session-turn">
                <UserBubble text={pendingPrompt} t={t} />
                <TurnDivider agent={session.agent || ''} meta={meta} />
                <div className="mb-6">
                  <div className="flex items-center gap-2.5 rounded-md border border-fg-6 bg-panel px-3.5 py-3 shadow-sm">
                    <span className="relative flex h-4 w-4 items-center justify-center">
                      <span className="absolute h-full w-full rounded-full bg-fg-4/20 animate-ping" />
                      <span className="relative h-2 w-2 rounded-full bg-fg-4/60" />
                    </span>
                    <span className="text-[12.5px] text-fg-4">{t('hub.sending')}</span>
                  </div>
                </div>
              </div>
            )}
            {/* Live stream preview */}
            {liveStream && (
              <div className="mb-6">
                {!pendingPrompt && <TurnDivider agent={session.agent || ''} meta={meta} />}
                {pendingPrompt && (
                  <>
                    <UserBubble text={pendingPrompt} t={t} />
                    <TurnDivider agent={session.agent || ''} meta={meta} />
                  </>
                )}
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
        onSendStart={setPendingPrompt}
        t={t}
        streamPhase={streamPhase}
        editDraft={editDraft}
        onEditDraftConsumed={() => setEditDraft(null)}
      />
    </div>
  );
});

/* ═══════════════════════════════════════════════════════════════
   Turns
   ═══════════════════════════════════════════════════════════════ */

function normalizeTurnHistory(result: SessionMessagesResult): TurnHistoryWindow {
  const richMessages = result.richMessages?.length
    ? result.richMessages
    : result.messages?.map(m => ({ role: m.role, text: m.text, blocks: [{ type: 'text' as const, content: m.text }] })) || [];
  const turns = groupIntoTurns(richMessages);
  const totalTurns = Math.max(result.window?.totalTurns ?? result.totalTurns ?? turns.length, turns.length);
  const endTurn = result.window?.endTurn ?? totalTurns;
  const startTurn = result.window?.startTurn ?? Math.max(0, endTurn - turns.length);
  return {
    turns,
    startTurn,
    endTurn,
    totalTurns,
    hasOlder: result.window?.hasOlder ?? startTurn > 0,
  };
}

function mergeOlderHistory(current: TurnHistoryWindow, older: TurnHistoryWindow): TurnHistoryWindow {
  const prefixCount = Math.max(0, current.startTurn - older.startTurn);
  const prefix = older.turns.slice(0, prefixCount);
  return {
    turns: [...prefix, ...current.turns],
    startTurn: older.startTurn,
    endTurn: current.endTurn,
    totalTurns: Math.max(current.totalTurns, older.totalTurns),
    hasOlder: older.hasOlder,
  };
}

function mergeLatestHistory(current: TurnHistoryWindow, latest: TurnHistoryWindow): TurnHistoryWindow {
  if (latest.startTurn <= current.startTurn) return latest;
  const keepCount = Math.max(0, latest.startTurn - current.startTurn);
  const preservedPrefix = current.turns.slice(0, keepCount);
  return {
    turns: [...preservedPrefix, ...latest.turns],
    startTurn: current.startTurn,
    endTurn: latest.endTurn,
    totalTurns: latest.totalTurns,
    hasOlder: current.startTurn > 0,
  };
}

function groupIntoTurns(msgs: RichMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn = { user: null, assistant: null };
  for (const m of msgs) {
    if (m.role === 'user') {
      if (cur.user || cur.assistant) { turns.push(cur); cur = { user: null, assistant: null }; }
      cur.user = m;
    } else cur.assistant = m;
  }
  if (cur.user || cur.assistant) turns.push(cur);
  return turns;
}

const TurnView = memo(function TurnView({ turn, agent, meta, t, onResend, onEdit }: {
  turn: Turn; agent: string; meta: ReturnType<typeof getAgentMeta>; t: (k: string) => string;
  onResend?: (text: string) => void;
  onEdit?: (text: string) => void;
}) {
  // Detect system continuation messages stored as user role
  const isSystemMsg = turn.user && !turn.assistant && isContinuationSummary(turn.user.text);

  return (
    <div className="session-turn">
      {turn.user && !isSystemMsg && (
        <UserBubble text={turn.user.text} t={t} onResend={onResend} onEdit={onEdit} />
      )}
      {isSystemMsg && turn.user && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-[rgba(255,255,255,0.02)] border border-edge/20 text-[12.5px] leading-[1.7] text-fg-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {turn.user.text}
          </ReactMarkdown>
        </div>
      )}
      {turn.assistant && <TurnDivider agent={agent} meta={meta} />}
      {turn.assistant && (
        <div className="mb-6">
          <AssistantMsg message={turn.assistant} t={t} />
        </div>
      )}
    </div>
  );
});

/** Detect continuation/summary messages that Claude stores as role=user */
function isContinuationSummary(text: string): boolean {
  if (text.length > 800) return true;
  const markers = ['continued from a previous', 'summary below covers', 'earlier portion of the conversation', 'Summary:', 'Key Technical Concepts'];
  return markers.some(m => text.includes(m));
}

/** User message bubble with actions */
function UserBubble({ text, t, onResend, onEdit }: {
  text: string;
  t: (k: string) => string;
  onResend?: (text: string) => void;
  onEdit?: (text: string) => void;
}) {
  const [showActions, setShowActions] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasActions = !!(onResend || onEdit);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  return (
    <div
      className="flex flex-col items-end mb-5 group/bubble"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className="max-w-[72%] rounded-md border border-fg-6 bg-panel px-4 py-3 text-[13.5px] leading-[1.72] text-fg shadow-sm">
        <div className="whitespace-pre-wrap break-words">{text}</div>
      </div>
      {/* Action bar — appears below the bubble on hover */}
      {hasActions && (
        <div className={cn(
          'flex items-center gap-1 mt-1.5 mr-1 transition-all duration-200',
          showActions ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1 pointer-events-none',
        )}>
          <BubbleAction label={copied ? t('hub.copied') : t('hub.copy')} onClick={handleCopy}>
            {copied
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            }
          </BubbleAction>
          {onResend && (
            <BubbleAction label={t('hub.rerun')} onClick={() => onResend(text)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </BubbleAction>
          )}
          {onEdit && (
            <BubbleAction label={t('hub.edit')} onClick={() => onEdit(text)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </BubbleAction>
          )}
        </div>
      )}
    </div>
  );
}

function BubbleAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="flex items-center justify-center w-7 h-7 rounded border border-fg-6 bg-panel text-fg-4 shadow-sm hover:text-fg-2 hover:border-edge-h hover:bg-panel-h transition-colors"
    >
      {children}
    </button>
  );
}

function TurnDivider({ agent, meta }: { agent: string; meta: ReturnType<typeof getAgentMeta> }) {
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-edge/60" />
      <div className="flex items-center gap-1.5 text-[11px] text-fg-5">
        <BrandIcon brand={agent} size={12} />
        <span style={{ color: meta.color, opacity: 0.6 }} className="font-medium">{meta.label}</span>
      </div>
      <div className="flex-1 h-px bg-edge/60" />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Assistant message — separated activity, thinking, output
   ═══════════════════════════════════════════════════════════════ */
function AssistantMsg({ message, t }: { message: RichMessage; t: (k: string) => string }) {
  const { activityBlocks, thinkingBlocks, processNotes, outputBlocks } = categorizeAssistantBlocks(message.blocks);
  return (
    <div className="space-y-3">
      {activityBlocks.length > 0 && <ActivitySection blocks={activityBlocks} notes={processNotes} t={t} />}
      {thinkingBlocks.length > 0 && <ThinkingSection blocks={thinkingBlocks} t={t} />}
      {outputBlocks.length > 0 && <OutputBlock blocks={outputBlocks} />}
    </div>
  );
}

/* ── Live streaming preview ── */
function LivePreview({
  stream,
  t,
}: {
  stream: { phase: 'streaming' | 'done'; text: string; thinking: string; activity?: string; plan?: StreamPlan | null };
  t: (k: string) => string;
}) {
  const showPlan = hasPlan(stream.plan);
  const [activityOpen, setActivityOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const activityScrollRef = useRef<HTMLDivElement>(null);
  const thinkingScrollRef = useRef<HTMLDivElement>(null);
  const showBody = !!stream.text || !!stream.activity || !!stream.thinking;

  const activityLines = useMemo(() =>
    (stream.activity || '').split('\n').filter(Boolean),
    [stream.activity],
  );
  const lastActivity = activityLines[activityLines.length - 1] || '';

  // Auto-scroll activity detail to bottom when content updates
  useLayoutEffect(() => {
    const el = activityScrollRef.current;
    if (el && activityOpen) el.scrollTop = el.scrollHeight;
  }, [activityOpen, stream.activity]);

  // Auto-scroll thinking detail to bottom when content updates
  useLayoutEffect(() => {
    const el = thinkingScrollRef.current;
    if (el && thinkingOpen) el.scrollTop = el.scrollHeight;
  }, [thinkingOpen, stream.thinking]);

  return (
    <div className="space-y-3 animate-in">
      {/* Plan — prominent card at top */}
      {showPlan && (
        <PlanProgressCard plan={stream.plan!} phase={stream.phase} t={t} className="mb-1 max-w-[760px]" />
      )}

      {/* Activity — expandable, shows latest line as preview */}
      {activityLines.length > 0 && (
        <div className="rounded-md border border-fg-6 bg-panel overflow-hidden shadow-sm">
          <button
            onClick={() => setActivityOpen(v => !v)}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
          >
            <span className="h-[7px] w-[7px] rounded-full bg-cyan-400/60 shrink-0 animate-pulse" />
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fg-5">{t('hub.activity')}</span>
            <span className="flex-1 min-w-0 text-[12px] text-fg-4 truncate">{lastActivity}</span>
            {activityLines.length > 1 && (
              <span className="rounded border border-fg-6 bg-inset px-1.5 py-0.5 text-[10px] font-mono text-fg-5">{activityLines.length}</span>
            )}
            <ChevronIcon open={activityOpen} />
          </button>
          {activityOpen && (
            <div ref={activityScrollRef} className="border-t border-fg-6 px-3.5 py-2.5 space-y-0.5 max-h-[240px] overflow-y-auto">
              {activityLines.map((line, i) => (
                <div key={i} className="flex items-center gap-1.5 py-[2px]">
                  <span className="w-1 h-1 rounded-full shrink-0 bg-fg-5/30" />
                  <span className="text-[11px] font-mono text-fg-5/60 truncate">{line}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Thinking — 3-line preview, expandable */}
      {stream.thinking && (
        <div className="rounded-md border border-fg-6 bg-panel overflow-hidden shadow-sm">
          <button
            onClick={() => setThinkingOpen(v => !v)}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left hover:bg-white/[0.02] transition-colors"
          >
            <span className="h-[6px] w-[6px] rounded-full bg-violet-400/50 shrink-0 animate-pulse" />
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fg-5">{t('hub.thinking')}</span>
            <div className="flex-1" />
            <ChevronIcon open={thinkingOpen} />
          </button>
          {!thinkingOpen && (
            <div className="px-3.5 pb-2.5 -mt-0.5 text-[12px] text-fg-4 leading-[1.65] whitespace-pre-wrap break-words line-clamp-3">
              {lastNLines(stream.thinking, 3)}
            </div>
          )}
          {thinkingOpen && (
            <div ref={thinkingScrollRef} className="border-t border-fg-6 px-3.5 py-3 text-[12px] text-fg-4 leading-[1.7] whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
              {stream.thinking}
            </div>
          )}
        </div>
      )}

      {/* Response text with typing cursor */}
      {stream.text && (
        <div className="session-md text-[13.5px] leading-[1.75] text-fg-2">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {stream.text}
          </ReactMarkdown>
          <span className="inline-block w-[2px] h-[16px] bg-fg-3 animate-pulse ml-0.5 align-text-bottom" />
        </div>
      )}

      {/* Waiting state — no content yet */}
      {!showPlan && !showBody && (
        <div className="flex items-center gap-2.5 py-1">
          <Spinner className="h-3.5 w-3.5 text-fg-5" />
          <span className="text-[12px] text-fg-5">{t('status.running')}</span>
        </div>
      )}
    </div>
  );
}


function categorizeAssistantBlocks(blocks: MessageBlock[]): {
  activityBlocks: MessageBlock[];
  thinkingBlocks: MessageBlock[];
  processNotes: MessageBlock[];
  outputBlocks: MessageBlock[];
} {
  const normalized = blocks.filter(block =>
    block.type === 'tool_use' || block.type === 'tool_result' || !!block.content.trim(),
  );
  const hasStructured = normalized.some(b => b.type !== 'text');
  if (!hasStructured) return { activityBlocks: [], thinkingBlocks: [], processNotes: [], outputBlocks: normalized };

  let trailingStart = normalized.length;
  while (trailingStart > 0 && normalized[trailingStart - 1].type === 'text') trailingStart--;

  const processRegion = trailingStart < normalized.length ? normalized.slice(0, trailingStart) : normalized;
  const outputBlocks = trailingStart < normalized.length ? normalized.slice(trailingStart) : [];

  return {
    activityBlocks: processRegion.filter(b => b.type === 'tool_use' || b.type === 'tool_result'),
    thinkingBlocks: processRegion.filter(b => b.type === 'thinking'),
    processNotes: processRegion.filter(b => b.type === 'text'),
    outputBlocks,
  };
}

/* ═══════════════════════════════════════════════════════════════
   Activity section — collapsible tool call summary (cyan accent)
   ═══════════════════════════════════════════════════════════════ */
function ActivitySection({ blocks, notes, t }: { blocks: MessageBlock[]; notes: MessageBlock[]; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const tools = blocks
    .filter(b => b.type === 'tool_use')
    .map(b => b.toolName || 'tool')
    .filter((name, i, list) => list.indexOf(name) === i);
  const totalOps = blocks.length;

  return (
    <div className="rounded-md border border-fg-6 bg-panel overflow-hidden shadow-sm">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-cyan-400/60 shrink-0" />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fg-5">{t('hub.activity')}</span>
        <span className="flex-1 min-w-0 text-[11.5px] font-mono text-fg-4 truncate">{tools.join(' \u00b7 ')}</span>
        {totalOps > 0 && (
          <span className="rounded border border-fg-6 bg-inset px-1.5 py-0.5 text-[10px] font-mono text-fg-5">{totalOps}</span>
        )}
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="border-t border-fg-6 px-3.5 py-2.5 space-y-0.5">
          {blocks.map((block, i) => <ActivityLine key={i} block={block} />)}
          {notes.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {notes.map((block, i) => (
                <div key={`note-${i}`} className="rounded-md border border-fg-6 bg-inset px-3 py-2 session-md text-[12px] leading-[1.7] text-fg-4">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {block.content}
                  </ReactMarkdown>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityLine({ block }: { block: MessageBlock }) {
  const [open, setOpen] = useState(false);
  const isUse = block.type === 'tool_use';
  return (
    <div>
      <button onClick={() => block.content && setOpen(v => !v)} className="flex items-center gap-1.5 py-[2px] w-full text-left group">
        <span className={cn('w-1 h-1 rounded-full shrink-0', isUse ? 'bg-fg-5/30' : 'bg-emerald-400/30')} />
        <span className="text-[11px] font-mono text-fg-5/50 group-hover:text-fg-3 transition-colors truncate">
          {isUse ? (block.toolName || 'tool') : 'result'}
        </span>
      </button>
      {open && block.content && (
        <pre className="ml-3 mt-1 mb-2 p-3 rounded-md bg-inset border border-fg-6 text-[11px] leading-[1.6] text-fg-4 font-mono whitespace-pre-wrap break-words max-h-[240px] overflow-y-auto">
          {block.content.length > 3000 ? block.content.slice(0, 3000) + '\n\u2026' : block.content}
        </pre>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Thinking section — collapsible, last 3 lines preview
   ═══════════════════════════════════════════════════════════════ */
function ThinkingSection({ blocks, t }: { blocks: MessageBlock[]; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const text = blocks.map(b => b.content).filter(Boolean).join('\n\n').trim();
  if (!text) return null;

  const preview = lastNLines(text, 3);

  return (
    <div className="rounded-md border border-fg-6 bg-panel overflow-hidden shadow-sm">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="h-[6px] w-[6px] rounded-full bg-violet-400/50 shrink-0" />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fg-5">{t('hub.thinking')}</span>
        <div className="flex-1" />
        <ChevronIcon open={open} />
      </button>
      {/* Collapsed: last 3 lines preview */}
      {!open && preview && (
        <div className="px-3.5 pb-2.5 -mt-0.5 text-[12px] text-fg-4 leading-[1.65] whitespace-pre-wrap break-words line-clamp-3">
          {preview}
        </div>
      )}
      {/* Expanded: full content, auto-scroll to bottom */}
      {open && (
        <ThinkingExpandedContent scrollRef={scrollRef} text={text} />
      )}
    </div>
  );
}

/** Expanded thinking content — scrolls to bottom on mount. */
function ThinkingExpandedContent({ scrollRef, text }: { scrollRef: React.RefObject<HTMLDivElement | null>; text: string }) {
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  return (
    <div ref={scrollRef} className="border-t border-fg-6 px-3.5 py-3 text-[12px] text-fg-4 leading-[1.7] whitespace-pre-wrap break-words max-h-[320px] overflow-y-auto">
      {text}
    </div>
  );
}

function lastNLines(text: string, n: number): string {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length <= n) return lines.join('\n');
  return lines.slice(-n).join('\n');
}

/* ═══════════════════════════════════════════════════════════════
   Output — markdown
   ═══════════════════════════════════════════════════════════════ */
function OutputBlock({ blocks }: { blocks: MessageBlock[] }) {
  const text = blocks.map(b => b.content).filter(Boolean).join('\n\n');
  if (!text.trim()) return null;
  return (
    <div className="session-md text-[13.5px] leading-[1.75] text-fg-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/* ── Custom react-markdown components for styling ── */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); };
  return (
    <button onClick={copy} className="flex items-center text-fg-5/50 hover:text-fg-3 transition-colors">
      {copied
        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      }
    </button>
  );
}

function classifyCode(text: string): string {
  const isPath = /^[.~/].*\.\w+$/.test(text) || /^[a-z][\w-]*\//.test(text);
  const isCmd = /^(npm |npx |git |python|pip |yarn |pnpm |cargo |go |make )/.test(text);
  if (isPath) return 'bg-blue-500/8 border-blue-400/12 text-blue-300/90';
  if (isCmd) return 'bg-amber-500/8 border-amber-400/10 text-amber-300/80';
  return 'bg-[rgba(255,255,255,0.06)] border-edge/20 text-fg-3';
}

const mdComponents: Record<string, React.ComponentType<any>> = {
  h1: ({ children }: any) => <h2 className="text-[16px] font-bold text-fg mt-4 mb-2">{children}</h2>,
  h2: ({ children }: any) => <h3 className="text-[14.5px] font-semibold text-fg mt-4 mb-1.5">{children}</h3>,
  h3: ({ children }: any) => <h4 className="text-[13.5px] font-semibold text-fg mt-3 mb-1">{children}</h4>,
  p: ({ children }: any) => <p className="my-1.5 whitespace-pre-wrap break-words">{children}</p>,
  strong: ({ children }: any) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }: any) => <em className="italic text-fg-3">{children}</em>,
  a: ({ href, children }: any) => <span className="text-blue-400 underline underline-offset-2 decoration-blue-400/30 cursor-pointer">{children}</span>,
  ul: ({ children }: any) => <ul className="space-y-1 my-2 ml-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="space-y-1 my-2 ml-1 list-decimal list-inside">{children}</ol>,
  li: ({ children }: any) => (
    <li className="flex gap-2 items-start">
      <span className="shrink-0 mt-[10px] w-[5px] h-[5px] rounded-full bg-fg-5/40" />
      <span className="flex-1">{children}</span>
    </li>
  ),
  blockquote: ({ children }: any) => <blockquote className="border-l-2 border-fg-5/30 pl-3 my-2 text-fg-4 italic">{children}</blockquote>,
  hr: () => <hr className="border-edge/30 my-4" />,
  code: ({ className, children, ...props }: any) => {
    const text = String(children).replace(/\n$/, '');
    const langMatch = /language-(\w+)/.exec(className || '');

    // Inline code (no language class, short)
    if (!langMatch && !className) {
      return <code className={cn('px-1.5 py-[1px] rounded text-[12px] font-mono border', classifyCode(text))}>{text}</code>;
    }

    // Fenced code block
    const lang = langMatch?.[1] || '';
    return (
      <div className="rounded-lg overflow-hidden border border-edge/30 bg-[rgba(0,0,0,0.25)] my-3 not-prose">
        <div className="flex items-center justify-between px-3.5 py-1.5 border-b border-edge/15 bg-[rgba(0,0,0,0.12)]">
          <span className="text-[10px] font-mono text-fg-5/50">{lang || 'text'}</span>
          <CopyButton text={text} />
        </div>
        <pre className="px-3.5 py-3 text-[12px] leading-[1.65] text-fg-3 font-mono whitespace-pre-wrap break-words overflow-x-auto">
          <code>{text}</code>
        </pre>
      </div>
    );
  },
  pre: ({ children }: any) => <>{children}</>,
  table: ({ children }: any) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-edge/30">
      <table className="w-full text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }: any) => <thead className="bg-[rgba(0,0,0,0.1)]">{children}</thead>,
  th: ({ children }: any) => <th className="px-3 py-1.5 text-left font-semibold text-fg-3 border-b border-edge/30">{children}</th>,
  td: ({ children }: any) => <td className="px-3 py-1.5 text-fg-4 border-t border-edge/12">{children}</td>,
  tr: ({ children }: any) => <tr className="even:bg-[rgba(255,255,255,0.015)]">{children}</tr>,
};

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      className={cn('text-fg-5/30 transition-transform duration-200 ml-0.5', open && 'rotate-180')}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════
   InputComposer — Floating centered input with cascading config selector
   ═══════════════════════════════════════════════════════════════ */
type CascadeStep = 'closed' | 'agent' | 'model' | 'effort';
type ComposerImageAttachment = { id: string; file: File; previewUrl: string };

function makeComposerImageAttachment(file: File): ComposerImageAttachment {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    previewUrl: URL.createObjectURL(file),
  };
}

function revokeComposerAttachments(items: ComposerImageAttachment[]) {
  for (const item of items) URL.revokeObjectURL(item.previewUrl);
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

async function copyImageFile(file: File): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ [file.type || 'image/png']: file })]);
    return true;
  } catch {
    return false;
  }
}

const InputComposer = memo(function InputComposer({ session, workdir, onStreamQueued, onSendStart, t, streamPhase, editDraft, onEditDraftConsumed }: {
  session: SessionInfo;
  workdir: string;
  onStreamQueued: () => void;
  onSendStart: (prompt: string) => void;
  t: (k: string) => string;
  streamPhase: string | null;
  editDraft?: string | null;
  onEditDraftConsumed?: () => void;
}) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [queuedTaskId, setQueuedTaskId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRuntimeStatus[]>([]);
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const [previewImageId, setPreviewImageId] = useState<string | null>(null);
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingEffort, setPendingEffort] = useState<string | null>(null);
  const [cascadeStep, setCascadeStep] = useState<CascadeStep>('closed');
  const [cascadePos, setCascadePos] = useState<{ left: number; bottom: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const attachmentsRef = useRef<ComposerImageAttachment[]>([]);

  const refreshAgents = useCallback(() => { api.getAgentStatus().then(r => setAgents(r.agents || [])).catch(() => {}); }, []);
  useEffect(() => { refreshAgents(); }, [refreshAgents]);
  useEffect(() => { attachmentsRef.current = imageAttachments; }, [imageAttachments]);
  useEffect(() => () => revokeComposerAttachments(attachmentsRef.current), []);

  // Consume editDraft — populate the input when user clicks "Edit" on a message
  useEffect(() => {
    if (editDraft != null) {
      setInput(editDraft);
      onEditDraftConsumed?.();
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) { el.focus(); el.setSelectionRange(editDraft.length, editDraft.length); }
      });
    }
  }, [editDraft, onEditDraftConsumed]);

  // Close cascade on outside click — check both trigger and portal
  useEffect(() => {
    if (cascadeStep === 'closed') return;
    const h = (e: MouseEvent) => {
      const target = e.target as Node;
      // Don't close if clicking inside the trigger button
      if (triggerRef.current?.contains(target)) return;
      // Don't close if clicking inside the portal dropdown
      const portal = document.getElementById('cascade-portal');
      if (portal?.contains(target)) return;
      setCascadeStep('closed'); setPendingAgent(null); setPendingModel(null); setPendingEffort(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [cascadeStep]);

  // Position the cascade portal above the trigger button
  useLayoutEffect(() => {
    if (cascadeStep === 'closed' || !triggerRef.current) { setCascadePos(null); return; }
    const rect = triggerRef.current.getBoundingClientRect();
    setCascadePos({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
  }, [cascadeStep]);

  // Clear taskId once the task leaves the queue (started running or finished)
  useEffect(() => {
    if (queuedTaskId && streamPhase !== 'queued' && streamPhase !== null) {
      setQueuedTaskId(null);
    }
  }, [streamPhase, queuedTaskId]);

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  const addImageAttachments = useCallback((files: ArrayLike<File> | null | undefined) => {
    const nextFiles = Array.from(files || []).filter(file => file.type.startsWith('image/'));
    if (!nextFiles.length) return;
    setImageAttachments(prev => [...prev, ...nextFiles.map(makeComposerImageAttachment)]);
  }, []);

  const clearImageAttachments = useCallback(() => {
    setPreviewImageId(null);
    setImageAttachments(prev => {
      revokeComposerAttachments(prev);
      return [];
    });
  }, []);

  const removeImageAttachment = useCallback((id: string) => {
    setImageAttachments(prev => {
      const target = prev.find(item => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(item => item.id !== id);
    });
    setPreviewImageId(current => current === id ? null : current);
  }, []);

  const handleSend = useCallback(() => {
    const prompt = input.trim();
    const attachments = imageAttachments.map(item => item.file);
    if ((!prompt && attachments.length === 0) || sending) return;
    setSending(true);
    setInput('');
    clearImageAttachments();
    if (prompt) onSendStart(prompt);
    api.sendSessionMessage(workdir, session.agent || '', session.sessionId, prompt, attachments)
      .then(res => {
        if (res.ok) onStreamQueued();
        if (res.taskId) setQueuedTaskId(res.taskId);
      })
      .catch(() => {})
      .finally(() => setSending(false));
  }, [clearImageAttachments, imageAttachments, input, onSendStart, onStreamQueued, sending, session.agent, session.sessionId, workdir]);

  const handleRecall = useCallback(async () => {
    if (!queuedTaskId) return;
    try { await api.recallSessionMessage(queuedTaskId); setQueuedTaskId(null); } catch {}
  }, [queuedTaskId]);

  const handleSteer = useCallback(async () => {
    if (!queuedTaskId) return;
    try { await api.steerSession(queuedTaskId); setQueuedTaskId(null); } catch {}
  }, [queuedTaskId]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file);
    if (!files.length) return;
    e.preventDefault();
    addImageAttachments(files);
  }, [addImageAttachments]);

  const currentAgent = agents.find(a => a.agent === session.agent);
  const cascadeAgent = pendingAgent ? agents.find(a => a.agent === pendingAgent) : currentAgent;
  const models = cascadeAgent?.models || [];
  const currentModel = session.model || currentAgent?.selectedModel || '';
  const currentEffort = currentAgent?.selectedEffort || '';
  const effortLevels = EFFORT_OPTIONS[(pendingAgent || session.agent) as keyof typeof EFFORT_OPTIONS] || ['low', 'medium', 'high'];
  const activePreview = previewImageId ? imageAttachments.find(item => item.id === previewImageId) || null : null;
  const canSend = (!!input.trim() || imageAttachments.length > 0) && !sending;

  const resetCascade = () => { setPendingAgent(null); setPendingModel(null); setPendingEffort(null); };

  const applyCascade = useCallback(async (agent: string, model: string, effort: string | null) => {
    const patch: Record<string, unknown> = { defaultAgent: agent, agent, model };
    if (effort) patch.effort = effort;
    try {
      const res = await api.updateRuntimeAgent(patch);
      if (res.ok && res.agents) setAgents(res.agents);
    } catch {}
    resetCascade();
    setCascadeStep('closed');
  }, []);

  const toggleCascade = () => {
    if (cascadeStep === 'closed') { resetCascade(); refreshAgents(); setCascadeStep('agent'); }
    else { resetCascade(); setCascadeStep('closed'); }
  };

  // Build summary label for the cascade trigger
  const displayAgent = pendingAgent || session.agent || '';
  const displayMeta = getAgentMeta(displayAgent);
  const displayModel = pendingModel || currentModel;
  const displayEffort = pendingEffort || currentEffort;
  const cascadeLabel = [
    displayMeta.label,
    displayModel ? (displayModel.length > 18 ? displayModel.slice(0, 18) + '\u2026' : displayModel) : null,
    displayEffort ? displayEffort.charAt(0).toUpperCase() + displayEffort.slice(1) : null,
  ].filter(Boolean).join(' / ');

  return (
    <div className="shrink-0" ref={composerRef}>
      {/* Queue banner */}
      {queuedTaskId && streamPhase === 'queued' && (
        <div className="flex items-center gap-2 px-5 py-2 border-t border-edge/40 bg-warn/[0.04]">
          <span className="h-1.5 w-1.5 rounded-full bg-warn animate-pulse" />
          <span className="text-[11px] text-warn font-medium">{t('hub.queued')}</span>
          <div className="ml-auto flex gap-1">
            <button onClick={handleRecall} className="px-2.5 py-1 rounded-md text-[11px] font-medium text-fg-4 hover:text-err hover:bg-err/10 transition-colors">{t('hub.recall')}</button>
            <button onClick={handleSteer} className="px-2.5 py-1 rounded-md text-[11px] font-medium text-fg-4 hover:text-blue-400 hover:bg-blue-400/10 transition-colors">{t('hub.steer')}</button>
          </div>
        </div>
      )}

      {/* Floating centered input area */}
      <div className="max-w-[680px] mx-auto px-6 pb-5 pt-3">
        <div className="relative rounded-md border border-fg-6 bg-panel shadow-sm">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={e => {
              addImageAttachments(e.target.files);
              e.target.value = '';
            }}
          />

          {imageAttachments.length > 0 && (
            <div className="px-3 pt-3">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {imageAttachments.map(item => (
                  <div key={item.id} className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setPreviewImageId(item.id)}
                      title={t('hub.previewImage')}
                      className="group relative h-[84px] w-[84px] overflow-hidden rounded-md border border-fg-6 bg-panel-alt/40"
                    >
                      <img src={item.previewUrl} alt={item.file.name} className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 via-black/15 to-transparent px-2 pb-1.5 pt-4 text-left">
                        <div className="truncate text-[9px] font-medium text-white/92">{item.file.name}</div>
                        <div className="text-[9px] text-white/65">{formatFileSize(item.file.size)}</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeImageAttachment(item.id);
                      }}
                      title={t('hub.removeImage')}
                      className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-black/70 text-white/80 transition-colors hover:bg-black/85 hover:text-white"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                        <path d="M18 6 6 18" />
                        <path d="M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            placeholder={t('hub.inputPlaceholder')}
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-2 text-[13px] text-fg outline-none placeholder:text-fg-5/30 leading-[1.65]"
            style={{ maxHeight: 200, overflow: input.split('\n').length > 6 ? 'auto' : 'hidden' }}
          />

          {/* Bottom bar: cascade selector + send */}
          <div className="flex items-center gap-2 px-3 pb-2.5 pt-0.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title={t('hub.addImages')}
              className="flex h-[28px] w-[28px] items-center justify-center rounded-lg border border-transparent text-fg-5/60 transition-colors hover:border-edge/40 hover:bg-panel-h/50 hover:text-fg-3"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>

            {/* Cascade config trigger */}
            <button
              ref={triggerRef}
              onClick={toggleCascade}
              className={cn(
                'flex items-center gap-1.5 h-[28px] px-2.5 rounded-lg text-[11px] font-medium transition-all duration-200 select-none',
                cascadeStep !== 'closed'
                  ? 'bg-panel-h border border-edge-h text-fg-3'
                  : 'text-fg-5/60 hover:text-fg-4 hover:bg-panel-h/50 border border-transparent',
              )}
            >
              <BrandIcon brand={displayAgent} size={12} />
              <span className="max-w-[200px] truncate">{cascadeLabel}</span>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                className={cn('text-fg-5/30 transition-transform duration-200', cascadeStep !== 'closed' && 'rotate-180')}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Cascade dropdown — rendered via portal to escape overflow:hidden */}
            {cascadeStep !== 'closed' && cascadePos && createPortal(
              <div
                id="cascade-portal"
                className="fixed z-[200] w-[220px] rounded-md border border-fg-6 bg-[var(--th-dropdown)] backdrop-blur-xl shadow-lg overflow-hidden animate-in"
                style={{ left: cascadePos.left, bottom: cascadePos.bottom }}
              >
                {/* Step header */}
                <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 border-b border-edge/20">
                  {cascadeStep !== 'agent' && (
                    <button
                      onClick={() => setCascadeStep(cascadeStep === 'effort' ? 'model' : 'agent')}
                      className="p-0.5 rounded text-fg-5/50 hover:text-fg-3 transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <polyline points="15 18 9 12 15 6" />
                      </svg>
                    </button>
                  )}
                  <span className="text-[10px] font-semibold text-fg-5 uppercase tracking-wider">
                    {cascadeStep === 'agent' ? t('hub.selectAgent') : cascadeStep === 'model' ? t('hub.selectModel') : t('hub.selectEffort')}
                  </span>
                  <div className="ml-auto flex items-center gap-0.5">
                    {(['agent', 'model', 'effort'] as const).map((step, idx) => (
                      <span key={step} className={cn(
                        'w-1.5 h-1.5 rounded-full transition-colors',
                        cascadeStep === step ? 'bg-primary' : idx < ['agent', 'model', 'effort'].indexOf(cascadeStep) ? 'bg-primary/40' : 'bg-fg-5/15',
                      )} />
                    ))}
                  </div>
                </div>

                {/* Step content */}
                <div className="max-h-[200px] overflow-y-auto py-1">
                  {cascadeStep === 'agent' && agents.filter(a => a.installed).map(a => {
                    const am = getAgentMeta(a.agent);
                    return (
                      <CascadeItem key={a.agent} selected={a.agent === (pendingAgent || session.agent)} onClick={() => { setPendingAgent(a.agent); setCascadeStep('model'); }}>
                        <BrandIcon brand={a.agent} size={14} />
                        <span style={{ color: am.color }}>{am.label}</span>
                      </CascadeItem>
                    );
                  })}
                  {cascadeStep === 'model' && (
                    <>
                      {models.map(m => (
                        <CascadeItem key={m.id} selected={m.id === (pendingModel || currentModel) || m.alias === (pendingModel || currentModel)} onClick={() => {
                          setPendingModel(m.id);
                          setCascadeStep('effort');
                        }}>
                          <span className="font-mono text-[11px]">{m.alias || m.id}</span>
                        </CascadeItem>
                      ))}
                      {models.length === 0 && <div className="px-3 py-3 text-[11px] text-fg-5 text-center">{t('config.noModel')}</div>}
                    </>
                  )}
                  {cascadeStep === 'effort' && effortLevels.map(e => (
                    <CascadeItem key={e} selected={e === (pendingEffort || currentEffort)} onClick={() => {
                      setPendingEffort(e);
                      const finalAgent = pendingAgent || session.agent || '';
                      const finalModel = pendingModel || currentModel;
                      void applyCascade(finalAgent, finalModel, e);
                    }}>
                      {e.charAt(0).toUpperCase() + e.slice(1)}
                    </CascadeItem>
                  ))}
                </div>
              </div>,
              document.body,
            )}

            <div className="flex-1" />

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={cn(
                'flex items-center justify-center w-8 h-8 rounded-md transition-all duration-200',
                canSend
                  ? 'bg-primary text-primary-fg hover:brightness-110 shadow-sm'
                  : 'bg-fg/6 text-fg-5/20',
              )}
            >
              {sending
                ? <Spinner className="h-3.5 w-3.5" />
                : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
              }
            </button>
          </div>
        </div>
      </div>

      <ComposerImageLightbox
        attachment={activePreview}
        onClose={() => setPreviewImageId(null)}
        onRemove={removeImageAttachment}
        t={t}
      />
    </div>
  );
});

function ComposerImageLightbox({ attachment, onClose, onRemove, t }: {
  attachment: ComposerImageAttachment | null;
  onClose: () => void;
  onRemove: (id: string) => void;
  t: (k: string) => string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => { setCopied(false); }, [attachment?.id]);

  useEffect(() => {
    if (!attachment) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [attachment, onClose]);

  if (!attachment) return null;

  return createPortal(
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/72 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-[1024px]" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2 text-[11px] text-white/72">
          <span className="truncate font-medium text-white/90">{attachment.file.name}</span>
          <span>{formatFileSize(attachment.file.size)}</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                if (!await copyImageFile(attachment.file)) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              }}
              className="rounded-lg border border-white/12 bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white/88 transition-colors hover:bg-white/14"
            >
              {copied ? t('hub.copied') : t('hub.copyImage')}
            </button>
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              className="rounded-lg border border-white/12 bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white/88 transition-colors hover:bg-white/14"
            >
              {t('hub.removeImage')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/12 bg-white/10 text-white/88 transition-colors hover:bg-white/14"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6 6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="overflow-hidden rounded-[24px] border border-white/10 bg-black/35 shadow-[0_20px_70px_rgba(0,0,0,0.45)]">
          <img src={attachment.previewUrl} alt={attachment.file.name} className="max-h-[80vh] w-full object-contain" />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ═══════════════════════════════════════════════════════════════
   Cascade item
   ═══════════════════════════════════════════════════════════════ */
function CascadeItem({ selected, onClick, children }: {
  selected?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 w-full px-3 py-2 text-[12px] text-left transition-colors',
        selected ? 'text-fg bg-panel-h font-medium' : 'text-fg-3 hover:bg-panel-alt/50 hover:text-fg-2',
      )}
    >
      {children}
      {selected && (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-auto text-ok">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {!selected && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-auto text-fg-5/20">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      )}
    </button>
  );
}
