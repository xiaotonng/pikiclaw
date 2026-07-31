import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult, DriverEvent, TuiInput, TuiSpec, NativeSessionInfo } from '../contracts/driver.js';
import type { UniversalUsage, UniversalPlan, UniversalSubAgent } from '../protocol/index.js';
import { ClaudeWarmPool } from './claude-pool.js';
import { claudeAnchorResolvable, claudeTranscriptTailAnchor, discoverClaudeNativeSessions, encodeClaudeProjectDir } from './native.js';
import { attachedFileNote, contextPercent, createLineBuffer, imageMimeForFile, parseJsonLine, reapChild, wireAbort } from './shared.js';

// Real driver: shells the local `claude` CLI in stream-json mode and normalizes its
// events into kernel DriverEvents. Faithful to pikiloom's claude.ts event shapes
// (system / stream_event{message_start,content_block_delta,message_delta} / assistant / result),
// but fully self-contained. Proves "下层 Claude 不变".
export interface ClaudeDriverOptions {
  /** Keep the CLI process alive after a clean turn and reuse it for the session's next
   *  continuation turn (skips the ~4s spawn+init). Off by default: a parked process holds
   *  real memory and keeps the event loop alive, which a one-shot embedder must not inherit
   *  silently. Long-lived hosts opt in and call dispose() on shutdown. */
  warmPool?: boolean;
}

export class ClaudeDriver implements AgentDriver {
  readonly id = 'claude';
  readonly capabilities = { steer: true, interact: false, resume: true, tui: true, fork: true, rewind: true };
  private readonly pool: ClaudeWarmPool | null;
  /**
   * Every `-p` child this driver has spawned that has not exited yet — parked, mid-turn, or
   * released-but-still-shutting-down. The pool only ever knows about PARKED processes, so a
   * `dispose()` that walked the pool alone left the other two states running: on shutdown an
   * in-flight turn's CLI got no signal at all, and one released by a background-work settle was
   * already unreferenced. Entries remove themselves on `exit`, so this never grows unbounded.
   */
  private readonly spawned = new Set<ChildProcess>();

  constructor(private readonly bin: string = 'claude', opts: ClaudeDriverOptions = {}) {
    this.pool = opts.warmPool ? new ClaudeWarmPool() : null;
  }

  /** Reap every process this driver still owns — parked, running, or draining.
   *  Long-lived hosts call this on shutdown. */
  dispose(): void {
    this.pool?.dispose();
    for (const child of [...this.spawned]) reapChild(child, { graceMs: 0 });
  }

  /** Track a child until it exits, so {@link dispose} can always find it. */
  private track(child: ChildProcess): void {
    this.spawned.add(child);
    child.once('exit', () => this.spawned.delete(child));
  }

  /** Live `-p` processes this driver still owns (tests + telemetry). */
  liveProcessCount(): number {
    return this.spawned.size;
  }

  /** Parked warm processes right now (tests + telemetry). */
  warmPoolSize(): number {
    return this.pool?.size() ?? 0;
  }

  // Interactive Claude Code TUI (no -p): the kernel spawns this in a PTY and passes
  // the terminal through. Model/resume/BYOK-env come from the kernel's resolution.
  tui(input: TuiInput): TuiSpec {
    const args: string[] = [];
    if (input.model) args.push('--model', input.model);
    // Fresh-pin wins over resume: `--session-id <uuid>` makes Claude start a NEW session and
    // write its transcript under the given id, so the host already knows the resumable key
    // before spawn (terminal-first new session). Falls back to `--resume` for an existing one.
    if (input.newSessionId) args.push('--session-id', input.newSessionId);
    else if (input.sessionId) args.push('--resume', input.sessionId);
    if (input.extraArgs?.length) args.push(...input.extraArgs);
    return { command: this.bin, args, cwd: input.workdir, env: input.env };
  }

  listNativeSessions(opts: { workdir: string; limit?: number }): NativeSessionInfo[] {
    return discoverClaudeNativeSessions(opts.workdir, { limit: opts.limit });
  }

