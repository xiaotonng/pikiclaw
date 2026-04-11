import { useState, useEffect, useLayoutEffect, useRef, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { cn, EFFORT_OPTIONS, getAgentMeta } from '../../utils';
import { api } from '../../api';
import { useStore } from '../../store';
import { Spinner } from '../../components/ui';
import { BrandIcon } from '../../components/BrandIcon';
import {
  makeComposerImageAttachment,
  revokeComposerAttachments,
  formatFileSize,
  copyImageFile,
  parseSessionKey,
  type ComposerImageAttachment,
} from './utils';
import type { SessionInfo, AgentRuntimeStatus, SkillInfo } from '../../types';

type CascadeStep = 'closed' | 'agent' | 'model' | 'effort';

/* ── Draft persistence across session switches ── */
const draftStore = new Map<string, { text: string; files: File[] }>();
function draftKey(agent: string, sessionId: string) { return `${agent}:${sessionId}`; }

export const InputComposer = memo(function InputComposer({ session, workdir, onStreamQueued, onSendStart, onSessionChange, t, streamPhase, streamTaskId, queuedTaskId, pendingPrompt, onRecall, onSteer, editDraft, onEditDraftConsumed }: {
  session: SessionInfo;
  workdir: string;
  onStreamQueued: () => void;
  onSendStart: (prompt: string, imageUrls?: string[]) => void;
  onSessionChange?: (next: { agent: string; sessionId: string; workdir: string }) => void;
  t: (k: string) => string;
  streamPhase: string | null;
  streamTaskId?: string | null;
  queuedTaskId?: string | null;
  pendingPrompt?: string | null;
  onRecall?: (taskId: string) => void;
  onSteer?: (taskId: string) => void;
  editDraft?: string | null;
  onEditDraftConsumed?: () => void;
}) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [localTaskId, setLocalTaskId] = useState<string | null>(null);
  const [recallPending, setRecallPending] = useState(false);
  const [steerPending, setSteerPending] = useState(false);
  // Stash last-sent content so recall can restore it to the input field
  const lastSentRef = useRef<{ prompt: string; files: File[] }>({ prompt: '', files: [] });
  const storeAgents = useStore(s => s.agentStatus?.agents ?? null);
  const [agents, setAgents] = useState<AgentRuntimeStatus[]>(storeAgents || []);
  const [selectedAgent, setSelectedAgent] = useState(session.agent || '');
  const [selectedModel, setSelectedModel] = useState(session.model || '');
  const [selectedEffort, setSelectedEffort] = useState('');
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const [previewImageId, setPreviewImageId] = useState<string | null>(null);
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingEffort, setPendingEffort] = useState<string | null>(null);
  const [cascadeStep, setCascadeStep] = useState<CascadeStep>('closed');
  const [cascadePos, setCascadePos] = useState<{ left: number; bottom: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const attachmentsRef = useRef<ComposerImageAttachment[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillMenuIndex, setSkillMenuIndex] = useState(0);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const reloadAppState = useStore(s => s.reload);
  const refreshAgentStatus = useStore(s => s.refreshAgentStatus);

  useEffect(() => { if (storeAgents?.length) setAgents(storeAgents); }, [storeAgents]);
  useEffect(() => { attachmentsRef.current = imageAttachments; }, [imageAttachments]);

  // Restore draft on mount, save on unmount
  const dk = draftKey(session.agent || '', session.sessionId);
  const dkRef = useRef(dk);
  dkRef.current = dk;
  useEffect(() => {
    const saved = draftStore.get(dk);
    if (saved) {
      draftStore.delete(dk);
      if (saved.text) setInput(saved.text);
      if (saved.files.length) setImageAttachments(saved.files.map(makeComposerImageAttachment));
    }
    return () => {
      const text = inputRef.current?.value || '';
      const files = attachmentsRef.current.map(a => a.file);
      // Save draft — revoke preview URLs but keep File objects
      for (const a of attachmentsRef.current) URL.revokeObjectURL(a.previewUrl);
      if (text || files.length) draftStore.set(dkRef.current, { text, files });
      else draftStore.delete(dkRef.current);
    };
  }, [dk]);

  useEffect(() => {
    if (!agents.length) return;
    const fallbackAgent = selectedAgent
      || session.agent
      || agents.find(agent => agent.isDefault)?.agent
      || agents.find(agent => agent.installed)?.agent
      || agents[0]?.agent
      || '';
    const fallbackStatus = agents.find(agent => agent.agent === fallbackAgent) || null;
    if (fallbackAgent && !selectedAgent) setSelectedAgent(fallbackAgent);
    if (!selectedModel) {
      const nextModel = fallbackAgent === session.agent
        ? (session.model || fallbackStatus?.selectedModel || '')
        : (fallbackStatus?.selectedModel || '');
      if (nextModel) setSelectedModel(nextModel);
    }
    if (!selectedEffort && fallbackAgent && fallbackAgent !== 'gemini') {
      const nextEffort = fallbackStatus?.selectedEffort || '';
      if (nextEffort) setSelectedEffort(nextEffort);
    }
  }, [agents, selectedAgent, selectedEffort, selectedModel, session.agent, session.model]);

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

  // Fetch available skills when workdir changes
  useEffect(() => {
    if (!workdir) return;
    let cancelled = false;
    api.getSkills(workdir).then(res => {
      if (!cancelled && res.ok) setSkills(res.skills);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [workdir]);

  // Compute filtered skills for the autocomplete menu
  const skillQuery = skillMenuOpen ? (() => {
    const match = input.match(/^\/(\S*)$/);
    return match ? match[1].toLowerCase() : null;
  })() : null;
  const filteredSkills = skillQuery !== null
    ? skills.filter(s => s.name.toLowerCase().includes(skillQuery) || (s.label && s.label.toLowerCase().includes(skillQuery)))
    : [];

  // Reset selected index when filtered list changes
  useEffect(() => { setSkillMenuIndex(0); }, [skillMenuOpen, input]);

  // Scroll skill menu to keep selected item visible
  useEffect(() => {
    if (!skillMenuOpen || !skillMenuRef.current) return;
    const item = skillMenuRef.current.querySelector(`[data-skill-idx="${skillMenuIndex}"]`);
    if (item) (item as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [skillMenuIndex, skillMenuOpen]);

  // Close skill menu on outside click
  useEffect(() => {
    if (!skillMenuOpen) return;
    const h = (e: MouseEvent) => {
      if (skillMenuRef.current?.contains(e.target as Node)) return;
      if (inputRef.current?.contains(e.target as Node)) return;
      setSkillMenuOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [skillMenuOpen]);

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

  // Clear local taskId once the real snapshot has the info
  useEffect(() => {
    if (localTaskId) {
      if (queuedTaskId) setLocalTaskId(null);
      else if (streamPhase !== null && streamPhase !== 'queued') setLocalTaskId(null);
    }
  }, [streamPhase, localTaskId, queuedTaskId]);

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
    const targetAgent = selectedAgent || session.agent || '';
    if (!targetAgent) return;
    const targetModel = selectedModel.trim() || null;
    const targetEffort = targetAgent === 'gemini'
      ? null
      : (selectedEffort.trim() || null);
    const targetSessionId = targetAgent === session.agent ? session.sessionId : '';
    setSending(true);
    // Stash content for potential recall restoration
    lastSentRef.current = { prompt, files: attachments };
    setInput('');
    draftStore.delete(dkRef.current);
    // Create fresh preview URLs before clearing (clearing revokes the originals)
    const previewUrls = attachments.length ? attachments.map(f => URL.createObjectURL(f)) : undefined;
    clearImageAttachments();
    onSendStart(prompt, previewUrls);
    onStreamQueued(); // Start polling immediately — don't wait for API response
    api.sendSessionMessage(workdir, targetAgent, targetSessionId, prompt, {
      attachments,
      model: targetModel,
      effort: targetEffort,
    })
      .then(res => {
        if (res.taskId) setLocalTaskId(res.taskId);
        if (!res.ok) return;
        const nextSession = typeof res.sessionKey === 'string' ? parseSessionKey(res.sessionKey) : null;
        const switchedSession = !!nextSession
          && (nextSession.agent !== session.agent || nextSession.sessionId !== session.sessionId);
        if (switchedSession && nextSession) {
          onSessionChange?.({ ...nextSession, workdir });
        }
      })
      .catch(() => {})
      .finally(() => setSending(false));
  }, [
    clearImageAttachments,
    imageAttachments,
    input,
    onSendStart,
    onSessionChange,
    onStreamQueued,
    selectedAgent,
    selectedEffort,
    selectedModel,
    sending,
    session.agent,
    session.sessionId,
    workdir,
  ]);

  // Task bar state — derived from snapshot + optimistic local state
  const isActiveStream = streamPhase === 'streaming';
  const effectiveQueuedId = queuedTaskId
    || (streamPhase === 'queued' ? (streamTaskId || localTaskId) : null)
    || (!streamPhase && localTaskId ? localTaskId : null);
  const hasQueuedTask = !!effectiveQueuedId;
  const showTaskBar = hasQueuedTask || isActiveStream;

  // Clear action-pending flags when the target state resolves
  useEffect(() => {
    if (recallPending && !hasQueuedTask && !isActiveStream) setRecallPending(false);
  }, [recallPending, hasQueuedTask, isActiveStream]);
  useEffect(() => {
    if (steerPending && !hasQueuedTask) setSteerPending(false);
  }, [steerPending, hasQueuedTask]);
  // Clear stashed files once queued task starts streaming (no longer recallable)
  useEffect(() => {
    if (!hasQueuedTask && lastSentRef.current.files.length) {
      lastSentRef.current = { prompt: '', files: [] };
    }
  }, [hasQueuedTask]);

  const handleRecall = useCallback(() => {
    if (recallPending) return;
    if (hasQueuedTask && effectiveQueuedId) {
      setRecallPending(true);
      // Restore sent text + images back to the input field
      const stash = lastSentRef.current;
      if (stash.prompt) setInput(stash.prompt);
      if (stash.files.length) setImageAttachments(stash.files.map(makeComposerImageAttachment));
      lastSentRef.current = { prompt: '', files: [] };
      onRecall?.(effectiveQueuedId);
      setLocalTaskId(null);
    } else if (isActiveStream && streamTaskId) {
      setRecallPending(true);
      onRecall?.(streamTaskId);
    }
  }, [recallPending, hasQueuedTask, effectiveQueuedId, isActiveStream, streamTaskId, onRecall]);

  const handleStop = useCallback(() => {
    if (recallPending || !streamTaskId) return;
    setRecallPending(true);
    onRecall?.(streamTaskId);
  }, [recallPending, streamTaskId, onRecall]);

  const handleSteer = useCallback(() => {
    if (steerPending) return;
    if (effectiveQueuedId) {
      setSteerPending(true);
      onSteer?.(effectiveQueuedId);
      setLocalTaskId(null);
    }
  }, [steerPending, effectiveQueuedId, onSteer]);

  const selectSkill = useCallback((skill: SkillInfo) => {
    setInput(`/${skill.name} `);
    setSkillMenuOpen(false);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }, []);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    // Open skill menu when input is a single slash-command token (no spaces yet)
    const isSlashCmd = /^\/\S*$/.test(value) && skills.length > 0;
    setSkillMenuOpen(isSlashCmd);
  }, [skills.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (skillMenuOpen && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSkillMenuIndex(i => (i + 1) % filteredSkills.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSkillMenuIndex(i => (i - 1 + filteredSkills.length) % filteredSkills.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !composingRef.current)) {
        e.preventDefault();
        selectSkill(filteredSkills[skillMenuIndex]);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setSkillMenuOpen(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) { e.preventDefault(); handleSend(); }
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

  const effectiveAgent = selectedAgent || session.agent || agents.find(a => a.isDefault)?.agent || '';
  const currentAgent = agents.find(a => a.agent === effectiveAgent) || null;
  const cascadeAgentId = pendingAgent || effectiveAgent;
  const cascadeAgent = agents.find(a => a.agent === cascadeAgentId) || currentAgent;
  const models = cascadeAgent?.models || [];
  const currentModel = selectedModel || (effectiveAgent === session.agent ? (session.model || '') : '') || currentAgent?.selectedModel || '';
  const currentEffort = effectiveAgent === 'gemini' ? '' : (selectedEffort || currentAgent?.selectedEffort || '');
  const effortLevels = EFFORT_OPTIONS[cascadeAgentId as keyof typeof EFFORT_OPTIONS] || [];
  const activePreview = previewImageId ? imageAttachments.find(item => item.id === previewImageId) || null : null;
  const canSend = (!!input.trim() || imageAttachments.length > 0) && !sending && !!effectiveAgent;

  const resetCascade = () => { setPendingAgent(null); setPendingModel(null); setPendingEffort(null); };

  const persistComposerDefaults = useCallback(async (agent: string, model: string, effort: string | null) => {
    const patch: Record<string, unknown> = { defaultAgent: agent };
    if (model) {
      patch.agent = agent;
      patch.model = model;
    }
    if (effort && agent !== 'gemini') {
      patch.agent = agent;
      patch.effort = effort;
    }
    try {
      const res = await api.updateRuntimeAgent(patch);
      if (res.ok && res.agents) setAgents(res.agents);
      await reloadAppState();
    } catch {}
  }, [reloadAppState]);

  const applyCascade = useCallback((agent: string, model: string, effort: string | null) => {
    setSelectedAgent(agent);
    setSelectedModel(model);
    setSelectedEffort(agent === 'gemini' ? '' : (effort || ''));
    resetCascade();
    setCascadeStep('closed');
    void persistComposerDefaults(agent, model, effort);
  }, [persistComposerDefaults]);

  const toggleCascade = () => {
    if (cascadeStep === 'closed') { resetCascade(); refreshAgentStatus(); setCascadeStep('agent'); }
    else { resetCascade(); setCascadeStep('closed'); }
  };

  // Build summary label for the cascade trigger
  const displayAgent = pendingAgent || effectiveAgent;
  const displayMeta = getAgentMeta(displayAgent);
  const displayModel = pendingModel ?? currentModel;
  const displayEffort = pendingEffort ?? currentEffort;
  const cascadeLabel = [
    displayMeta.label,
    displayModel ? (displayModel.length > 18 ? displayModel.slice(0, 18) + '\u2026' : displayModel) : null,
    displayEffort ? displayEffort.charAt(0).toUpperCase() + displayEffort.slice(1) : null,
  ].filter(Boolean).join(' / ');

  return (
    <div className="shrink-0" ref={composerRef}>
      {/* Floating centered input area */}
      <div className="max-w-[680px] mx-auto px-5 pb-4 pt-2">
        {/* Task control bar — stacked rows when streaming + queued coexist */}
        {showTaskBar && (
          <div className="mb-2 space-y-1.5">
            {/* Row 1: Active stream — always visible when streaming */}
            {isActiveStream && (
              <div className="flex items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/[0.04] px-3.5 py-1.5 transition-colors">
                <Spinner className="h-3 w-3 text-primary shrink-0" />
                <span className="flex-1 min-w-0 text-[12px] font-medium text-fg-3 truncate">{t('hub.running')}</span>
                <button
                  onClick={handleStop}
                  disabled={!streamTaskId || recallPending}
                  title={t('hub.stopHint')}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-fg-4 hover:text-err hover:bg-err/10 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
                >
                  {recallPending && !hasQueuedTask
                    ? <Spinner className="h-2.5 w-2.5" />
                    : <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>}
                  {t('hub.stop')}
                </button>
              </div>
            )}
            {/* Row 2: Queued task — shows message preview + steer/recall */}
            {hasQueuedTask && (
              <div className="flex items-center gap-2.5 rounded-lg border border-warn/25 bg-warn/[0.04] px-3.5 py-1.5 transition-colors">
                <span className="h-1.5 w-1.5 rounded-full bg-warn animate-pulse shrink-0" />
                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                  <span className="text-[12px] font-medium text-warn shrink-0">{t('hub.queued')}</span>
                  {pendingPrompt && (
                    <span className="text-[11px] text-fg-5/60 truncate">{pendingPrompt}</span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={handleSteer}
                    disabled={!effectiveQueuedId || steerPending}
                    title={t('hub.steerHint')}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-fg-4 hover:text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
                  >
                    {steerPending
                      ? <Spinner className="h-2.5 w-2.5" />
                      : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 6 15 12 9 18" /></svg>}
                    {t('hub.steer')}
                  </button>
                  <button
                    onClick={handleRecall}
                    disabled={!effectiveQueuedId || recallPending}
                    title={t('hub.recallHint')}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-fg-4 hover:text-err hover:bg-err/10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
                  >
                    {recallPending
                      ? <Spinner className="h-2.5 w-2.5" />
                      : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg>}
                    {t('hub.recall')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="relative rounded-xl border border-edge/40 bg-panel shadow-sm transition-[border-color,box-shadow] duration-200 focus-within:border-fg-5/40 focus-within:shadow-md">
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
                      className="group relative h-[72px] w-[72px] overflow-hidden rounded-lg border border-edge/30 bg-panel-alt/30"
                    >
                      <img src={item.previewUrl} alt={item.file.name} className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent px-1.5 pb-1 pt-3 text-left">
                        <div className="truncate text-[8px] font-medium text-white/90 leading-tight">{item.file.name}</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeImageAttachment(item.id);
                      }}
                      title={t('hub.removeImage')}
                      className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white/75 transition-colors hover:bg-black/80 hover:text-white"
                    >
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M18 6 6 18" />
                        <path d="M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Skill autocomplete popup */}
          {skillMenuOpen && filteredSkills.length > 0 && (
            <div
              ref={skillMenuRef}
              className="absolute bottom-full left-0 right-0 mb-1.5 z-50 max-h-[200px] overflow-y-auto rounded-xl border border-edge/40 bg-[var(--th-dropdown)] backdrop-blur-xl shadow-lg animate-in"
            >
              <div className="px-3 pt-2 pb-1 border-b border-edge/20">
                <span className="text-[10px] font-semibold text-fg-5 uppercase tracking-wider">{t('hub.skills')}</span>
              </div>
              <div className="py-1">
                {filteredSkills.map((skill, idx) => (
                  <button
                    key={skill.name}
                    data-skill-idx={idx}
                    onMouseDown={e => { e.preventDefault(); selectSkill(skill); }}
                    onMouseEnter={() => setSkillMenuIndex(idx)}
                    className={cn(
                      'flex flex-col w-full px-3 py-1.5 text-left transition-colors',
                      idx === skillMenuIndex
                        ? 'bg-panel-h text-fg'
                        : 'text-fg-3 hover:bg-panel-alt/50',
                    )}
                  >
                    <span className="text-[12.5px] font-medium">/{skill.name}</span>
                    {(skill.label || skill.description) && (
                      <span className="text-[11px] text-fg-5 truncate">{skill.label || skill.description}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => handleInputChange(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            placeholder={t('hub.inputPlaceholder')}
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[13.5px] text-fg outline-none placeholder:text-fg-5/25 leading-[1.6]"
            style={{ maxHeight: 200, overflow: input.split('\n').length > 6 ? 'auto' : 'hidden' }}
          />

          {/* Bottom bar: cascade selector + send */}
          <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title={t('hub.addImages')}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-5/50 transition-colors hover:bg-panel-h/60 hover:text-fg-3"
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
              disabled={!agents.length}
              className={cn(
                'flex items-center gap-1.5 h-[28px] px-2.5 rounded-lg text-[11px] font-medium transition-all duration-200 select-none',
                cascadeStep !== 'closed'
                  ? 'bg-panel-h border border-edge-h text-fg-3'
                  : 'text-fg-5/60 hover:text-fg-4 hover:bg-panel-h/50 border border-transparent',
              )}
            >
              {agents.length
                ? <BrandIcon brand={displayAgent} size={12} />
                : <Spinner className="h-3 w-3" />}
              <span className="max-w-[200px] truncate">{agents.length ? cascadeLabel : t('hub.selectAgent')}</span>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                className={cn('text-fg-5/30 transition-transform duration-200', cascadeStep !== 'closed' && 'rotate-180')}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Cascade dropdown — rendered via portal to escape overflow:hidden */}
            {cascadeStep !== 'closed' && cascadePos && createPortal(
              <div
                id="cascade-portal"
                className="fixed z-[200] w-[220px] rounded-xl border border-edge/40 bg-[var(--th-dropdown)] backdrop-blur-xl shadow-lg overflow-hidden animate-in"
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
                      <CascadeItem key={a.agent} selected={a.agent === (pendingAgent || effectiveAgent)} onClick={() => {
                        setPendingAgent(a.agent);
                        setPendingModel(a.selectedModel || '');
                        setPendingEffort(a.selectedEffort || '');
                        setCascadeStep('model');
                      }}>
                        <BrandIcon brand={a.agent} size={14} />
                        <span style={{ color: am.color }}>{am.label}</span>
                      </CascadeItem>
                    );
                  })}
                  {cascadeStep === 'model' && (
                    <>
                      {models.map(m => (
                        <CascadeItem key={m.id} selected={m.id === (pendingModel ?? currentModel) || m.alias === (pendingModel ?? currentModel)} onClick={() => {
                          const finalAgent = pendingAgent || effectiveAgent;
                          setPendingModel(m.id);
                          if (EFFORT_OPTIONS[finalAgent as keyof typeof EFFORT_OPTIONS]?.length) {
                            setCascadeStep('effort');
                            return;
                          }
                          void applyCascade(finalAgent, m.id, null);
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
                      const finalAgent = pendingAgent || effectiveAgent;
                      const finalModel = pendingModel ?? currentModel;
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
                'flex items-center justify-center w-[30px] h-[30px] rounded-lg transition-all duration-200',
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
        <div className="overflow-hidden rounded-xl border border-white/10 bg-black/35 shadow-[0_20px_70px_rgba(0,0,0,0.45)]">
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
export function CascadeItem({ selected, onClick, children }: {
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
