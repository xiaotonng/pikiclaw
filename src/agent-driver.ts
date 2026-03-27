/**
 * agent-driver.ts — Agent driver interface and registry.
 *
 * Each CLI agent (claude, codex, gemini, ...) implements AgentDriver.
 * Register with `registerDriver()`, look up with `getDriver()`.
 */

import type {
  AgentInfo, StreamOpts, StreamResult,
  SessionListResult, SessionTailOpts, SessionTailResult,
  SessionMessagesOpts, SessionMessagesResult,
  ModelListOpts, ModelListResult,
  UsageOpts, UsageResult,
} from './code-agent.js';

export interface AgentDriver {
  readonly id: string;
  /** CLI binary name (e.g. 'claude', 'codex', 'gemini') */
  readonly cmd: string;
  /** UI label for thinking/reasoning display */
  readonly thinkLabel: string;

  detect(): AgentInfo;
  doStream(opts: StreamOpts): Promise<StreamResult>;
  getSessions(workdir: string, limit?: number): Promise<SessionListResult>;
  getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult>;
  getSessionMessages(opts: SessionMessagesOpts): Promise<SessionMessagesResult>;
  listModels(opts: ModelListOpts): Promise<ModelListResult>;
  getUsage(opts: UsageOpts): UsageResult;
  /** Optional live/async usage (e.g. codex app-server). Falls back to getUsage. */
  getUsageLive?(opts: UsageOpts): Promise<UsageResult>;
  shutdown(): void;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const drivers = new Map<string, AgentDriver>();

export function registerDriver(d: AgentDriver) { drivers.set(d.id, d); }

export function getDriver(id: string): AgentDriver {
  const d = drivers.get(id);
  if (!d) throw new Error(`Unknown agent: ${id}. Available: ${[...drivers.keys()].join(', ')}`);
  return d;
}

export function hasDriver(id: string): boolean { return drivers.has(id); }
export function allDrivers(): AgentDriver[] { return [...drivers.values()]; }
export function allDriverIds(): string[] { return [...drivers.keys()]; }

export function shutdownAllDrivers() {
  for (const d of drivers.values()) d.shutdown();
}
