import { useState } from 'react';
import { cn } from '../utils';
import { CollapsibleCard } from './ui';
import type { StreamPlan } from '../types';

export function hasPlan(plan?: StreamPlan | null): plan is StreamPlan {
  return !!plan?.steps?.length;
}

function replaceVars(template: string, vars: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(vars)) {
    output = output.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return output;
}

function StepIcon({ status }: { status: StreamPlan['steps'][number]['status'] }) {
  if (status === 'completed') {
    return (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ok">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (status === 'inProgress') {
    return <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />;
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-fg-5/25" />;
}

export function PlanProgressCard({
  plan,
  phase,
  t,
  className,
}: {
  plan: StreamPlan;
  phase?: 'queued' | 'streaming' | 'done' | null;
  t: (key: string) => string;
  className?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!hasPlan(plan)) return null;

  const total = plan.steps.length;
  const completed = plan.steps.filter(step => step.status === 'completed').length;
  const isDone = phase === 'done' || completed === total;
  const progressLabel = replaceVars(t('hub.planProgress'), {
    done: String(completed),
    total: String(total),
  });

  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen(v => !v)}
      dot={{ color: isDone ? 'bg-emerald-400/60' : 'bg-cyan-400/60', pulse: !isDone }}
      label={progressLabel}
      preview={plan.explanation ? (
        <span className="text-[11.5px] text-fg-4 truncate">{plan.explanation}</span>
      ) : undefined}
      badge={
        <span className={cn(
          'rounded-md border px-1.5 py-0.5 text-[10px] font-mono',
          isDone ? 'border-ok/20 text-ok' : 'border-edge text-fg-5',
        )}>
          {isDone ? t('hub.planDone') : t('hub.planInProgress')}
        </span>
      }
      className={className}
    >
      <div className="px-3.5 py-2.5 space-y-1">
        {plan.steps.map((step, index) => {
          const textClass = step.status === 'completed'
            ? 'text-fg-5 line-through decoration-fg-5/40'
            : step.status === 'inProgress'
              ? 'text-fg-3'
              : 'text-fg-4';

          return (
            <div key={`${index}:${step.step}`} className="flex items-center gap-2 py-[2px]">
              <span className="shrink-0 flex items-center justify-center w-[10px]">
                <StepIcon status={step.status} />
              </span>
              <span className={cn('text-[12px] leading-[1.5]', textClass)}>
                {step.step}
              </span>
            </div>
          );
        })}
      </div>
    </CollapsibleCard>
  );
}
