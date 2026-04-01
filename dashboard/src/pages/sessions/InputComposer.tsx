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
import type { SessionInfo, AgentRuntimeStatus } from '../../types';

type CascadeStep = 'closed' | 'agent' | 'model' | 'effort';

export const InputComposer = memo(function InputComposer({ session, workdir, onStreamQueued, onSendStart, onSessionChange, t, streamPhase, streamTaskId, onRecall, onSteer, editDraft, onEditDraftConsumed }: {
  session: SessionInfo;
  workdir: string;
  onStreamQueued: () => void;
  onSendStart: (prompt: string, imageUrls?: string[]) => void;
  onSessionChange?: (next: { agent: string; sessionId: string; workdir: string }) => void;
  t: (k: string) => string;
  streamPhase: string | null;
  streamTaskId?: string | null;
  onRecall?: (taskId: string) => void;
  onSteer?: (taskId: string) => void;
  editDraft?: string | null;
  onEditDraftConsumed?: () => void;
}) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [localTaskId, setLocalTaskId] = useState<string | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const attachmentsRef = useRef<ComposerImageAttachment[]>([]);
  const reloadAppState = useStore(s => s.reload);
  const refreshAgentStatus = useStore(s => s.refreshAgentStatus);

  useEffect(() => { if (storeAgents?.length) setAgents(storeAgents); }, [storeAgents]);
  useEffect(() => { attachmentsRef.current = imageAttachments; }, [imageAttachments]);
  useEffect(() => () => revokeComposerAttachments(attachmentsRef.current), []);

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

  // Clear local taskId once the task leaves the queue (started running or finished)
  useEffect(() => {
    if (localTaskId && streamPhase !== 'queued' && streamPhase !== null) {
      setLocalTaskId(null);
    }
  }, [streamPhase, localTaskId]);

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
    setInput('');
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

  const effectiveTaskId = streamTaskId || localTaskId;

  const handleRecall = useCallback(() => {
    const tid = streamTaskId || localTaskId;
    if (!tid) return;
    onRecall?.(tid);
    setLocalTaskId(null);
  }, [streamTaskId, localTaskId, onRecall]);

  const handleSteer = useCallback(() => {
    const tid = streamTaskId || localTaskId;
    if (!tid) return;
    onSteer?.(tid);
    setLocalTaskId(null);
  }, [streamTaskId, localTaskId, onSteer]);

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
      {/* Queue banner — show from poll state OR optimistically after send API returns */}
      {(streamPhase === 'queued' || (!!localTaskId && !streamPhase)) && (
        <div className="flex items-center gap-2 px-5 py-2 border-t border-edge/40 bg-warn/[0.04]">
          <span className="h-1.5 w-1.5 rounded-full bg-warn animate-pulse" />
          <span className="text-[11px] text-warn font-medium">{t('hub.queued')}</span>
          <div className="ml-auto flex gap-1">
            <button onClick={handleRecall} disabled={!effectiveTaskId} className="px-2.5 py-1 rounded-md text-[11px] font-medium text-fg-4 hover:text-err hover:bg-err/10 transition-colors disabled:opacity-30 disabled:pointer-events-none">{t('hub.recall')}</button>
            <button onClick={handleSteer} disabled={!effectiveTaskId} className="px-2.5 py-1 rounded-md text-[11px] font-medium text-fg-4 hover:text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-30 disabled:pointer-events-none">{t('hub.steer')}</button>
          </div>
        </div>
      )}

      {/* Floating centered input area */}
      <div className="max-w-[680px] mx-auto px-5 pb-4 pt-2">
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

          {/* Textarea */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
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
