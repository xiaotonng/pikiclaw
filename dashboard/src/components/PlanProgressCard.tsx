import { cn } from '../utils';
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

function PlanStatusIcon({ status }: { status: StreamPlan['steps'][number]['status'] }) {
  if (status === 'completed') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-ok/30 bg-ok/[0.12] text-ok">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (status === 'inProgress') {
    return <span className="h-2.5 w-2.5 rounded-full bg-sky-300 shadow-[0_0_0_4px_rgba(56,189,248,0.14)] animate-pulse" />;
  }
  return <span className="h-3 w-3 rounded-full border border-edge/80 bg-transparent" />;
}

export function PlanProgressCard({
  plan,
  phase,
  t,
  className,
  compact = false,
}: {
  plan: StreamPlan;
  phase?: 'queued' | 'streaming' | 'done' | null;
  t: (key: string) => string;
  className?: string;
  compact?: boolean;
}) {
  if (!hasPlan(plan)) return null;

  const total = plan.steps.length;
  const completed = plan.steps.filter(step => step.status === 'completed').length;
  const percent = Math.max(6, Math.round((completed / Math.max(total, 1)) * 100));
  const isDone = phase === 'done' || completed === total;
  const progressLabel = replaceVars(t('hub.planProgress'), {
    done: String(completed),
    total: String(total),
  });
  const statusLabel = isDone ? t('hub.planDone') : t('hub.planInProgress');
  const barClass = isDone ? 'bg-ok' : 'bg-sky-300';
  const toneClass = isDone
    ? 'border-ok/15 bg-[linear-gradient(180deg,rgba(16,185,129,0.08),rgba(16,185,129,0.03))]'
    : 'border-sky-400/15 bg-[linear-gradient(180deg,rgba(56,189,248,0.09),rgba(56,189,248,0.03))]';
  const badgeClass = isDone
    ? 'border-ok/20 bg-ok/[0.08] text-ok'
    : 'border-sky-300/20 bg-sky-300/[0.08] text-fg-2';

  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
        toneClass,
        className,
      )}
    >
      <div className={cn('border-b border-edge/25', compact ? 'px-3 py-2.5' : 'px-4 py-3')}>
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'flex shrink-0 items-center justify-center rounded-xl border',
              compact ? 'h-8 w-8' : 'h-9 w-9',
              badgeClass,
            )}
          >
            {isDone ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12h7l3 8 4-16 3 8h1" />
              </svg>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className={cn('font-semibold text-fg-2', compact ? 'text-[11.5px]' : 'text-[12.5px]')}>
                {progressLabel}
              </div>
              <span
                className={cn(
                  'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                  badgeClass,
                )}
              >
                {statusLabel}
              </span>
            </div>
            {plan.explanation && (
              <p className={cn('mt-1 leading-[1.5] text-fg-4', compact ? 'text-[10.5px]' : 'text-[11px]')}>
                {plan.explanation}
              </p>
            )}
            <div className={cn('mt-2 overflow-hidden rounded-full bg-edge/40', compact ? 'h-1' : 'h-1.5')}>
              <div className={cn('h-full rounded-full transition-all duration-300', barClass)} style={{ width: `${percent}%` }} />
            </div>
          </div>
        </div>
      </div>

      <ol className={cn(compact ? 'px-3 py-2.5' : 'px-4 py-3', 'space-y-1.5')}>
        {plan.steps.map((step, index) => {
          const rowClass = step.status === 'completed'
            ? 'border-edge/20 bg-black/10'
            : step.status === 'inProgress'
              ? 'border-sky-300/15 bg-sky-300/[0.08]'
              : 'border-edge/15 bg-black/5';
          const textClass = step.status === 'completed'
            ? 'text-fg-4 line-through decoration-fg-5/50'
            : step.status === 'inProgress'
              ? 'text-fg-2'
              : 'text-fg-4';

          return (
            <li
              key={`${index}:${step.step}`}
              className={cn(
                'flex items-start gap-2.5 rounded-xl border',
                rowClass,
                compact ? 'px-2.5 py-2' : 'px-3 py-2.5',
              )}
            >
              <span className={cn('shrink-0 pt-0.5 font-mono tabular-nums text-fg-5/65', compact ? 'text-[10px]' : 'text-[10.5px]')}>
                {index + 1}.
              </span>
              <div className="mt-0.5 shrink-0">
                <PlanStatusIcon status={step.status} />
              </div>
              <div className={cn('min-w-0 flex-1 leading-[1.5]', compact ? 'text-[11px]' : 'text-[12px]', textClass)}>
                {step.step}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
