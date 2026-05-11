/**
 * Shared transport health tracker for IM channel listen / connect loops.
 *
 * Solves three problems each channel was reinventing:
 *
 *  1. **Exponential backoff** — initial → max with doubling between attempts,
 *     reset on success.
 *  2. **Log throttling** — continuous failures emit a log line only when the
 *     retry-delay bucket changes (1s → 2s → 4s → …), so identical failures
 *     don't flood the journal once per attempt.
 *  3. **Sustained-failure notice** — after a configurable threshold (5 min
 *     by default) of uninterrupted failures, emit a one-shot warn-level
 *     line pointing the operator at the relevant config. Retries continue
 *     indefinitely — the notice is informational, not a stop signal.
 *
 * Usage (long-poll style):
 *
 * ```ts
 * const health = new ChannelHealth({ label: 'Weixin', opAction: 'polling',
 *   initialDelayMs: 1_000, maxDelayMs: 60_000,
 *   sustainedFailureHint: 'verify baseUrl / token / accountId',
 *   log: (msg, level) => this.log(msg, level) });
 *
 * while (!stopping) {
 *   try {
 *     await poll();
 *     health.recordSuccess();
 *     // …process result…
 *   } catch (err) {
 *     if (stopping || isAbort(err)) break;
 *     await sleep(health.recordFailure(err));
 *   }
 * }
 * ```
 */

export type ChannelHealthLogLevel = 'info' | 'warn' | 'error';
export type ChannelHealthLogger = (msg: string, level: ChannelHealthLogLevel) => void;

export interface ChannelHealthOpts {
  /** Channel display name in logs (e.g. "Weixin", "Telegram"). */
  label: string;
  /** Action verb for the transient-failure log (e.g. "polling", "WS start"). */
  opAction: string;
  /** Initial retry delay in ms. */
  initialDelayMs: number;
  /** Maximum retry delay in ms. */
  maxDelayMs: number;
  /** Sink for emitted log lines. */
  log: ChannelHealthLogger;
  /**
   * Threshold (ms) for the one-shot sustained-failure notice. Defaults to
   * 5 minutes. The notice fires once when continuous-failure duration
   * crosses this; recordSuccess() arms it again.
   */
  sustainedThresholdMs?: number;
  /** Operator hint included in the sustained-failure notice. */
  sustainedFailureHint?: string;
  /**
   * Log level for per-bucket transient failure messages. Defaults to 'warn'.
   * Use 'error' only if the channel has historically logged retries at
   * error level and operators grep for that.
   */
  transientFailureLevel?: ChannelHealthLogLevel;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

export class ChannelHealth {
  private readonly label: string;
  private readonly opAction: string;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly log: ChannelHealthLogger;
  private readonly sustainedThresholdMs: number;
  private readonly sustainedFailureHint: string;
  private readonly transientFailureLevel: ChannelHealthLogLevel;

  private delayMs: number;
  private consecutiveFailures = 0;
  private firstFailureAt: number | null = null;
  private lastLoggedDelayMs = 0;
  private sustainedNoticeFired = false;

  constructor(opts: ChannelHealthOpts) {
    this.label = opts.label;
    this.opAction = opts.opAction;
    this.initialDelayMs = opts.initialDelayMs;
    this.maxDelayMs = opts.maxDelayMs;
    this.log = opts.log;
    this.sustainedThresholdMs = opts.sustainedThresholdMs ?? 5 * 60_000;
    this.sustainedFailureHint = opts.sustainedFailureHint ?? '';
    this.transientFailureLevel = opts.transientFailureLevel ?? 'warn';
    this.delayMs = opts.initialDelayMs;
  }

  /**
   * Mark the operation as currently succeeding. Resets backoff state and,
   * if there were prior failures, emits an info-level recovery line.
   */
  recordSuccess(): void {
    if (this.consecutiveFailures > 0 && this.firstFailureAt !== null) {
      const downtimeMs = Date.now() - this.firstFailureAt;
      this.log(
        `${this.label}: connection recovered after ${Math.round(downtimeMs / 1000)}s `
          + `(${this.consecutiveFailures} failed attempts)`,
        'info',
      );
    }
    this.delayMs = this.initialDelayMs;
    this.consecutiveFailures = 0;
    this.firstFailureAt = null;
    this.lastLoggedDelayMs = 0;
    this.sustainedNoticeFired = false;
  }

  /**
   * Record a failure. Emits the per-bucket failure log (throttled) and the
   * one-shot sustained-failure notice when applicable, then advances the
   * backoff for the *next* failure. Returns the delay (ms) the caller
   * should sleep before its next attempt.
   */
  recordFailure(error: unknown): number {
    this.consecutiveFailures += 1;
    if (this.firstFailureAt === null) this.firstFailureAt = Date.now();
    const elapsedMs = Date.now() - this.firstFailureAt;
    const delayMs = this.delayMs;

    if (delayMs !== this.lastLoggedDelayMs) {
      this.log(
        `${this.label} ${this.opAction} failed (retrying in ${Math.ceil(delayMs / 1000)}s): ${describeError(error)}`,
        this.transientFailureLevel,
      );
      this.lastLoggedDelayMs = delayMs;
    }

    if (!this.sustainedNoticeFired && elapsedMs >= this.sustainedThresholdMs) {
      this.sustainedNoticeFired = true;
      const hint = this.sustainedFailureHint ? ` — ${this.sustainedFailureHint}` : '';
      this.log(
        `⚠ ${this.label}: connection has been failing for ${Math.round(elapsedMs / 60_000)}+ min `
          + `(${this.consecutiveFailures} attempts)${hint}. Retries continue at ${Math.ceil(delayMs / 1000)}s intervals.`,
        'warn',
      );
    }

    this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
    return delayMs;
  }

  /** Current consecutive failure count. */
  get failureCount(): number {
    return this.consecutiveFailures;
  }
}