  run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
    const steerable = !!input.steerable;
    // Always drive Claude over a stream-json stdin and keep that stdin OPEN for the whole turn.
    // That open stdin is what lets Claude's native "launch detached background work → end the
    // turn → wake itself up and report when the work finishes" flow play out: it only happens
    // while stdin stays open (with it closed, Claude exits at the first `result` and the wake-up
    // — and any in-process background agent/workflow — is lost). Image attachments also need the
    // stream-json user message (a plain text stdin can't carry images). `--replay-user-messages`
    // + registerSteer remain the only mid-turn-steer-specific bits.
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--input-format', 'stream-json'];
    if (input.model) args.push('--model', input.model);
    if (input.effort) args.push('--effort', input.effort === 'ultra' ? 'max' : input.effort); // request extended thinking (ultra is a display-only alias for max)
    if (input.sessionId) args.push(...claudeResumeArgs(input.sessionId, input.fork, input.rewind));
    if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);
    if (input.mcpConfigPath) args.push('--mcp-config', input.mcpConfigPath);
    if (input.permissionMode) args.push('--permission-mode', input.permissionMode); // parity: keep bypass/accept-edits on the kernel path
    if (steerable) args.push('--replay-user-messages'); // parity: mid-turn steer
    if (input.extraArgs?.length) args.push(...input.extraArgs);

    // Warm reuse: a rewind rebranches the session's transcript, so a parked process's
    // in-memory conversation is stale — destroy it. A fork never touches the parent's
    // transcript (the parked parent stays valid); the fork turn itself must cold-spawn
    // for its --fork-session flags. Only a plain continuation may reclaim a process, and
    // only when the spawn fingerprint still matches what a cold spawn would use now.
    const fingerprint = claudeProcessFingerprint(this.bin, input);
    if (input.rewind && input.sessionId) this.pool?.evictSession(input.sessionId);
    const pooled = (!input.fork && !input.rewind && input.sessionId && this.pool)
      ? this.pool.take(input.sessionId, fingerprint)
      : null;

    const state = {
      text: '', reasoning: '', streamedText: false, streamedReasoning: false,
      // Dangling-tool-loop tracking: sawToolResult flips on the first tool_result; textSinceToolResult
      // goes false at every tool_result and true again once the model streams visible text.
      sawToolResult: false, textSinceToolResult: false,
      // Wall-clock of the last parsed stream event — the hold cap defers while this is fresh.
      lastEventAt: Date.now(),
      sessionId: null as string | null, model: null as string | null,
      // Fork anchor: uuid of the latest REAL assistant transcript record seen this turn —
      // the inclusive keep-boundary a later fork of this session passes to --resume-session-at.
      anchor: null as string | null,
      stopReason: null as string | null, error: null as string | null,
      input: null as number | null, output: null as number | null, cached: null as number | null,
      cacheCreation: null as number | null,
      contextWindow: null as number | null, turnOutputTokensBase: 0, thinkingEstTokens: 0,
      subAgents: new Map<string, any>(),
      tools: new Map<string, { name: string; summary: string }>(),
      taskList: new Map<string, { subject: string; status: string }>(),
      taskOrder: [] as string[],
      pendingTaskCreates: new Map<string, { subject: string }>(),
      todoPlan: null as UniversalPlan | null,
      seenImages: new Set<string>(),
      // run_in_background lifecycle: task ids seen as started vs. reached a terminal status;
      // bgAgentTasks marks the sub-agent-backed ones (they earn the longer hold cap).
      bgStarted: new Set<string>(), bgTerminal: new Set<string>(), bgAgentTasks: new Set<string>(),
      // Background sub-agents: task/agent id → the launching tool_use id (the s.subAgents key),
      // and per-sub tail state for live-reading the sub's own transcript (see the tail poller —
      // a background sub's activity NEVER reaches the parent stream, tailing is the only source).
      bgTaskSub: new Map<string, string>(),
      subTails: new Map<string, ClaudeSubTail>(),
    };

    return new Promise<DriverResult>((resolve) => {
      let child: ChildProcess;
      let transport: 'cold' | 'warm' = 'cold';
      let promptDelivered = false;
      let settled = false;
      // One-shot guard for the truncated-turn recovery injection (see the result handler).
      let truncatedRecoveryAttempted = false;
      // Bounded counter for the no-op-resume recovery re-injection (see the result handler): a
      // resume of a session left incomplete by a prior turn can no-op several times before the
      // CLI's repair clears and it runs our prompt for real.
      let noopResumeRetries = 0;
      // holdCap: hard backstop while a background task is still running (never-completing daemon).
      // quiet: fires once all known background tasks finished AND Claude has gone quiet, so trailing
      // wake-up turns can still land before we close (see claudeBgSettleQuietMs).
      let holdCapTimer: ReturnType<typeof setTimeout> | null = null;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      // subTail: live tail of background sub-agents' own transcripts — the ONLY place their
      // activity is observable (see pollClaudeSubAgentTails). Armed once the first async sub
      // registers; cleared (after a final sweep) at settle.
      let subTailTimer: ReturnType<typeof setInterval> | null = null;
      // modelStall: watchdog that fires only while the turn is waiting on the MODEL with nothing
      // streaming — the initial wait after the prompt, or after a tool_result handed control back —
      // never while a tool or background task is still running (see armModelStall / armModelStallIfIdle).
      let modelStallTimer: ReturnType<typeof setTimeout> | null = null;
      const usageOf = () => this.usage(state);
      const unref = (tm: any) => { if (tm && typeof tm.unref === 'function') tm.unref(); };
      let disposeAbort: (() => void) | null = null;
      let detachTurnListeners: () => void = () => { /* set once listeners exist */ };
      const clearHoldCap = () => { if (holdCapTimer) { clearTimeout(holdCapTimer); holdCapTimer = null; } };
      const clearQuiet = () => { if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; } };
      const clearModelStall = () => { if (modelStallTimer) { clearTimeout(modelStallTimer); modelStallTimer = null; } };
      const clearSubTail = () => { if (subTailTimer) { clearInterval(subTailTimer); subTailTimer = null; } };
      // A launch notice normally names the sub's transcript (output_file); when that line is
      // absent, derive the canonical side-transcript path once agentId + sessionId are known.
      const fillSubTailFiles = () => {
        for (const tail of state.subTails.values()) {
          if (!tail.file && tail.agentId && state.sessionId) {
            tail.file = join(homedir(), '.claude', 'projects', encodeClaudeProjectDir(input.workdir), state.sessionId, 'subagents', `agent-${tail.agentId}.jsonl`);
          }
        }
      };
      const pollSubTails = () => {
        try { fillSubTailFiles(); pollClaudeSubAgentTails(state, ctx.emit); } catch { /* observe-only — never break the turn */ }
      };
      const armSubTail = () => {
        if (subTailTimer || !state.subTails.size) return;
        subTailTimer = setInterval(() => { if (settled) { clearSubTail(); return; } pollSubTails(); }, claudeSubTailPollMs());
        unref(subTailTimer);
      };
      // kill=true SIGTERMs immediately — fast exit, used once nothing is left running in the
      // background (a normal turn, or a wake-up turn after every background task finished).
      // kill=false only ends stdin and lets Claude shut down on its own, so any still-running
      // detached background work survives a clean exit (a hard kill mid-flight is exactly what
      // tore the background — and the wake-up — down before). A leak-guard SIGTERM is the backstop.
      const finish = (r: DriverResult, kill = true, park = false) => {
        if (settled) return; settled = true;
        clearHoldCap(); clearQuiet(); clearModelStall();
        // Final tail sweep BEFORE resolving: tools the subs wrote since the last tick still make
        // it into the turn's live trail (the runtime folds emitted events until run() resolves).
        if (state.subTails.size) { pollSubTails(); }
        clearSubTail();
        disposeAbort?.();
        // Park instead of kill: only a CLEAN settle qualifies (ok, no error, no abort, the
        // process still healthy, session known) — every other exit keeps today's semantics,
        // so pooling can never leak a wedged or errored process.
        if (park && this.pool && state.sessionId && r.ok && !r.error && !ctx.signal.aborted
            && child && !child.killed && child.exitCode == null) {
          detachTurnListeners();
          this.pool.put(state.sessionId, fingerprint, child);
          resolve({ ...r, transport });
          return;
        }
        try { child?.stdin?.end(); } catch { /* ignore */ }
        if (child && !child.killed && child.exitCode == null) {
          // Reap rather than fire-and-forget: one SIGTERM with nothing watching is how a
          // wedged CLI became an unowned resident process (see reapChild). kill=true wants
          // the SIGTERM now; kill=false grants the transcript-flush grace first.
          reapChild(child, { graceMs: kill ? 0 : CLAUDE_EXIT_LEAK_GUARD_MS });
        }
        resolve({ ...r, transport });
      };
      const settleResult = (opts: { stopReason?: string | null; kill?: boolean; ok?: boolean; park?: boolean } = {}) => finish({
        ok: opts.ok ?? !state.error, text: state.text, reasoning: state.reasoning || undefined,
        error: state.error, stopReason: opts.stopReason ?? state.stopReason, sessionId: state.sessionId, anchor: state.anchor, usage: usageOf(),
      }, opts.kill ?? true, opts.park ?? false);
      // Cap while holding for a still-running background task (stopReason marks it as
      // "still running in the background" so the terminal presentation reads right). Idempotent —
      // the countdown is absolute from the first arm. Sub-agent-backed holds use the longer
      // agent cap, and a cap that fires while events are still flowing defers instead of
      // cutting an actively-working turn mid-generation (the 2026-07-06 "停止不再继续生成":
      // the 10-min cap yanked a live research turn 22s after its last tool_result and the
      // graceful-close leak guard then killed the 4 still-running Explore agents).
      const armHoldCap = () => {
        if (holdCapTimer) return;
        const capMs = claudeTurnHasAgentBackground(state) ? claudeBgAgentHoldCapMs() : claudeBgHoldCapMs();
        const fire = () => {
          holdCapTimer = null;
          if (settled) return;
          if (Date.now() - (state.lastEventAt ?? 0) < claudeBgSettleQuietMs()) {
            holdCapTimer = setTimeout(fire, claudeBgHoldRecheckMs());
            unref(holdCapTimer);
            return;
          }
          settleResult({ stopReason: 'background', kill: false });
        };
        holdCapTimer = setTimeout(fire, capMs);
        unref(holdCapTimer);
      };
      // Grace close once all background work is done: settle gracefully (no kill) if Claude stays
      // quiet for the window. Re-armed on every event, so a still-streaming wake-up keeps it open.
      // park: by the time this fires every background task has reported terminal AND Claude has
      // been silent for the whole quiet window, so the process is idle-and-healthy — exactly the
      // state the pool wants. Withholding it here was the process leak's other half: a turn that
      // used run_in_background TOOK the parked process out of the pool and never put it back, so
      // the session's next turn always cold-spawned (measured 78% of continuations) while the
      // taken process was released unowned. finish() still re-checks health before parking.
      const armQuiet = () => {
        clearQuiet();
        quietTimer = setTimeout(() => { if (!settled) settleResult({ kill: false, park: true }); }, claudeBgSettleQuietMs());
        unref(quietTimer);
      };
      // Model-stall watchdog: while the turn waits on the model with nothing streaming, the model
      // normally emits its next message within a couple of seconds. If instead it goes fully silent —
      // no stream/assistant events — the turn is stuck waiting on the MODEL (a provider stall,
      // rate-limit backoff, or an unreachable model that the CLI is silently retrying), NOT on a tool
      // (a running tool has no tool_result yet, so this is never armed then) and NOT on background work
      // (its own hold, re-checked below). Left alone the kernel turn hangs forever with the answer never
      // delivered. Bound it: settle gracefully (no kill) as incomplete with stopReason 'stalled' so the
      // terminal shows a clear "resend to continue" note instead of a dead spinner. Armed for the initial
      // wait (after prompt delivery) and after a tool_result, and re-armed (if idle) on an API-error
      // event; cleared the moment the model emits REAL output.
      const armModelStall = () => {
        clearModelStall();
        modelStallTimer = setTimeout(() => {
          if (settled) return;
          // Background work legitimately produces no stream events; keep waiting (the bg hold owns it).
          if (pendingClaudeBackgroundTasks(state) > 0) { armModelStall(); return; }
          settleResult({ stopReason: 'stalled', kill: false, ok: false });
        }, claudeModelStallMs(input.effort));
        unref(modelStallTimer);
      };
      // Arm the watchdog ONLY if it is not already counting — for the INITIAL model wait (right after
      // the prompt is delivered) and for API-error events. Unlike `armModelStall` it never resets a
      // running countdown, so a model that stays unreachable across many retry artifacts still trips
      // the stall on its original deadline instead of being deferred forever.
      const armModelStallIfIdle = () => { if (!modelStallTimer) armModelStall(); };

      // Acquire the process: a reclaimed warm process gets the prompt as its acquisition
      // probe — a dead pipe throws synchronously here and the turn transparently falls
      // back to a cold spawn (whose --resume flags are already in `args`).
      let acquired: ChildProcess | null = null;
      if (pooled) {
        try {
          pooled.stdin!.write(claudeUserMessage(input.prompt, input.attachments) + '\n');
          acquired = pooled; transport = 'warm'; promptDelivered = true;
        } catch { reapChild(pooled, { graceMs: 0 }); }
      }
      if (!acquired) {
        try {
          acquired = spawn(this.bin, args, { cwd: input.workdir, env: { ...process.env, ...(input.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
          this.track(acquired); // a warm process is already tracked from its own cold spawn
        } catch (err: any) {
          finish({ ok: false, text: '', error: `spawn failed: ${err?.message || err}`, stopReason: 'error' });
          return;
        }
      }
      child = acquired;

      // Abort (the user pressed Stop) must actually END the process. A lone SIGTERM here relied on
      // the child's `close` to bring the turn — and any escalation — with it, so a CLI that ignored
      // it left both the turn and the process hanging. Reap escalates to SIGKILL on its own.
      disposeAbort = wireAbort(ctx.signal, () => reapChild(child, { graceMs: 0 }));

      if (steerable) {
        ctx.registerSteer(async (prompt: string, attachments?: string[]) => {
          try { child.stdin!.write(claudeUserMessage(prompt, attachments) + '\n'); return true; } catch { return false; }
        });
      }

      const nextLines = createLineBuffer();
      let stderr = '';
      const onStdout = (chunk: Buffer) => {
        if (settled) return; // ignore the process's post-settle shutdown chatter
        for (const line of nextLines(chunk)) {
          if (settled) return;
          const ev = parseJsonLine(line);
          if (ev === undefined) continue;
          state.lastEventAt = Date.now();
          handleClaudeEvent(ev, state, ctx.emit);
          armSubTail(); // no-op until the first async sub registers a tail
          const pending = pendingClaudeBackgroundTasks(state);
          // Real model output means the model is alive and streaming — cancel the stall watchdog. But an
          // API-error event is NOT progress: the model is unreachable and the CLI is retrying. Keep the
          // watchdog counting (arm it if idle) so a connection that never recovers trips the stall instead
          // of hanging on silent retries — the "24-minute spinner" after a severed model proxy.
          if (ev.type === 'stream_event' || ev.type === 'assistant') {
            if (claudeEventIsApiError(ev)) armModelStallIfIdle();
            else clearModelStall();
          }
          if (ev.type === 'result') {
            clearModelStall();
            const hasError = !!ev.is_error || (Array.isArray(ev.errors) && ev.errors.length > 0) || !!state.error;
            const decision = decideClaudeResultSettle({ hasError, pendingBackground: pending, sawBackground: state.bgStarted.size > 0 });
            if (decision === 'settle') {
              // A clean result that lands while the tool loop is still dangling means the model's
              // closing round came back empty — the turn "completed" but the reply was never
              // generated. First try to self-heal in-process (stdin is still open): inject one
              // recovery prompt and keep reading; the follow-up round delivers the closing reply
              // and its own result settles the turn normally. If recovery is disabled, already
              // attempted, or the write fails, stamp the turn 'truncated' so the terminal can say
              // so instead of showing a narration that stops mid-sentence as the full answer.
              if (!hasError && claudeTurnEndedDangling(state)) {
                if (claudeTruncatedRecoveryEnabled() && !truncatedRecoveryAttempted) {
                  truncatedRecoveryAttempted = true;
                  let injected = false;
                  try { child.stdin!.write(claudeUserMessage(CLAUDE_TRUNCATED_RECOVERY_PROMPT) + '\n'); injected = true; } catch { /* fall through to settle */ }
                  if (injected) { armModelStall(); continue; }
                }
                settleResult({ stopReason: 'truncated', kill: false });
                return;
              }
              // No-op resume repair: resuming a session whose previous turn was left incomplete (a
              // background hold that reclaimed its sub-agents/workflow — the ultra "no response"
              // report — an interrupt, a stall) makes the CLI answer with a synthetic "No response
              // requested." no-op that ran NONE of our prompt (no model turn at all), instead of
              // processing the message. Settling here delivers a silent "(no textual response)" and
              // drops the user's send. stdin is still open: re-issue the prompt so the CLI drives
              // through its repair to a real answer within this one turn. Bounded (the repair can
              // no-op more than once); the post-tool stall watchdog is the backstop if the CLI never
              // engages. Scoped to resumes (input.sessionId) — a fresh session has no dangling turn.
              // Excludes local slash commands (isClaudeSlashCommand): /compact, /clear & friends are
              // LEGITIMATELY output-empty (their effect is a local action, not an assistant reply), so
              // the emptiness that flags a dropped send is normal for them. Re-issuing one is never a
              // repair — for /compact it just fires a second compaction that reports "Not enough
              // messages to compact." A real dropped send is a plain prompt and still self-heals.
              if (!hasError && !!input.sessionId && !claudeProducedRealOutput(state)
                  && !isClaudeSlashCommand(input.prompt)
                  && noopResumeRetries < claudeResumeNoopRetryLimit()) {
                noopResumeRetries++;
                let injected = false;
                try { child.stdin!.write(claudeUserMessage(input.prompt, input.attachments) + '\n'); injected = true; } catch { /* fall through to settle */ }
                if (injected) { armModelStall(); continue; }
              }
              // kill=false: the CLI persists the turn into the session jsonl AFTER emitting
              // `result`, and on a large session that flush (a whole-file rewrite) takes long
              // enough that an immediate SIGTERM kills the process mid-write — the reply was
              // DELIVERED live but never lands in the transcript, so the next re-render erases
              // it (the "对话结束之后就被吞了" shape, caught by the turn audit). Ending stdin
              // lets the CLI finish writing and exit on its own; the leak-guard SIGTERM is the
              // backstop. park: this clean settle is the ONE warm-pool-eligible exit — the
              // process (stdin open, transcript flushing in its own time) is parked for the
              // session's next turn instead of being shut down; finish() re-checks health.
              settleResult({ kill: false, park: true }); return;
            }
            if (decision === 'hold') { clearQuiet(); armHoldCap(); continue; }
            // 'quiet-settle': every known background task finished, but Claude may still be delivering
            // wake-up turns whose delivery trails the completion status (with parallel agents the last
            // one's completion can land before an earlier one's wake-up result). Don't exit here — wait
            // for Claude to go quiet, then close gracefully so no in-flight wake-up is torn down. Keep
            // the hold cap armed as an absolute backstop.
            armHoldCap(); armQuiet();
            continue;
          }
          // Non-result activity: a still-streaming wake-up refreshes the quiet window; a newly-started
          // background task pulls us back into the hold.
          if (quietTimer) {
            if (pending > 0) { clearQuiet(); armHoldCap(); }
            else armQuiet();
          }
          // A tool_result handed control back to the model with no background pending — arm the
          // post-tool stall watchdog. Cleared above the moment the model's next event streams in.
          if (ev.type === 'user' && pending === 0 && claudeUserEventHasToolResult(ev)) armModelStall();
        }
      };
      const onStderr = (c: Buffer) => { stderr += c.toString('utf8'); };
      const onError = (err: Error) => finish({ ok: false, text: state.text, error: `claude spawn error: ${err.message}`, stopReason: 'error' });
      const onClose = (code: number | null) => {
        if (settled) return;
        if (ctx.signal.aborted) { finish({ ok: false, text: state.text, reasoning: state.reasoning, error: 'Interrupted by user.', stopReason: 'interrupted', sessionId: state.sessionId, anchor: state.anchor, usage: usageOf() }, false); return; }
        const ok = !state.error && code === 0;
        // A clean exit with no result while the tool loop dangles is the same swallowed-reply
        // shape as the result-event case above — stamp it so it can't pass as a full answer.
        // (state.stopReason is typically the tool round's leftover 'tool_use' here, so the
        // dangling check must win over it.)
        const stopReason = (ok && claudeTurnEndedDangling(state)) ? 'truncated' : state.stopReason;
        finish({ ok, text: state.text, reasoning: state.reasoning || undefined, error: state.error || (ok ? null : `claude exited ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`), stopReason, sessionId: state.sessionId, anchor: state.anchor, usage: usageOf() }, false);
      };
      // Parking hands the process to the pool — these turn-scoped listeners must not
      // outlive the turn (the pool installs its own drain + close bookkeeping).
      detachTurnListeners = () => {
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('error', onError);
        child.off('close', onClose);
      };
      child.stdout!.on('data', onStdout);
      child.stderr!.on('data', onStderr);
      child.on('error', onError);
      child.on('close', onClose);

      if (!promptDelivered) {
        try {
          // Send the prompt as a stream-json user message and keep stdin OPEN (do not end it here):
          // closing it makes Claude exit at the first `result`, before any background task finishes.
          child.stdin!.write(claudeUserMessage(input.prompt, input.attachments) + '\n');
        } catch { /* ignore */ }
      }
      // Arm the model-stall watchdog for the INITIAL wait: the prompt is now delivered (warm or cold) and
      // we are waiting on the model's FIRST output. The first real stream/assistant event clears it; if the
      // model never answers — a severed model proxy (e.g. a mid-turn host restart) — it settles the turn as
      // 'stalled' instead of spinning until Claude exhausts its own retry budget minutes later. Previously
      // the watchdog only armed AFTER a tool_result, so an initial wait on a dead connection hung unbounded.
      if (!settled) armModelStallIfIdle();
    });
  }

  private usage(s: ClaudeUsageState): UniversalUsage {
    return claudeUsageOf(s);
  }

  // Current tail keep-boundary of a native session: the uuid of the last user/assistant
  // record in its transcript. Pins a tail fork at fork time (see AgentDriver contract).
  resolveNativeAnchor(opts: { sessionId: string; workdir: string }): string | null {
    return claudeTranscriptTailAnchor(opts.workdir, opts.sessionId);
  }

  // `--resume-session-at` only accepts a record claude still hydrates: the active leaf chain back
  // to the last /compact boundary (see AgentDriver contract).
  anchorResolvable(opts: { sessionId: string; workdir: string; anchor: string }): boolean {
    return claudeAnchorResolvable(opts.workdir, opts.sessionId, opts.anchor);
  }
}

// The spawn-time facts that must still match for a parked warm process to serve a
// continuation turn as if it were a fresh cold `--resume` — any drift (model switch,
// effort change, new MCP config, different BYOK env, …) destroys the parked process so
// the new configuration actually applies. `sessionId` is the pool key, not fingerprint
// material, and `systemPrompt` is deliberately EXCLUDED: it is a first-turn-only input
// (the parked process already carries it applied; a cold --resume would not re-send it
// either), so including it would make every continuation miss the pool. Pure + exported
// for hermetic testing.
export function claudeProcessFingerprint(bin: string, input: AgentTurnInput): string {
  return JSON.stringify([
    bin, input.workdir, input.model ?? null, input.effort ?? null,
    input.mcpConfigPath ?? null, input.permissionMode ?? null, !!input.steerable,
    fingerprintExtraArgs(input.extraArgs),
    Object.entries(input.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
}

// `--session-id <uuid>` pins a FRESH session's native id and is contributed on the first
// turn only (continuations resume instead) — it names the session, it doesn't configure
// the process. Like sessionId itself it must not be fingerprint material, or every
// continuation of a session born with it would miss the pool forever.
function fingerprintExtraArgs(extraArgs: string[] | undefined): string[] {
  const args = extraArgs ?? [];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-id') { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

// The --resume flag family for one turn: plain resume appends to the session; a fork branches
// a NEW session off it (--fork-session), optionally cut at an inclusive keep-boundary record
// uuid (--resume-session-at); a rewind cuts at that boundary WITHOUT --fork-session, so claude
// rebranches the SAME session in place (the transcript is a parentUuid tree — the dropped tip
// becomes a dead sibling and leaves the active path). Pure so tests pin the arg contract.
export function claudeResumeArgs(
  sessionId: string,
  fork?: { anchor?: string | null } | null,
  rewind?: { anchor?: string | null } | null,
): string[] {
  const args = ['--resume', sessionId];
  if (fork) {
    args.push('--fork-session');
    if (fork.anchor) args.push('--resume-session-at', fork.anchor);
  } else if (rewind?.anchor) {
    args.push('--resume-session-at', rewind.anchor);
  }
  return args;
}

// ── Token usage / context projection (ported from pikiloom's claude driver) ──────
// Claude reports per-message usage; the live UI wants three derived signals the raw
// counts don't carry: context-window %, cumulative context tokens, and this turn's
// output. Computing them here (not just inputTokens/outputTokens) is what restores the
// live "xx.x% · NNk · ↑NN" row the kernel path previously dropped.

interface ClaudeUsageState {
  input: number | null; output: number | null; cached: number | null;
  cacheCreation?: number | null; contextWindow?: number | null; turnOutputTokensBase?: number | null;
  thinkingEstTokens?: number | null;
}

function claudeUsageOf(s: ClaudeUsageState): UniversalUsage {
  // While a message is still streaming, the CLI's live thinking estimate (system/thinking_tokens)
  // is often the ONLY output signal — subscription accounts stream no plaintext thinking and no
  // usage until the message settles. Fold it into the derived numbers (never into the raw
  // outputTokens) so the row ticks during silent extended thinking; the real per-message
  // output_tokens supersedes it at message_delta.
  const effOutput = Math.max(s.output ?? 0, s.thinkingEstTokens ?? 0);
  const used = (s.input ?? 0) + (s.cached ?? 0) + (s.cacheCreation ?? 0) + effOutput;
  const turnOutput = (s.turnOutputTokensBase ?? 0) + effOutput;
  return {
    inputTokens: s.input,
    outputTokens: s.output,
    cachedInputTokens: s.cached,
    contextUsedTokens: used > 0 ? used : null,
    contextPercent: contextPercent(used > 0 ? used : null, s.contextWindow ?? null),
    turnOutputTokens: turnOutput > 0 ? turnOutput : null,
  };
}

// Accumulate the CLI's live thinking-token estimate onto driver state. Prefer the per-event
// delta (correct whether the CLI's running total is per-message or per-turn); fall back to a
// monotonic max of the running total. Returns true when the estimate advanced.
function applyClaudeThinkingEstimate(s: any, ev: any): boolean {
  const prev = s.thinkingEstTokens ?? 0;
  const delta = Number(ev?.estimated_tokens_delta);
  const total = Number(ev?.estimated_tokens);
  if (Number.isFinite(delta) && delta > 0) s.thinkingEstTokens = prev + delta;
  else if (Number.isFinite(total)) s.thinkingEstTokens = Math.max(prev, total);
  return (s.thinkingEstTokens ?? 0) > prev;
}

// Advertised context window by Claude model id (best-effort; unknown -> null so the
// percent simply stays absent rather than wrong). Anchor-free so vendor-prefixed ids
// (us.anthropic.claude-…) still match.
function claudeContextWindowFromModel(model: unknown): number | null {
  const id = String(model ?? '').trim().toLowerCase();
  if (!id) return null;
  if (id === 'haiku' || /claude-haiku-/.test(id)) return 200_000;
  if (id === 'opus' || id === 'sonnet' || id === 'fable') return 1_000_000;
  if (/claude-(opus|sonnet)-/.test(id) || /claude-fable-/.test(id)) return 1_000_000;
  return null;
}

// Usable window = advertised minus Claude's max-output (20k) + autocompact (13k) reserve.
const CLAUDE_USABLE_WINDOW_RESERVE = 33_000;
function claudeEffectiveContextWindow(advertised: number | null): number | null {
  if (advertised == null) return null;
  return advertised <= CLAUDE_USABLE_WINDOW_RESERVE ? advertised : advertised - CLAUDE_USABLE_WINDOW_RESERVE;
}

// Parse one claude stream-json event into kernel DriverEvents (pure + exported for
// hermetic testing). Faithful to pikiloom's claudeParse shapes.
export function handleClaudeEvent(ev: any, s: any, emit: (e: DriverEvent) => void): void {
  const t = ev.type || '';
  // Child events of a spawned sub-agent are tagged with parent_tool_use_id; route their
  // tool_uses into that sub-agent rather than the main turn (mirrors pikiloom).
  const parentId: string | null = (typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id) ? ev.parent_tool_use_id : null;
  if (parentId) {
    const sub: UniversalSubAgent | undefined = s.subAgents?.get?.(parentId);
    if (sub) {
      // Inline sub events and the transcript tail are two views of the SAME activity (which one
      // flows depends on the CLI version and run mode) — share one accumulator so tools never
      // double up and timestamps/usage fold identically whichever source delivers first.
      const tail = ensureClaudeSubTail(s, sub);
      if (t === 'assistant') {
        for (const b of (ev.message?.content || [])) {
          if (b?.type !== 'tool_use') continue;
          const id = String(b.id || '');
          if (!id || tail.seenTools.has(id)) continue;
          tail.seenTools.add(id);
          const name = String(b.name || 'Tool');
          sub.tools.push({ id, name, summary: summarizeToolUse(name, b.input) });
        }
        const m = ev.message?.model; if (typeof m === 'string' && m.trim()) sub.model = m;
        foldClaudeSubEventFacts(ev, sub, tail);
        emit({ type: 'subagent', subagent: { ...sub, tools: [...sub.tools] } });
      } else if (t === 'user') {
        // Inline sub tool_results carry timestamps — they extend the sub's wall-clock span.
        if (foldClaudeSubEventFacts(ev, sub, tail)) emit({ type: 'subagent', subagent: { ...sub, tools: [...sub.tools] } });
      } else if (t === 'system' && typeof ev.model === 'string' && ev.model.trim()) {
        sub.model = ev.model;
        emit({ type: 'subagent', subagent: { ...sub, tools: [...sub.tools] } });
      }
    }
    return;
  }
  if (t === 'system') {
    trackClaudeBackgroundTask(ev, s, emit);
    if (ev.session_id && ev.session_id !== s.sessionId) { s.sessionId = ev.session_id; emit({ type: 'session', sessionId: ev.session_id }); }
    s.model = ev.model ?? s.model;
    s.contextWindow = claudeEffectiveContextWindow(claudeContextWindowFromModel(s.model)) ?? s.contextWindow;
    // Claude compacted the running context (subtype `compact_boundary`): `trigger` is
    // `auto` (the context filled up) or `manual` (a `/compact` command). Surface it live
    // so a terminal can show a "compacting" affordance; the compacted summary itself lands
    // in the native transcript and settles into a divider separately.
    if (ev.subtype === 'compact_boundary') {
      const meta = (ev.compact_metadata ?? {}) as { trigger?: string; pre_tokens?: number };
      emit({ type: 'compaction', trigger: meta.trigger === 'manual' ? 'manual' : 'auto', atTokens: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : null });
      return;
    }
    // Live thinking progress (system/thinking_tokens, ~every 1.4s of sustained thinking): during
    // extended thinking a subscription account streams no plaintext (signature_delta only) and no
    // usage until the message settles, so without projecting these the terminal shows a dead
    // spinner for the whole thinking phase.
    if (ev.subtype === 'thinking_tokens' && applyClaudeThinkingEstimate(s, ev)) {
      emit({ type: 'usage', usage: claudeUsageOf(s) });
    }
    return;
  }
  if (t === 'stream_event') {
    const inner = ev.event || {};
    if (inner.type === 'message_start') {
      const u = inner.message?.usage;
      // Claude emits one message per tool-use round within a single turn. Carry the prior
      // message's output into the per-turn base, then reset to the new message's prompt size
      // so contextUsedTokens tracks current occupancy while turnOutputTokens sums the turn.
      // A message that never delivered real output_tokens keeps its thinking estimate as the carry.
      s.turnOutputTokensBase = (s.turnOutputTokensBase ?? 0) + Math.max(s.output ?? 0, s.thinkingEstTokens ?? 0);
      s.input = u?.input_tokens ?? 0;
      s.cached = u?.cache_read_input_tokens ?? 0;
      s.cacheCreation = u?.cache_creation_input_tokens ?? 0;
      s.output = 0;
      s.thinkingEstTokens = 0;
      // The prompt-side counts are known the moment the model accepts the request — emit them so
      // the context row appears right away instead of only after the first message settles
      // (minutes into a long silent thinking phase, the "looks stuck" report).
      emit({ type: 'usage', usage: claudeUsageOf(s) });
    } else if (inner.type === 'content_block_start') {
      // Claude emits multiple text/thinking blocks per turn (one set per tool-use round). Insert a
      // paragraph break before a NEW block when prior content exists, so the live preview shows
      // breaks between segments instead of running them together. Mirrors the legacy driver; the
      // separator is emitted as a delta so the runtime's accumulated snapshot stays in sync with s.
      const bt = inner.content_block?.type;
      if (bt === 'text' && s.text && !s.text.endsWith('\n\n')) {
        const sep = s.text.endsWith('\n') ? '\n' : '\n\n';
        s.text += sep; emit({ type: 'text', delta: sep });
      } else if (bt === 'thinking' && s.reasoning && !s.reasoning.endsWith('\n\n')) {
        const sep = s.reasoning.endsWith('\n') ? '\n' : '\n\n';
        s.reasoning += sep; emit({ type: 'reasoning', delta: sep });
      }
    } else if (inner.type === 'content_block_delta') {
      const d = inner.delta || {};
      if (d.type === 'text_delta' && d.text) { s.text += d.text; s.streamedText = true; s.textSinceToolResult = true; emit({ type: 'text', delta: d.text }); }
      else if (d.type === 'thinking_delta' && d.thinking) { s.reasoning += d.thinking; s.streamedReasoning = true; emit({ type: 'reasoning', delta: d.thinking }); }
    } else if (inner.type === 'message_delta') {
      const u = inner.usage;
      if (u) {
        // Real reported output supersedes the live thinking estimate for this message.
        if (u.output_tokens != null) { s.output = u.output_tokens; s.thinkingEstTokens = 0; }
        if (u.input_tokens != null) s.input = u.input_tokens;
        if (u.cache_read_input_tokens != null) s.cached = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) s.cacheCreation = u.cache_creation_input_tokens;
        emit({ type: 'usage', usage: claudeUsageOf(s) });
      }
      if (inner.delta?.stop_reason) s.stopReason = inner.delta.stop_reason;
    }
    if (ev.session_id && ev.session_id !== s.sessionId) { s.sessionId = ev.session_id; emit({ type: 'session', sessionId: ev.session_id }); }
    return;
  }
  if (t === 'assistant') {
    // Synthetic resume-repair no-op: resuming a session whose previous turn was left incomplete
    // makes the CLI emit an assistant message with model '<synthetic>' whose only text is
    // "No response requested." (paired with an isMeta "Continue from where you left off." user
    // record). It is NOT model output — mirror the legacy driver and drop it, so it neither shows
    // as the reply nor counts as real output (the no-op-resume recovery keys off that emptiness).
    if (ev.message?.model === '<synthetic>' && isClaudeSyntheticResumeNoise(claudeContentText(ev.message?.content))) return;
    // API-error message: Claude surfaces a failed model call (401 auth, overloaded, quota, …) not as a
    // result code but as a synthetic assistant message — model '<synthetic>', a lone text block carrying
    // the human-readable error ("Failed to authenticate. API Error: 401 …"), and a TOP-LEVEL `error` tag
    // on the event (e.g. "authentication_failed"; the persisted transcript also stamps `isApiErrorMessage`).
    // It is NOT model output. Routing its text through the normal path below would make the error render
    // as the assistant's reply body (原文). Send it to `s.error` — the run-end notice, same slot as the
    // `result{is_error}` branch below — and never to `s.text`. The trailing `result` also flags the error
    // (and would set `s.error` too), but claiming it here keeps a narration-less turn from double-rendering
    // (body + notice), and preserves any real narration already streamed before the call failed.
    const apiErrorTag = typeof ev.error === 'string' ? ev.error.trim() : (ev.isApiErrorMessage ? 'api_error' : '');
    if (apiErrorTag) {
      if (!s.error) {
        const msg = claudeContentText(ev.message?.content).trim();
        s.error = msg || `Claude reported an API error (${apiErrorTag})`;
      }
      return;
    }
    // A real assistant event's uuid IS its persisted transcript record uuid — track the
    // latest as this turn's fork anchor (inclusive keep-boundary for --resume-session-at).
    if (typeof ev.uuid === 'string' && ev.uuid) s.anchor = ev.uuid;
    const contents = ev.message?.content || [];
    for (const b of contents) {
      if (b?.type !== 'tool_use') continue;
      const id = String(b.id || '');
      const name = String(b.name || 'Tool');
      if (name === 'TodoWrite') {
        const plan = todoWriteToPlan(b.input);
        if (plan) { s.todoPlan = plan; emit({ type: 'plan', plan }); }
        const summary = 'Update plan';
        (s.tools ||= new Map()).set(id, { name, summary });
        emit({ type: 'tool', call: { id, name, summary, input: null, status: 'running' } });
        continue;
      }
      // Task list (current Claude mechanism): stash the subject; the tool_result assigns the id.
      // The command surfaces as an Activity row (matching the CLI's own transcript); the
      // structured task state still flows through plan events.
      if (name === 'TaskCreate') {
        const subject = typeof b.input?.subject === 'string' ? b.input.subject.trim() : '';
        if (subject) (s.pendingTaskCreates ||= new Map()).set(id, { subject });
        const summary = subject ? `Create task: ${subject}` : 'Create task';
        (s.tools ||= new Map()).set(id, { name, summary });
        emit({ type: 'tool', call: { id, name, summary, input: null, status: 'running' } });
        continue;
      }
      if (name === 'TaskUpdate') {
        const taskId = String(b.input?.taskId ?? '').trim();
        const rawStatus = String(b.input?.status ?? '').trim().toLowerCase();
        // Chronological: the plan reflects the state AFTER this update. An id known to the
        // TaskCreate store lands there; otherwise it lands positionally on the latest
        // TodoWrite list (ids are 1-based positions when the todo panel owns the list).
        if (taskId && s.taskList?.has(taskId)) {
          if (rawStatus === 'deleted') {
            s.taskList.delete(taskId);
            if (Array.isArray(s.taskOrder)) s.taskOrder = s.taskOrder.filter((x: string) => x !== taskId);
          } else if (rawStatus) {
            const existing = s.taskList.get(taskId);
            if (existing) existing.status = rawStatus;
          }
          const plan = rebuildClaudeTaskPlan(s);
          if (plan) emit({ type: 'plan', plan });
        } else if (taskId) {
          const updated = applyTaskUpdateToTodoPlan(s.todoPlan, taskId, rawStatus);
          if (updated) { s.todoPlan = updated; emit({ type: 'plan', plan: updated }); }
        }
        const summary = `Update task ${taskId || '?'} → ${rawStatus || 'unknown'}`;
        (s.tools ||= new Map()).set(id, { name, summary });
        emit({ type: 'tool', call: { id, name, summary, input: null, status: 'running' } });
        continue;
      }
      if (name === 'Task' || name === 'Agent') {
        const input = b.input || {};
        const sub: UniversalSubAgent = {
          id,
          kind: typeof input.subagent_type === 'string' ? input.subagent_type : null,
          description: typeof input.description === 'string' ? input.description : null,
          model: null, tools: [], status: 'running',
        };
        if (typeof input.prompt === 'string' && input.prompt.trim()) sub.prompt = input.prompt.slice(0, CLAUDE_SUB_TEXT_CAP);
        (s.subAgents ||= new Map()).set(id, sub);
        emit({ type: 'subagent', subagent: { ...sub, tools: [] } });
        continue;
      }
      const summary = summarizeToolUse(name, b.input);
      (s.tools ||= new Map()).set(id, { name, summary });
      emit({ type: 'tool', call: { id, name, summary, input: shortToolValue(toolInputDetail(name, b.input), 200) || null, status: 'running' } });
    }
    emitClaudeImages(contents, s, emit);
    // Reasoning fallback: when thinking is NOT streamed as thinking_delta (claude can deliver
    // it as a complete `thinking` block in the assistant message instead), capture it here.
    // Mirrors the legacy driver — without this the kernel path silently drops all thinking.
    if (!s.streamedReasoning) {
      const th = contents.filter((b: any) => b?.type === 'thinking').map((b: any) => b.thinking || '').filter(Boolean).join('\n\n');
      if (th) { const delta = s.reasoning ? '\n\n' + th : th; s.reasoning += delta; emit({ type: 'reasoning', delta }); }
    }
    if (!s.streamedText) {
      const tx = contents.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('\n\n');
      if (tx) { s.text = tx; s.textSinceToolResult = true; emit({ type: 'text', delta: tx }); }
    }
    return;
  }
  if (t === 'user') {
    // Background wake-up delivery: a `<task-notification>` tag (as a string or a text block) marks
    // its background task terminal — an extra completion signal alongside the system task events.
    markClaudeTaskNotificationTerminal(ev.message?.content, s, emit);
    // Tool results: surface generated images as artifacts AND close out the tool call
    // (status done/failed + a result detail) so toolCalls is a faithful structured SSOT
    // and the runtime's activity projection can render the execution trail.
    const contents = Array.isArray(ev.message?.content) ? ev.message.content : [];
    // A tool_result hands control back to the model; until the model produces visible text
    // again the turn is "dangling" — a result/exit in that window means the closing reply
    // was never generated (see claudeTurnEndedDangling).
    if (contents.some((b: any) => b?.type === 'tool_result')) {
      s.sawToolResult = true;
      s.textSinceToolResult = false;
    }
    for (const b of contents) {
      if (b?.type !== 'tool_result') continue;
      const id = String(b.tool_use_id || '').trim();
      // A Read result is the agent inspecting a file, not a deliverable — surfacing those spammed
      // the chat with every image the agent looked at (the legacy driver has the same exclusion).
      // Images from generating tools (MCP image-gen, screenshots, …) still surface as photos.
      const tool = id ? s.tools?.get(id) : undefined;
      if (tool?.name !== 'Read') emitClaudeImages(b.content || [], s, emit);
      // TaskCreate result: the assigned task id arrives here; register the task and emit the plan.
      if (id && s.pendingTaskCreates?.has(id)) {
        const pending = s.pendingTaskCreates.get(id);
        const assignedId = readClaudeTaskCreateId(ev, b);
        if (pending && assignedId) {
          s.pendingTaskCreates.delete(id);
          (s.taskList ||= new Map());
          (s.taskOrder ||= []);
          if (!s.taskList.has(assignedId)) s.taskOrder.push(assignedId);
          s.taskList.set(assignedId, { subject: pending.subject, status: 'pending' });
          const plan = rebuildClaudeTaskPlan(s);
          if (plan) emit({ type: 'plan', plan });
        }
        if (tool) emit({ type: 'tool', call: { id, name: tool.name, summary: tool.summary, status: b.is_error ? 'failed' : 'done', result: null } });
        continue;
      }
      // A Task/Agent tool_result belongs to a sub-agent, not a tool row: either the sub's FINAL
      // report (sync run) or the CLI's async-launch acknowledgement (run_in_background — the
      // DEFAULT). The launch notice must not settle the sub — its real work streams into its own
      // transcript, never into this stream (no parent_tool_use_id events exist for background
      // subs), so it registers a tail instead and the task-notification later flips it terminal.
      const sub = id ? (s.subAgents?.get?.(id) as UniversalSubAgent | undefined) : undefined;
      if (sub) { applyClaudeSubAgentResult(sub, b, ev, s, emit); continue; }
      if (!tool) continue;
      const isError = !!b.is_error;
      // File-shaped and task-list tools have no useful result detail (mirrors pikiloom): just mark done.
      const fileTool = tool.name === 'Read' || tool.name === 'Edit' || tool.name === 'Write'
        || tool.name === 'TodoWrite' || tool.name === 'TaskCreate' || tool.name === 'TaskUpdate';
      const detail = (isError || !fileTool) ? firstResultLine(b.content) : null;
      emit({ type: 'tool', call: { id, name: tool.name, summary: tool.summary, status: isError ? 'failed' : 'done', result: detail || null } });
    }
    return;
  }
  if (t === 'result') {
    if (ev.session_id) s.sessionId = ev.session_id;
    // An error result may arrive with an EMPTY errors[] (e.g. subtype error_during_execution).
    // Deriving a message anyway is what keeps the turn from settling as a silent "success" —
    // the exact swallow where a mid-turn narration ends on a hanging colon and nothing follows.
    const subtype = typeof ev.subtype === 'string' ? ev.subtype : '';
    const isErrorResult = !!ev.is_error || subtype.startsWith('error');
    if (isErrorResult && !s.error) {
      const errs = (Array.isArray(ev.errors) ? ev.errors : [])
        .map((x: any) => typeof x === 'string' ? x : (x?.message || (x ? JSON.stringify(x) : '')))
        // Claude stamps INTERNAL telemetry breadcrumbs (`[ede_diagnostic] …`) into result.errors[]
        // but filters them out of its OWN user-facing warning (`.filter(e => !e.startsWith('[ede_diagnostic]'))`).
        // Surfacing them as a run-end notice just leaks internals — most visibly `result_type=user …
        // stop_reason=null` on a turn the model never answered. Mirror Claude's own filter. When they were
        // the ONLY entries, the fallback below derives a plain notice, preserving the never-a-silent-success
        // guarantee (the turn still ended on an error result).
        .filter((x: string) => x && x.trim() && !x.trimStart().startsWith(CLAUDE_INTERNAL_DIAGNOSTIC_PREFIX));
      s.error = errs.length ? errs.join('; ')
        : (typeof ev.result === 'string' && ev.result.trim() ? ev.result.trim()
        : `claude ended the turn with an error result${subtype ? ` (${subtype})` : ''}`);
    }
    // When the WHOLE assistant body is that same error notice — a spend/usage-limit hit or a
    // permission refusal the CLI narrates as a message AND flags the `result` an error, so the
    // identical text lands in BOTH s.text and s.error — the turn is a single notice, not an
    // answer-plus-red-echo. Drop the duplicate body so it renders once (as the error notice).
    // Only exact-equal collapses: a real reply that merely ENDS with an error keeps both.
    if (s.error && s.text.trim() && sameClaudeText(s.text, s.error)) { s.text = ''; s.streamedText = false; }
    if (!isErrorResult && typeof ev.result === 'string' && ev.result.trim()) {
      if (!s.text.trim()) s.text = ev.result;
      s.textSinceToolResult = true; // the closing reply arrived via the result payload
    }
    if (ev.stop_reason && !s.stopReason) s.stopReason = ev.stop_reason;
    const u = ev.usage;
    if (u) {
      if (s.input == null && u.input_tokens != null) s.input = u.input_tokens;
      if (s.output == null && u.output_tokens != null) s.output = u.output_tokens;
      const cached = u.cache_read_input_tokens ?? u.cached_input_tokens;
      if (s.cached == null && cached != null) s.cached = cached;
      if (s.cacheCreation == null && u.cache_creation_input_tokens != null) s.cacheCreation = u.cache_creation_input_tokens;
    }
    return;
  }
}

// ── run_in_background lifecycle (background → wake-up) ───────────────────────────────────
// Claude streams a structured lifecycle for detached background work as `system` sub-events:
//   { subtype:'task_started',      task_id, tool_use_id, description }   ← launched
//   { subtype:'task_updated',      task_id, patch:{ status } }           ← progress / terminal
//   { subtype:'task_notification', task_id, status }                     ← terminal (completed/killed/…)
// A task counts as pending from task_started until a terminal task_updated/task_notification.
// While any are pending the driver keeps the turn alive instead of ending it at `result`, so
// Claude's own background→wake-up turn (which reports the finished work) can stream in. Pure +
// exported for hermetic testing.

// How long, with no settle, to keep holding a turn open for a background task to finish and
// trigger Claude's wake-up turn, before giving up (so a never-completing daemon doesn't hang
// the turn forever). Override with PIKILOOM_CLAUDE_BG_HOLD_MS.
const CLAUDE_BG_HOLD_CAP_DEFAULT_MS = 10 * 60_000;
export function claudeBgHoldCapMs(): number {
  const raw = Number(process.env.PIKILOOM_CLAUDE_BG_HOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CLAUDE_BG_HOLD_CAP_DEFAULT_MS;
}
// Sub-agent-backed background work (Task/Agent tool launches) gets a much longer hold: these
// are finite model-driven jobs whose results the turn is genuinely waiting on — a research
// fleet mapping two repos legitimately runs past the 10-minute daemon cap, and capping it
// there discarded the agents' work and cut the turn mid-flight ("停止不再继续生成").
// Override with PIKILOOM_CLAUDE_BG_AGENT_HOLD_MS.
const CLAUDE_BG_AGENT_HOLD_CAP_DEFAULT_MS = 45 * 60_000;
export function claudeBgAgentHoldCapMs(): number {
  const raw = Number(process.env.PIKILOOM_CLAUDE_BG_AGENT_HOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CLAUDE_BG_AGENT_HOLD_CAP_DEFAULT_MS;
}
export function claudeTurnHasAgentBackground(s: any): boolean {
  return !!s?.bgAgentTasks?.size;
}
// When the hold cap fires while events are still flowing, defer and re-check on this cadence
// instead of yanking an actively-working turn (the cap bounds SILENT stuck holds, nothing else).
// Override with PIKILOOM_CLAUDE_BG_HOLD_RECHECK_MS (tests need sub-second rechecks).
const CLAUDE_BG_HOLD_RECHECK_DEFAULT_MS = 30_000;
export function claudeBgHoldRecheckMs(): number {
  const raw = Number(process.env.PIKILOOM_CLAUDE_BG_HOLD_RECHECK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CLAUDE_BG_HOLD_RECHECK_DEFAULT_MS;
}
// Once every KNOWN background task has finished, how long Claude must stay quiet (no further
// output at all) before we close a background turn. A completed task's status races AHEAD of the
// wake-up turn that reports it — with N parallel agents finishing together, the last agent's
// completion can land before an earlier agent's wake-up result, so exiting at the first
// pending==0 result would kill the still-undelivered wake-ups (the "background was running when
// the process exited" failure). Refreshed on every event, so a still-streaming wake-up keeps it
// alive. Override with PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS.
const CLAUDE_BG_SETTLE_QUIET_DEFAULT_MS = 15_000;
export function claudeBgSettleQuietMs(): number {
  const raw = Number(process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CLAUDE_BG_SETTLE_QUIET_DEFAULT_MS;
}
// How long the model may stay COMPLETELY silent after a tool_result (control handed back to it,
// no background pending) before the driver gives up and settles the turn as 'stalled'. Must be
// generous: subscription accounts stream NO events during extended thinking, and at the reasoning
// rungs a legitimate silent think regularly exceeds two minutes — the original 120s default
// misfired on exactly that (settling a LIVE turn as 'stalled' and then killing its still-running
// tool via the leak-guard; mirasim#111). A too-long window only means a truly hung turn shows its
// dead spinner longer, so the costs are asymmetric — err long. Effort-laddered: the deep-reasoning
// rungs (high and up) think the longest. A still-running tool never trips this (it has no
// tool_result yet). Override with PIKILOOM_CLAUDE_MODEL_STALL_MS (wins over the ladder).
const CLAUDE_MODEL_STALL_DEFAULT_MS = 300_000;
const CLAUDE_MODEL_STALL_DEEP_MS = 600_000;
// Claude's INTERNAL telemetry breadcrumb prefix (see the result-error handler): Claude stamps
// `[ede_diagnostic] …` into result.errors[] and filters it from its own user-facing warning; so do we.
const CLAUDE_INTERNAL_DIAGNOSTIC_PREFIX = '[ede_diagnostic]';
// A synthetic `assistant` API-error event (see the `assistant` handler): a top-level `error` tag or
// the persisted `isApiErrorMessage` flag. It is NOT model progress — the model is unreachable and the
// CLI is retrying — so it must not clear the model-stall watchdog (see the stdout event loop).
function claudeEventIsApiError(ev: any): boolean {
  return ev?.type === 'assistant' && (typeof ev.error === 'string' || ev.isApiErrorMessage === true);
}
const CLAUDE_DEEP_REASONING_EFFORTS = new Set(['high', 'xhigh', 'max', 'ultra']);
export function claudeModelStallMs(effort?: string | null): number {
  const raw = Number(process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return effort && CLAUDE_DEEP_REASONING_EFFORTS.has(effort) ? CLAUDE_MODEL_STALL_DEEP_MS : CLAUDE_MODEL_STALL_DEFAULT_MS;
}
// In-process self-heal for a truncated turn: when a clean result lands while the tool loop is
// still dangling (the model's closing round came back empty), the stdin is still open — inject
// ONE recovery user message and let the CLI run a follow-up round in the same process, so the
// closing reply the user is waiting for actually gets delivered instead of just being flagged.
// Once per turn; the post-tool stall watchdog is the safety net if the CLI never responds.
// The <pikiloom-recover> tag keeps the injected message out of pikiloom's transcript rendering.
// Disable with PIKILOOM_CLAUDE_TRUNCATED_RECOVERY=0.
export const CLAUDE_TRUNCATED_RECOVERY_PROMPT =
  '<pikiloom-recover>Your previous response ended after a tool call without a closing message. '
  + 'Finish the reply now: state the outcome and anything the user still needs to know. '
  + 'Do not re-run tools unless strictly necessary.</pikiloom-recover>';
export function claudeTruncatedRecoveryEnabled(): boolean {
  const v = String(process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}
// The CLI's resume-repair placeholder for a turn that never concluded: an assistant message with
// model '<synthetic>' whose only text is "No response requested." (paired with an isMeta "Continue
// from where you left off." user record). It is NOT model output. Mirrors the legacy driver.
export function isClaudeSyntheticResumeNoise(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  return t === 'no response requested.' || t === 'no response requested';
}
// A prompt whose first token is a Claude slash command (/compact, /clear, /cost, /model …, a custom
// /namespace:command). Such a prompt is a LOCAL action, not a request for a model reply, so an
// output-empty result is expected — not the dropped-send signature the no-op-resume repair targets.
// The first token must be a bare command name (letters/digits/_/- with an optional :namespace) ending
// at whitespace or end-of-string, so a filesystem-style path (/Users/foo) is NOT matched. Pure +
// exported for hermetic testing.
export function isClaudeSlashCommand(prompt: string): boolean {
  return /^\/[a-z0-9][\w-]*(?::[\w-]+)?(?:\s|$)/i.test((prompt || '').trimStart());
}
// True once the turn produced ANY real model output — streamed or whole-message text/reasoning, a
// tool use, or a spawned sub-agent. False for a pure no-op (a synthetic resume-repair result that
// ran none of the prompt), which is exactly what the no-op-resume recovery keys off. Pure +
// exported for hermetic testing.
export function claudeProducedRealOutput(s: any): boolean {
  return !!(s?.streamedText || s?.streamedReasoning
    || (s?.tools?.size ?? 0) > 0 || (s?.subAgents?.size ?? 0) > 0
    || (typeof s?.text === 'string' && s.text.trim().length > 0)
    || (typeof s?.reasoning === 'string' && s.reasoning.trim().length > 0));
}
// How many times to re-issue the prompt when a resume comes back a pure no-op before giving up and
// settling (see the result handler). Bounded so a genuinely dead session can't loop forever; 0
// disables the recovery. Override with PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES.
const CLAUDE_RESUME_NOOP_RETRY_DEFAULT = 3;
export function claudeResumeNoopRetryLimit(): number {
  const raw = Number(process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES);
  return Number.isFinite(raw) && raw >= 0 ? raw : CLAUDE_RESUME_NOOP_RETRY_DEFAULT;
}
// True when a claude `type:'user'` stream event carries at least one tool_result block — i.e. the
// tool loop just handed control back to the model. Pure + exported for hermetic testing.
export function claudeUserEventHasToolResult(ev: any): boolean {
  const c = ev?.message?.content;
  return Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result');
}
// After we settle a held turn gracefully (stdin closed, no kill), force-kill the lingering
// process only if it hasn't exited on its own within this window. Backstop against leaks.
const CLAUDE_EXIT_LEAK_GUARD_MS = 15_000;

export function isTerminalTaskStatus(status: unknown): boolean {
  return /^(complete|done|success|succeed|finish|kill|fail|error|stop|cancel|abort|timed?_?out|timeout)/i
    .test(String(status ?? '').trim());
}

// A terminal status that means the work did NOT complete (killed/failed/cancelled/timed out).
// Subset of isTerminalTaskStatus; anything terminal-but-not-failed settles as 'done'.
export function isFailedTaskStatus(status: unknown): boolean {
  return /^(kill|fail|error|cancel|abort|timed?_?out|timeout)/i.test(String(status ?? '').trim());
}

export function trackClaudeBackgroundTask(ev: any, s: any, emit?: (e: DriverEvent) => void): void {
  const subtype = ev?.subtype;
  if (subtype !== 'task_started' && subtype !== 'task_updated' && subtype !== 'task_notification' && subtype !== 'task_progress') return;
  // Sub-agent-backed background tasks (Task/Agent tool launches) are FINITE model-driven jobs,
  // unlike a detached shell that may daemonize forever — they earn a much longer hold cap
  // (see armHoldCap). The task_started's tool_use_id points at the launching tool call, which
  // for sub-agents lives in s.subAgents.
  if (subtype === 'task_started') {
    const tui = String(ev?.tool_use_id ?? '').trim();
    const sub = tui ? (s?.subAgents?.get?.(tui) as UniversalSubAgent | undefined) : undefined;
    if (tui && sub) {
      const taskId = String(ev?.task_id ?? ev?.id ?? tui);
      (s.bgAgentTasks ||= new Set<string>()).add(taskId);
      // task_id IS the sub's agentId — remember the mapping so a terminal task event can flip
      // the sub, and so the tail poller can derive the side-transcript path if the launch
      // notice's output_file line was missing.
      (s.bgTaskSub ||= new Map<string, string>()).set(taskId, tui);
      const tail = ensureClaudeSubTail(s, sub);
      if (!tail.agentId) tail.agentId = taskId;
      // The event also restates the launch facts — backfill anything the tool_use lacked.
      if (!sub.prompt && typeof ev?.prompt === 'string' && ev.prompt.trim()) sub.prompt = ev.prompt.slice(0, CLAUDE_SUB_TEXT_CAP);
      if (!sub.kind && typeof ev?.subagent_type === 'string') sub.kind = ev.subagent_type;
      if (!sub.description && typeof ev?.description === 'string') sub.description = ev.description;
    }
  }
  // Live progress heartbeat for an agent-backed task: carries the CLI's OWN running totals
  // (`usage.total_tokens` — authoritative, supersedes our computed sum). Not part of the
  // pending/terminal bookkeeping.
  if (subtype === 'task_progress') {
    const taskId = String(ev?.task_id ?? '').trim();
    const tui = String(ev?.tool_use_id ?? '').trim();
    const subId = (tui && s?.subAgents?.has?.(tui)) ? tui : s?.bgTaskSub?.get?.(taskId);
    const sub = subId ? (s?.subAgents?.get?.(subId) as UniversalSubAgent | undefined) : undefined;
    if (sub) {
      const total = Number(ev?.usage?.total_tokens);
      let changed = false;
      if (Number.isFinite(total) && total > 0 && sub.totalTokens !== total) {
        sub.totalTokens = total;
        ensureClaudeSubTail(s, sub).authTokens = true;
        changed = true;
      }
      if (changed) emit?.({ type: 'subagent', subagent: { ...sub, tools: [...sub.tools] } });
    }
    return;
  }
  const id = String(ev?.task_id ?? ev?.tool_use_id ?? '').trim();
  if (!id) return;
  if (subtype === 'task_started') { (s.bgStarted ||= new Set<string>()).add(id); return; }
  const status = ev?.patch?.status ?? ev?.status;
  if (isTerminalTaskStatus(status)) {
    (s.bgTerminal ||= new Set<string>()).add(id);
    settleClaudeBackgroundSub(s, id, status, null, emit);
  }
}

// Flip the sub-agent behind a terminal background-task signal (system task event or user-message
// task-notification) from running to done/failed and surface the moment live. Idempotent — a sub
// already settled by one signal is left alone by the other. `report` (the notification's <result>
// payload) lands even on the second, richer signal.
function settleClaudeBackgroundSub(
  s: any, taskId: string, status: unknown, report: string | null, emit?: (e: DriverEvent) => void,
): void {
  const subId = s?.bgTaskSub?.get?.(taskId) ?? (s?.subAgents?.has?.(taskId) ? taskId : null);
  const sub = subId ? (s?.subAgents?.get?.(subId) as UniversalSubAgent | undefined) : undefined;
  if (!sub) return;
  let changed = false;
  if (sub.status === 'running') {
    sub.status = isFailedTaskStatus(status) ? 'failed' : 'done';
    changed = true;
  }
  if (report && !sub.report) { sub.report = report.slice(0, CLAUDE_SUB_TEXT_CAP); changed = true; }
  if (changed) emit?.({ type: 'subagent', subagent: { ...sub, tools: [...sub.tools] } });
}

function claudeContentText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
  return '';
}

// Whitespace-insensitive text equality — the error notice (a trimmed `result` string) and the
// streamed body (may carry trailing newlines / soft breaks) can differ only in whitespace yet be
// the same message. Used to collapse an error that IS the whole body (see the result handler).
export function sameClaudeText(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

// Extra completion signal (mirrors the legacy driver): Claude delivers a background wake-up as a
// `type:'user'` message carrying a `<task-notification>` tag (<task-id>/<tool-use-id>/<status>).
// Mark that task terminal too, so a missed/absent system task_notification still lets pending
// reach 0 (instead of the turn hanging to the hold cap). For an agent-backed task this is also
// the RICHEST terminal signal: <tool-use-id> names the launching Task/Agent call directly and
// <result> carries the sub's final report — flip the sub and take the report here.
export function markClaudeTaskNotificationTerminal(content: any, s: any, emit?: (e: DriverEvent) => void): void {
  const text = claudeContentText(content);
  if (!text || !text.includes('<task-notification>')) return;
  const tag = (name: string): string => {
    const m = text.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`));
    return m ? m[1].trim() : '';
  };
  const status = tag('status');
  if (status && !isTerminalTaskStatus(status)) return;
  for (const id of [tag('task-id'), tag('tool-use-id')]) if (id) (s.bgTerminal ||= new Set<string>()).add(id);
  // <result> spans multiple lines/nested markup — the [^<]* tag() reader can't take it.
  const report = /<result>\s*([\s\S]*?)\s*<\/result>/.exec(text)?.[1] ?? null;
  const tui = tag('tool-use-id');
  const subId = (tui && s?.subAgents?.has?.(tui)) ? tui : tag('task-id');
  if (subId) settleClaudeBackgroundSub(s, subId, status || 'completed', report, emit);
}

export function pendingClaudeBackgroundTasks(s: any): number {
  const started: Set<string> | undefined = s?.bgStarted;
  if (!started?.size) return 0;
  const terminal: Set<string> | undefined = s?.bgTerminal;
  let n = 0;
  for (const id of started) if (!terminal?.has(id)) n++;
  return n;
}

// ── background sub-agent live visibility ─────────────────────────────────────────────────
// Sub-agents launched by a Task/Agent call now default to run_in_background: the tool_result is
// an immediate "Async agent launched" acknowledgement (agentId + output_file lines), the real
// work streams ONLY into the sub's own transcript (output_file — a symlink to
// <session>/subagents/agent-<agentId>.jsonl), and NO parent_tool_use_id-tagged event ever
// reaches the parent stream. Without the pieces below, a background sub sits at "running, zero
// tools" for its whole life and its 40-tool trail is invisible until a history reload.

/** Caps prompt/report text carried on subagent events (mirrors the history reconstruction). */
const CLAUDE_SUB_TEXT_CAP = 600;

/**
 * Per-sub activity accumulator, shared by BOTH live sources — inline `parent_tool_use_id`
 * events and the transcript tail (which one flows depends on the CLI version/run mode) — so
 * tools dedupe across them and timestamps/usage fold identically whichever delivers first.
 */
export interface ClaudeSubTail {
  /** The sub's transcript path (the launch notice's output_file), or null until derivable. */
  file: string | null;
  agentId: string | null;
  offset: number;
  carry: string;
  seenTools: Set<string>;
  firstTs: number | null;
  lastTs: number | null;
  outputSum: number;
  contextPeak: number;
  /** True once a task_progress reported an authoritative total — computed sums stop overwriting. */
  authTokens: boolean;
  /** One final sweep runs after the sub settles; then the tail goes dormant. */
  done: boolean;
}

/** Get or create the sub's shared accumulator (keyed by the launching tool_use id). */
function ensureClaudeSubTail(s: any, sub: UniversalSubAgent): ClaudeSubTail {
  const tails: Map<string, ClaudeSubTail> = (s.subTails ||= new Map<string, ClaudeSubTail>());
  let tail = tails.get(sub.id);
  if (!tail) {
    tail = {
      file: null, agentId: null, offset: 0, carry: '', seenTools: new Set<string>(),
      firstTs: null, lastTs: null, outputSum: 0, contextPeak: 0, authTokens: false, done: false,
    };
    tails.set(sub.id, tail);
  }
  return tail;
}

/** Recompute the sub's derived cost facts from the accumulator. Returns true when they moved. */
function recomputeClaudeSubFacts(sub: UniversalSubAgent, tail: ClaudeSubTail): boolean {
  let changed = false;
  if (tail.firstTs != null && tail.lastTs != null && tail.lastTs > tail.firstTs) {
    const dur = tail.lastTs - tail.firstTs;
    if (sub.durationMs !== dur) { sub.durationMs = dur; changed = true; }
  }
  if (!tail.authTokens) {
    const total = tail.outputSum + tail.contextPeak;
    if (total > 0 && sub.totalTokens !== total) { sub.totalTokens = total; changed = true; }
  }
  return changed;
}

/** Fold one inline sub event's timestamp + usage into the accumulator (live stream events carry both). */
function foldClaudeSubEventFacts(ev: any, sub: UniversalSubAgent, tail: ClaudeSubTail): boolean {
  const ts = typeof ev?.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
  if (Number.isFinite(ts)) {
    if (tail.firstTs == null) tail.firstTs = ts;
    if (tail.lastTs == null || ts > tail.lastTs) tail.lastTs = ts;
  }
  const u = ev?.message?.usage;
  if (u && typeof u === 'object') {
    const out = Number(u.output_tokens);
    if (Number.isFinite(out) && out > 0) tail.outputSum += out;
    const ctx = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    if (ctx > tail.contextPeak) tail.contextPeak = ctx;
  }
  return recomputeClaudeSubFacts(sub, tail);
}

// A Task/Agent tool_result: async launch notice → register the tail and keep the sub running;
// sync completion → settle the sub with the report (+ CLI sidecar cost facts when the event
// carries them — the persisted record does; the live stream may not). Pure + exported for
// hermetic testing.
export function applyClaudeSubAgentResult(
  sub: UniversalSubAgent, b: any, ev: any, s: any, emit: (e: DriverEvent) => void,
): void {
  const sidecar = (ev?.toolUseResult && typeof ev.toolUseResult === 'object' ? ev.toolUseResult : {}) as any;
  const text = claudeContentText(b?.content ?? '');
  const agentId = (typeof sidecar.agentId === 'string' && sidecar.agentId.trim())
    ? sidecar.agentId.trim()
    : (text.match(/\bagentId:\s*([A-Za-z0-9._-]+)/)?.[1] ?? null);
  const isAsync = sidecar.isAsync === true
    || String(sidecar.status ?? '') === 'async_launched'
    || /\basync agent launched\b/i.test(text)
    || (!!agentId && /\bworking in the background\b/i.test(text));
  if (typeof sidecar.resolvedModel === 'string' && sidecar.resolvedModel.trim() && !sub.model) sub.model = sidecar.resolvedModel.trim();
  if (!sub.prompt && typeof sidecar.prompt === 'string' && sidecar.prompt.trim()) sub.prompt = sidecar.prompt.slice(0, CLAUDE_SUB_TEXT_CAP);
  if (isAsync && !b?.is_error) {
    // MERGE into the shared accumulator — inline events may have landed before this ack, and
    // replacing the record would wipe their dedupe set (double tool rows on dual-source CLIs).
    const tail = ensureClaudeSubTail(s, sub);
    tail.file ||= text.match(/\boutput_file:\s*(\S+)/)?.[1] ?? null;
    tail.agentId ||= agentId;
    if (agentId) (s.bgTaskSub ||= new Map<string, string>()).set(agentId, sub.id);
    emit({ type: 'subagent', subagent: { ...sub, tools: [...sub.tools] } });
    return;
  }
  sub.status = (b?.is_error || isFailedTaskStatus(sidecar.status)) ? 'failed' : 'done';
  const report = text.trim();
  if (report) sub.report = report.slice(0, CLAUDE_SUB_TEXT_CAP);
  const dur = Number(sidecar.totalDurationMs);
  if (Number.isFinite(dur) && dur > 0) sub.durationMs = dur;
  const tok = Number(sidecar.totalTokens);
  if (Number.isFinite(tok) && tok > 0) sub.totalTokens = tok;
  emit({ type: 'subagent', subagent: { ...sub, tools: [...sub.tools] } });
}

// Poll cadence for background sub-agent transcript tails. Observe-only disk reads off the hot
// path; a whole tick with nothing new costs one stat per running sub. Override with
// PIKILOOM_CLAUDE_SUBAGENT_POLL_MS (tests need fast ticks).
const CLAUDE_SUB_TAIL_POLL_DEFAULT_MS = 1_500;
export function claudeSubTailPollMs(): number {
  const raw = Number(process.env.PIKILOOM_CLAUDE_SUBAGENT_POLL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CLAUDE_SUB_TAIL_POLL_DEFAULT_MS;
}
// Per-tick read cap so one monster transcript can't stall the loop; the rest lands next tick.
const CLAUDE_SUB_TAIL_READ_CAP = 4 * 1024 * 1024;

// Read the NEW complete lines appended to each background sub's transcript since the last poll
// and fold them into the sub: tool_use rows (with real summarized arguments — richer than the
// name-only rows the inline parent_tool_use_id path gets), the sub's model, wall-clock span,
// and token use. Emits one subagent event per sub that changed. Failures are swallowed — the
// tail is observe-only and must never break the live turn. Exported for hermetic testing.
export function pollClaudeSubAgentTails(s: any, emit: (e: DriverEvent) => void): void {
  const tails: Map<string, ClaudeSubTail> | undefined = s?.subTails;
  if (!tails?.size) return;
  for (const [subId, tail] of tails) {
    if (tail.done || !tail.file) continue;
    const sub = s.subAgents?.get?.(subId) as UniversalSubAgent | undefined;
    if (!sub) { tail.done = true; continue; }
    let changed = false;
    try {
      const size = statSync(tail.file).size;
      if (size > tail.offset) {
        const fd = openSync(tail.file, 'r');
        let read = 0;
        try {
          const buf = Buffer.alloc(Math.min(size - tail.offset, CLAUDE_SUB_TAIL_READ_CAP));
          read = readSync(fd, buf, 0, buf.length, tail.offset);
          tail.offset += read;
          const lines = (tail.carry + buf.toString('utf8', 0, read)).split('\n');
          tail.carry = lines.pop() ?? '';
          for (const line of lines) {
            if (foldClaudeSubTranscriptLine(line, sub, tail)) changed = true;
          }
        } finally {
          closeSync(fd);
        }
      }
    } catch { /* not written yet / rotated — keep trying on the next tick */ }
    if (changed) {
      recomputeClaudeSubFacts(sub, tail);
      emit({ type: 'subagent', subagent: { ...sub, tools: [...sub.tools] } });
    }
    // The settle flip (task-notification / system task event) may land between polls — grant the
    // tail one more pass so tools written just before completion still make it in, then stop.
    if (sub.status !== 'running' && !changed) tail.done = true;
  }
}

// Fold one sub-transcript JSONL line into the sub. Returns true when anything changed.
function foldClaudeSubTranscriptLine(line: string, sub: UniversalSubAgent, tail: ClaudeSubTail): boolean {
  const t = line.trim();
  if (!t || t[0] !== '{') return false;
  let rec: any;
  try { rec = JSON.parse(t); } catch { return false; }
  let changed = false;
  const ts = typeof rec?.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  if (Number.isFinite(ts)) {
    if (tail.firstTs == null) { tail.firstTs = ts; changed = true; }
    if (tail.lastTs == null || ts > tail.lastTs) { tail.lastTs = ts; changed = true; }
  }
  if (rec?.type !== 'assistant') return changed;
  const m = rec.message?.model;
  if (typeof m === 'string' && m.trim() && m !== '<synthetic>' && sub.model !== m) { sub.model = m; changed = true; }
  const u = rec.message?.usage;
  if (u && typeof u === 'object') {
    const out = Number(u.output_tokens);
    if (Number.isFinite(out) && out > 0) { tail.outputSum += out; changed = true; }
    const ctx = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    if (ctx > tail.contextPeak) { tail.contextPeak = ctx; changed = true; }
  }
  const content = rec.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type !== 'tool_use') continue;
      const id = String(b.id || '');
      if (!id || tail.seenTools.has(id)) continue;
      tail.seenTools.add(id);
      const name = String(b.name || 'Tool');
      sub.tools.push({ id, name, summary: summarizeToolUse(name, b.input) });
      changed = true;
    }
  }
  return changed;
}

// A turn "ended dangling" when it used tools and no visible text arrived after the last
// tool_result — the model's closing round produced nothing (empty final response, a broken
// stream, or the CLI ending the turn early). The reply the user is waiting for never existed,
// so the settle must say so instead of reading as a normal completion.
export function claudeTurnEndedDangling(s: any): boolean {
  return !!s?.sawToolResult && !s?.textSinceToolResult;
}

export type ClaudeResultSettleDecision = 'settle' | 'hold' | 'quiet-settle';
// At a `result` event, decide how to end the turn:
//  - error                               → 'settle' now (hard exit).
//  - a background task is still running   → 'hold' the process open for its wake-up.
//  - background done BUT this turn launched background work → 'quiet-settle': do NOT exit at this
//    result. Claude may still be DELIVERING wake-up turns whose delivery trails their task's
//    completion status (see claudeBgSettleQuietMs); wait for it to go quiet, then close gracefully.
//  - a plain turn (no background)         → 'settle' now.
export function decideClaudeResultSettle(input: {
  hasError: boolean; pendingBackground: number; sawBackground: boolean;
}): ClaudeResultSettleDecision {
  if (input.hasError) return 'settle';
  if (input.pendingBackground > 0) return 'hold';
  return input.sawBackground ? 'quiet-settle' : 'settle';
}

// A stream-json user message (for --input-format stream-json; used to send the prompt and to
// inject mid-turn steer messages while stdin stays open). Image attachments are inlined as base64
// image content blocks so the model actually sees them; other files become a text note. Without
// this the kernel path sent text only and silently dropped pasted/attached images.
export function claudeUserMessage(text: string, attachments?: string[]): string {
  const content: any[] = [];
  for (const filePath of attachments || []) {
    const mime = imageMimeForFile(filePath);
    if (mime) {
      try {
        content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: readFileSync(filePath).toString('base64') } });
        continue;
      } catch { /* unreadable -> fall through to a text note */ }
    }
    content.push({ type: 'text', text: attachedFileNote(filePath) });
  }
  content.push({ type: 'text', text });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

// Surface base64 image content blocks as artifacts (data URLs), deduped per turn.
function emitClaudeImages(blocks: any[], s: any, emit: (e: DriverEvent) => void): void {
  if (!Array.isArray(blocks)) return;
  s.seenImages ||= new Set<string>();
  let n = 0;
  for (const b of blocks) {
    if (b?.type !== 'image' || b?.source?.type !== 'base64' || typeof b.source.data !== 'string') continue;
    const mime = String(b.source.media_type || 'image/png');
    const key = `${mime}:${b.source.data.length}:${b.source.data.slice(0, 32)}`;
    if (s.seenImages.has(key)) continue;
    s.seenImages.add(key);
    const ext = mime.split('/')[1] || 'png';
    emit({ type: 'artifact', artifact: { url: `data:${mime};base64,${b.source.data}`, fileName: `image-${++n}.${ext}`, mime, kind: 'photo' } });
  }
}

// Claude's TodoWrite tool input -> a normalized UniversalPlan (ported from pikiloom).
export function todoWriteToPlan(input: any): UniversalPlan | null {
  if (!input || typeof input !== 'object') return null;
  const rawTodos = Array.isArray(input.todos) ? input.todos : [];
  const steps: UniversalPlan['steps'] = [];
  for (const todo of rawTodos) {
    if (!todo || typeof todo !== 'object') continue;
    const text = typeof todo.content === 'string' ? todo.content.trim() : '';
    if (!text) continue;
    const raw = typeof todo.status === 'string' ? todo.status : 'pending';
    const status = raw === 'completed' ? 'completed' : raw === 'in_progress' ? 'inProgress' : 'pending';
    steps.push({ text, status });
  }
  return steps.length ? { explanation: null, steps } : null;
}

// ── Claude task-list (TaskCreate / TaskUpdate) -> UniversalPlan ──────────────────────
// Current Claude Code drives its task list through TaskCreate/TaskUpdate, NOT TodoWrite
// (TodoWrite is the legacy mechanism). TaskCreate carries the subject; its tool_result then
// assigns a stable task id (toolUseResult.task.id, or "Task #N" in the text). TaskUpdate flips
// a task's status by id. We accumulate the list in driver state and re-emit the whole plan on
// each change. Without this the kernel path never emits a plan event for Claude, so the
// dashboard's task-list card never renders. Ported from pikiloom's legacy claude driver.

// The assigned task id from a TaskCreate tool_result. Prefer the structured field; fall back
// to parsing "Task #N" from a string result.
function readClaudeTaskCreateId(ev: any, block: any): string | null {
  const structured = ev?.toolUseResult?.task?.id;
  if (structured != null && String(structured).trim()) return String(structured).trim();
  const content = block?.content;
  if (typeof content === 'string') {
    const m = content.match(/Task #(\d+)/);
    if (m) return m[1];
  }
  return null;
}

function rebuildClaudeTaskPlan(s: any): UniversalPlan | null {
  if (!Array.isArray(s?.taskOrder) || !s.taskOrder.length) return null;
  const steps: UniversalPlan['steps'] = [];
  for (const id of s.taskOrder) {
    const task = s.taskList?.get(id);
    if (!task) continue;
    const lowered = String(task.status || '').toLowerCase();
    const status = lowered === 'completed' ? 'completed'
      : (lowered === 'in_progress' || lowered === 'inprogress') ? 'inProgress'
      : 'pending';
    const text = String(task.subject || '').trim();
    if (text) steps.push({ text, status });
  }
  return steps.length ? { explanation: null, steps } : null;
}

// Apply a TaskUpdate to a TodoWrite-produced plan positionally (taskId = 1-based item index).
// Used when the id isn't in the TaskCreate store, so an update issued AFTER a TodoWrite still
// lands on the displayed list — the plan reflects the state after the LAST change, whichever
// mechanism wrote it. Returns a fresh plan (never mutates) or null when inapplicable.
function applyTaskUpdateToTodoPlan(
  plan: UniversalPlan | null | undefined,
  taskId: string,
  rawStatus: string,
): UniversalPlan | null {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return null;
  if (!/^\d+$/.test(taskId)) return null;
  const idx = Number(taskId) - 1;
  if (idx < 0 || idx >= plan.steps.length) return null;
  if (rawStatus === 'deleted') {
    const steps = plan.steps.filter((_, i) => i !== idx);
    return steps.length ? { explanation: plan.explanation ?? null, steps } : null;
  }
  const status: UniversalPlan['steps'][number]['status'] | null = rawStatus === 'completed' ? 'completed'
    : (rawStatus === 'in_progress' || rawStatus === 'inprogress') ? 'inProgress'
    : rawStatus === 'pending' ? 'pending' : null;
  if (!status) return null;
  const steps = plan.steps.map((step, i): UniversalPlan['steps'][number] => i === idx ? { ...step, status } : step);
  return { explanation: plan.explanation ?? null, steps };
}

// ── Tool-call summarization (ported from pikiloom's summarizeClaudeToolUse) ──────────
// Turns a Claude tool_use {name,input} into a one-line human summary. The runtime's
// activity projector joins these into snapshot.activity; the structured form lives in
// toolCalls. Kept driver-local: knowing Claude's tool input shapes is the driver's job.

function shortToolValue(value: unknown, max = 140): string {
  if (value == null) return '';
  const text = (typeof value === 'string' ? value : String(value)).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function toolInputDetail(name: string, input: any): string {
  const i = input || {};
  return i.command || i.file_path || i.path || i.pattern || i.query || i.url || i.description || '';
}

function summarizeToolUse(name: string, input: any): string {
  const tool = String(name || '').trim() || 'Tool';
  const i = input || {};
  const description = shortToolValue(i.description, 120);
  switch (tool) {
    case 'Read': { const t = shortToolValue(i.file_path || i.path); return t ? `Read ${t}` : 'Read file'; }
    case 'Edit': { const t = shortToolValue(i.file_path || i.path); return t ? `Edit ${t}` : 'Edit file'; }
    case 'Write': { const t = shortToolValue(i.file_path || i.path); return t ? `Write ${t}` : 'Write file'; }
    case 'Glob': { const p = shortToolValue(i.pattern || i.glob, 120); return p ? `List files: ${p}` : 'List files'; }
    case 'Grep': { const p = shortToolValue(i.pattern || i.query, 120); return p ? `Search text: ${p}` : 'Search text'; }
    case 'WebFetch': { const u = shortToolValue(i.url, 120); return u ? `Fetch ${u}` : 'Fetch web page'; }
    case 'WebSearch': { const q = shortToolValue(i.query, 120); return q ? `Search web: ${q}` : 'Search web'; }
    case 'TodoWrite': return 'Update plan';
    case 'Task': { const p = shortToolValue(i.description || i.prompt, 120); return p ? `Run task: ${p}` : 'Run task'; }
    // Skill invocations carry the skill name in `input.skill` (plugin skills as `plugin:skill`);
    // surface it so the row reads "Skill <name>" instead of a bare, indistinguishable "Skill".
    case 'Skill': { const s = shortToolValue(i.skill || i.name, 80); return s ? `Skill ${s}` : 'Run skill'; }
    case 'Bash': {
      if (description) return `Run shell: ${description}`;
      const c = shortToolValue(i.command, 120);
      return c ? `Run shell: ${c}` : 'Run shell command';
    }
    default: {
      const mcpMatch = tool.match(/^mcp__[^_]+__(.+)$/);
      const bare = mcpMatch ? mcpMatch[1] : tool;
      if (bare === 'im_send_file') { const p = shortToolValue(i.path, 120); return p ? `Send file: ${p}` : 'Send file'; }
      if (bare === 'im_list_files') return 'List workspace files';
      if (bare === 'im_ask_user') { const q = shortToolValue(i.question, 120); return q ? `Ask user: ${q}` : 'Ask user'; }
      if (description) return `${tool}: ${description}`;
      const d = shortToolValue(toolInputDetail(tool, i), 120);
      return d ? `${tool}: ${d}` : tool;
    }
  }
}

// First non-empty line of a tool_result content (string | block[]), for the "summary -> detail" form.
function firstResultLine(content: any): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text || '' : '')).join('\n');
  for (const line of text.split('\n')) { const t = line.trim(); if (t) return shortToolValue(t, 120); }
  return '';
}
