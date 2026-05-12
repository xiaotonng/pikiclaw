/**
 * InteractionPromptModal — dashboard popup for `im_ask_user` / Codex user-input.
 *
 * Mirrors the IM card flow on Telegram + Feishu: shows the active question with
 * either tap-able option chips, a freeform text input, or both. Multi-question
 * prompts advance locally (tracked via `currentIndex`) and the server closes the
 * popup automatically once every question is answered (the snapshot's
 * `interactions` array empties out via SSE, which un-renders this component).
 *
 * Action plumbing: select / text / skip / cancel all hit `/api/interaction/...`
 * endpoints exposed by the dashboard backend; both Claude (via the bridge MCP
 * tool) and Codex (via its native `requestUserInput`) reach this same UI.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Button, Input, Modal, ModalHeader, Spinner } from '../../components/ui';
import { cn } from '../../utils';
import type { InteractionSnapshot } from '../../types';

interface Props {
  snapshot: InteractionSnapshot;
}

export function InteractionPromptModal({ snapshot }: Props) {
  const [currentIndex, setCurrentIndex] = useState(snapshot.currentIndex ?? 0);
  const [freeformText, setFreeformText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the prompt identity changes — back-to-back prompts on the
  // same session should each start at the server's reported current question
  // (handles refresh / reconnect resume correctly).
  useEffect(() => {
    setCurrentIndex(snapshot.currentIndex ?? 0);
    setFreeformText('');
    setError(null);
  }, [snapshot.promptId, snapshot.currentIndex]);

  const questions = snapshot.questions || [];
  const question = questions[currentIndex] || null;
  const totalQuestions = questions.length;

  const hasOptions = !!(question?.options && question.options.length);
  const allowFreeform = hasOptions ? !!question?.allowFreeform : true;

  const advanceOrFinish = (advanced: boolean | undefined) => {
    if (advanced) {
      setCurrentIndex(idx => idx + 1);
      setFreeformText('');
    }
    // When the server reports `completed`, it also clears the prompt from the
    // session snapshot — the parent un-renders this modal via the next SSE
    // event, so we don't need to dismiss explicitly here.
  };

  const handleSelectOption = async (value: string) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.interactionSelectOption(snapshot.promptId, value);
      if (!res.ok) { setError(res.error || 'Failed to submit selection.'); return; }
      advanceOrFinish(res.advanced);
    } catch (e: any) {
      setError(e?.message || 'Network error.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitText = async () => {
    if (submitting) return;
    const text = freeformText.trim();
    if (!text && !question?.allowEmpty) {
      setError('Please enter a response.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.interactionSubmitText(snapshot.promptId, text);
      if (!res.ok) { setError(res.error || 'Failed to submit answer.'); return; }
      advanceOrFinish(res.advanced);
    } catch (e: any) {
      setError(e?.message || 'Network error.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.interactionSkip(snapshot.promptId);
      if (!res.ok) { setError(res.error || 'Failed to skip.'); return; }
      advanceOrFinish(res.advanced);
    } catch (e: any) {
      setError(e?.message || 'Network error.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.interactionCancel(snapshot.promptId);
    } catch {}
    // The server emits `interaction-resolved`; the parent will un-render us.
  };

  // We must call hooks at the top level, so always run the modal but render an
  // empty body if `question` is somehow missing (shouldn't happen in practice).
  const description = useMemo(() => {
    const parts: string[] = [];
    if (snapshot.hint) parts.push(snapshot.hint);
    if (totalQuestions > 1) parts.push(`Question ${currentIndex + 1} of ${totalQuestions}`);
    return parts.join(' · ') || undefined;
  }, [snapshot.hint, currentIndex, totalQuestions]);

  return (
    <Modal open onClose={handleCancel} wide={hasOptions && (question?.options?.length || 0) > 3}>
      <ModalHeader
        title={snapshot.title || 'Pikiclaw needs your input'}
        description={description}
        onClose={handleCancel}
      />

      {question ? (
        <div className="space-y-4">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-5">{question.header || 'Question'}</div>
            <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-fg">{question.prompt}</div>
          </div>

          {hasOptions && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(question.options || []).map(opt => (
                <button
                  key={opt.value || opt.label}
                  type="button"
                  disabled={submitting}
                  onClick={() => handleSelectOption(opt.value || opt.label)}
                  className={cn(
                    'group rounded-lg border border-edge bg-panel-alt px-3 py-2 text-left text-sm transition',
                    'hover:border-control-border-h hover:bg-control-h hover:shadow-sm',
                    'focus:outline-none focus:ring-2 focus:ring-[var(--th-glow-a)]',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                >
                  <div className="font-medium text-fg group-hover:text-fg">{opt.label}</div>
                  {opt.description && (
                    <div className="mt-0.5 text-xs leading-snug text-fg-4">{opt.description}</div>
                  )}
                </button>
              ))}
            </div>
          )}

          {allowFreeform && (
            <div>
              <Input
                value={freeformText}
                onChange={(e) => setFreeformText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !submitting) {
                    e.preventDefault();
                    void handleSubmitText();
                  }
                }}
                placeholder={hasOptions ? 'Or type a custom answer…' : 'Type your answer…'}
                disabled={submitting}
                autoFocus={!hasOptions}
              />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-300/40 bg-red-500/10 px-3 py-2 text-xs text-red-600">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-fg-5">
              {submitting ? (
                <span className="inline-flex items-center gap-2"><Spinner /> Submitting…</span>
              ) : (
                <span>Press <kbd className="rounded border border-edge bg-panel-alt px-1.5 py-0.5 text-[10px] uppercase">Enter</kbd> to send</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleSkip} disabled={submitting}>
                Skip
              </Button>
              {allowFreeform && (
                <Button variant="primary" size="sm" onClick={handleSubmitText} disabled={submitting || (!freeformText.trim() && !question.allowEmpty)}>
                  Submit
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="py-6 text-center text-sm text-fg-5">
          <Spinner className="mr-2 inline-block" /> Waiting for the agent…
        </div>
      )}
    </Modal>
  );
}
