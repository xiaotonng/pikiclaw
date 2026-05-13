/**
 * types.ts — Shared type definitions for the agent layer.
 *
 * All type aliases, interfaces, and type-level constants used across the
 * agent subsystem (drivers, session management, streaming, listing, usage)
 * are centralised here so that consumers can import types without pulling
 * in runtime code.
 */

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

/** Opaque agent identifier string (e.g. "claude", "codex", "gemini"). */
export type Agent = string;

/** Options for detecting whether an agent CLI is installed. */
export interface AgentDetectOptions {
  includeVersion?: boolean;
  refresh?: boolean;
  versionTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Codex-specific types
// ---------------------------------------------------------------------------

/** Cumulative token usage counters reported by the Codex agent. */
export interface CodexCumulativeUsage {
  input: number;
  output: number;
  cached: number;
}

/** Handle for steering a running Codex turn with follow-up input. */
export interface CodexTurnControl {
  threadId: string;
  turnId: string;
  steer: (prompt: string, attachments?: string[]) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Agent interaction (human-in-the-loop) — driver-agnostic protocol
// ---------------------------------------------------------------------------

/** A single selectable option within an agent interaction question. */
export interface AgentInteractionOption {
  label: string;
  description?: string | null;
  value: string;
}

/** A question presented to the user during a human-in-the-loop interaction. */
export interface AgentInteractionQuestion {
  id: string;
  header: string;
  prompt: string;
  options?: AgentInteractionOption[] | null;
  allowFreeform?: boolean;
  secret?: boolean;
  allowEmpty?: boolean;
}

/**
 * Driver-agnostic interaction request.
 *
 * Each driver converts its native "need human input" signal into this shape.
 * The bot/channel/dashboard layers only deal with this interface.
 */
export interface AgentInteraction {
  /** Semantic kind — consumers can use this for UI hints. */
  kind: 'user-input' | 'permission' | 'confirmation';
  /** Unique ID for correlating response back to the driver. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Optional hint text for the user. */
  hint?: string | null;
  /** The questions to present. */
  questions: AgentInteractionQuestion[];
  /**
   * Driver-provided transform: converts the generic answer map into whatever
   * the native agent protocol expects as a response.  All driver-specific
   * serialisation is encapsulated here.
   */
  resolveWith: (answers: Record<string, string[]>) => Record<string, any> | null;
}

// ---------------------------------------------------------------------------
// Stream preview types
// ---------------------------------------------------------------------------

/** Token-level metadata emitted during a streaming preview callback. */
export interface StreamPreviewMeta {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** Single-call context window occupancy (input + cache_read + cache_creation
   *  for the latest LLM call). Use this for "% of context window used" displays
   *  — not the cumulative `inputTokens` etc., which double-count the same
   *  cached prefix on every tool roundtrip. */
  contextUsedTokens?: number | null;
  contextPercent: number | null;
  /**
   * Active sub-agent invocations (Claude `Task` tool). Drivers without sub-agent
   * support omit this field. Each sub-agent renders as its own UI block so its
   * tool stream and model/effort don't bleed into the parent agent's view.
   */
  subAgents?: StreamSubAgent[];
  /**
   * BYOK provider display name (e.g. "OpenRouter") — set only when the agent
   * is bound to a Profile. Renders use it to surface "via <provider>" so the
   * user knows the turn is being routed through a third-party provider.
   */
  providerName?: string | null;
}

/** A single step within a streaming plan preview. */
export interface StreamPreviewPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

/** A plan structure emitted during streaming, with an optional explanation. */
export interface StreamPreviewPlan {
  explanation: string | null;
  steps: StreamPreviewPlanStep[];
}

/**
 * Snapshot of a sub-agent invocation (Claude `Task` tool). Sub-agents run in
 * an isolated context with their own model and tool stream; surfacing them as
 * a discrete unit prevents their activity from polluting the parent agent's
 * tool list or model/effort header.
 */
export interface StreamSubAgent {
  /** The parent's tool_use id for the Task invocation — stable identifier. */
  id: string;
  /** Sub-agent type (e.g. "Explore", "general-purpose") from Task input. */
  kind: string | null;
  /** Description from Task input — short one-liner that names the work. */
  description: string | null;
  /** Model the sub-agent is running on (often differs from the parent). */
  model: string | null;
  /** Ordered list of tools the sub-agent has invoked, deduplicated by id. */
  tools: Array<{ id: string; name: string; summary: string }>;
  /** Lifecycle status — flips to 'done' / 'failed' when the parent receives the Task tool_result. */
  status: 'running' | 'done' | 'failed';
}

// ---------------------------------------------------------------------------
// Stream options and result
// ---------------------------------------------------------------------------

/** Options passed to doStream() and the per-driver stream implementations. */
export interface StreamOpts {
  agent: Agent;
  prompt: string;
  workdir: string;
  timeout: number;
  sessionId: string | null;
  model: string | null;
  thinkingEffort: string;
  onText: (
    text: string,
    thinking: string,
    activity?: string,
    meta?: StreamPreviewMeta,
    plan?: StreamPreviewPlan | null,
  ) => void;
  /** Called when the agent reports the native session/thread ID before completion. */
  onSessionId?: (sessionId: string) => void;
  /** Local file paths to attach (images, documents, etc.) */
  attachments?: string[];
  // codex
  codexModel?: string;
  codexFullAccess?: boolean;
  codexDeveloperInstructions?: string;
  codexExtraArgs?: string[];
  codexPrevCumulative?: CodexCumulativeUsage;
  // claude
  claudeModel?: string;
  claudePermissionMode?: string;
  claudeAppendSystemPrompt?: string;
  claudeExtraArgs?: string[];
  // gemini
  geminiModel?: string;
  geminiApprovalMode?: string;
  geminiSandbox?: boolean;
  geminiSystemInstruction?: string;
  geminiExtraArgs?: string[];
  // hermes — `hermes acp` ignores -m / --provider on the CLI, so the model
  // is bound per-session via the ACP `session/set_model` request after
  // `session/new`. The expected format is the ACP wire encoding
  // `<provider>:<model>` (e.g. `openrouter:gpt-5.4-mini`).
  hermesModel?: string;
  /** Override stdin payload (used for stream-json multimodal input) */
  _stdinOverride?: string;
  /** MCP bridge: callback when agent requests file send via MCP tool. Enables MCP bridge when provided. */
  mcpSendFile?: import('./mcp/bridge.js').McpSendFileCallback;
  /** Path to MCP config JSON — set by prepareStreamOpts, consumed by drivers. */
  mcpConfigPath?: string;
  /**
   * Resolved MCP server map (keyed by server name) for drivers that need the
   * structured list rather than a config file path. Populated by stream.ts
   * from the MCP bridge for the hermes ACP path.
   */
  mcpServers?: Record<string, any>;
  /** Extra environment variables for the spawned agent process. */
  extraEnv?: Record<string, string>;
  /**
   * BYOK argv tokens contributed by the model layer (e.g. ['-m', 'anthropic/sonnet-4'])
   * — populated by stream.ts when an active Profile is bound. Drivers that build
   * their own argv (Hermes via ACP) read this and append it after their own flags.
   */
  byokArgvAppend?: string[];
  /**
   * BYOK-resolved context window for the bound model (from the provider's
   * cached `/models` listing). When set, drivers must use this verbatim as
   * the denominator for context-percent — agent CLIs report their own
   * fallback default for unknown model ids (cc → 200k, codex → similar),
   * which produces wildly wrong percentages on, e.g., a 1M-token DeepSeek
   * model. `undefined` means we don't know; drivers fall back to whatever
   * the CLI advertises.
   */
  byokContextWindow?: number;
  /**
   * Display name of the BYOK provider routing this turn (e.g. "OpenRouter").
   * Renders include this in IM footers and the dashboard turn header so the
   * user can tell the turn is being served via a third-party provider rather
   * than the agent CLI's native auth path. `undefined` when no Profile bound.
   */
  byokProviderName?: string;
  /** Abort the in-flight stream. */
  abortSignal?: AbortSignal;
  /** Optional callback for agent human-in-the-loop interactions (all drivers). */
  onInteraction?: (request: AgentInteraction) => Promise<Record<string, any> | null>;
  /** Optional callback when a running agent can accept steer input in-place. */
  onSteerReady?: (steer: (prompt: string, attachments?: string[]) => Promise<boolean>) => void;
  /** Optional callback when a Codex turn can be steered in place. */
  onCodexTurnReady?: (control: CodexTurnControl) => void;
  /**
   * Fork descriptor — when set, the driver creates a brand-new session that
   * branches off `parentSessionId`. The driver chooses the native mechanism
   * (e.g. Claude `--resume <id> --fork-session`). `atTurn` is recorded as
   * lineage metadata; the actual agent context is whatever the native fork
   * mechanism yields (typically the full parent history).
   *
   * `sessionId` MUST be null when forkOf is set — the fork creates its own ID.
   */
  forkOf?: {
    parentSessionId: string;
    atTurn: number;
  };
}

/** Static capability flags advertised by an AgentDriver. */
export interface AgentDriverCapabilities {
  /** Driver supports forking a session into a new branch. */
  fork: boolean;
  /**
   * Driver supports switching the model mid-session from the dashboard's
   * cascade picker. When false, the dashboard shows the bound model in the
   * chip but skips the "model" step (e.g. Hermes, whose model is locked at
   * profile-binding time and is not switchable per-session via ACP today).
   */
  modelSwitch: boolean;
}

/** Result returned by a completed agent stream. */
export interface StreamResult {
  ok: boolean;
  message: string;
  thinking: string | null;
  plan?: StreamPreviewPlan | null;
  sessionId: string | null;
  workspacePath: string | null;
  model: string | null;
  thinkingEffort: string;
  elapsedS: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  contextWindow: number | null;
  contextUsedTokens: number | null;
  contextPercent: number | null;
  codexCumulative: CodexCumulativeUsage | null;
  error: string | null;
  stopReason: string | null;
  incomplete: boolean;
  activity: string | null;
}

// ---------------------------------------------------------------------------
// Session management types
// ---------------------------------------------------------------------------

/** Persistent record for a pikiclaw-managed session stored in the session index. */
export interface ManagedSessionRecord {
  sessionId: string;
  agent: Agent;
  workdir: string;
  workspacePath: string;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  model: string | null;
  thinkingEffort: string | null;
  stagedFiles: string[];
  runState: SessionRunState;
  runDetail: string | null;
  runUpdatedAt: string | null;
  /** PID of the process that marked this session 'running'. Used for orphan detection across bot restarts. */
  runPid: number | null;
  classification: SessionClassification | null;
  userStatus: 'inbox' | 'active' | 'review' | 'done' | 'parked' | null;
  userNote: string | null;
  lastQuestion: string | null;
  lastAnswer: string | null;
  lastMessageText: string | null;
  lastThinking: string | null;
  lastPlan: StreamPreviewPlan | null;
  migratedFrom: SessionLineageRef | null;
  migratedTo: SessionLineageRef | null;
  linkedSessions: SessionLineageRef[];
  numTurns?: number | null;
  /**
   * Set when this session was created by switching agent away from a prior session.
   * The first turn of this session triggers `compactForHandover` against that source.
   * Read-only once written. After the first turn the field stays for audit but is
   * no longer consulted — the agent's own session file is the canonical context.
   */
  handoverFrom?: HandoverRef | null;
}

/**
 * Reference to a sibling/parent/child session, with optional fork metadata.
 * `kind` defaults to 'migrate' (cross-agent migration) when absent so legacy
 * records continue to round-trip cleanly. `forkedAtTurn` is set on
 * `migratedFrom` when the child was forked AT a specific turn of its parent
 * (0-based; the child inherits turns 0..forkedAtTurn).
 */
export interface SessionLineageRef {
  agent: Agent;
  sessionId: string;
  kind?: 'migrate' | 'fork';
  forkedAtTurn?: number;
}

/**
 * Directed pointer to a previous-agent session that hands its context over to
 * this one. Used for cross-agent continuation: when the user switches agent
 * mid-thread, the new session records `handoverFrom` so its first turn knows
 * which prior session to compact and prepend.
 */
export interface HandoverRef {
  agent: Agent;
  sessionId: string;
}

/** The run-state of a session: running, completed, or incomplete. */
export type SessionRunState = 'running' | 'completed' | 'incomplete';

/** Automated classification of a session's outcome and suggested next action. */
export interface SessionClassification {
  outcome: 'answer' | 'proposal' | 'implementation' | 'partial' | 'blocked' | 'conversation';
  suggestedNextAction: string | null;
  summary: string;
  classifiedAt: string;
}

// ---------------------------------------------------------------------------
// Session listing types
// ---------------------------------------------------------------------------

/** Public session info returned by listing and lookup APIs. */
export interface SessionInfo {
  sessionId: string | null;
  agent: Agent;
  workdir: string | null;
  workspacePath: string | null;
  threadId?: string | null;
  model: string | null;
  thinkingEffort?: string | null;
  createdAt: string | null;
  title: string | null;
  running: boolean;
  runState: SessionRunState;
  runDetail: string | null;
  runUpdatedAt: string | null;
  runPid?: number | null;
  classification: SessionClassification | null;
  userStatus: 'inbox' | 'active' | 'review' | 'done' | 'parked' | null;
  userNote: string | null;
  lastQuestion: string | null;
  lastAnswer: string | null;
  lastMessageText: string | null;
  migratedFrom: SessionLineageRef | null;
  migratedTo: SessionLineageRef | null;
  linkedSessions: SessionLineageRef[];
  numTurns: number | null;
  handoverFrom?: HandoverRef | null;
}

/** Result of a session list request. */
export interface SessionListResult {
  ok: boolean;
  sessions: SessionInfo[];
  error: string | null;
}

/** Options for listing sessions. */
export interface SessionListOpts {
  agent: Agent;
  workdir: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Session tail / message types
// ---------------------------------------------------------------------------

/** A single message in a session tail (plain text). */
export interface TailMessage { role: 'user' | 'assistant'; text: string; }

/** A content block within a message — text, thinking, tool activity, or image. */
export interface MessageBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'plan' | 'sub_agent';
  content: string;
  toolName?: string;
  toolId?: string;
  phase?: 'commentary' | 'final_answer';
  plan?: StreamPreviewPlan | null;
  /** Set on `sub_agent` blocks — captures the Task invocation as a discrete unit. */
  subAgent?: StreamSubAgent | null;
}

/** Rich message with structured content blocks. */
export interface RichMessage {
  role: 'user' | 'assistant';
  text: string;
  blocks: MessageBlock[];
  /**
   * Per-turn token usage snapshot for assistant messages. Mirrors the live
   * `StreamPreviewMeta` shape so the dashboard can render the same chip on
   * historical turns. Drivers that don't expose per-message usage (Codex,
   * Gemini) leave this null and the chip is omitted.
   */
  usage?: StreamPreviewMeta | null;
}

/** Result of a session tail request. */
export interface SessionTailResult {
  ok: boolean;
  messages: TailMessage[];
  error: string | null;
}

/** Options for tailing the last messages in a session. */
export interface SessionTailOpts {
  agent: Agent;
  sessionId: string;
  workdir: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Session messages (full read) types
// ---------------------------------------------------------------------------

/** Options for reading the full message history of a session. */
export interface SessionMessagesOpts {
  sessionId: string;
  workdir: string;
  /** Only return last N turns (1 turn = user + assistant). Omit for all. */
  lastNTurns?: number;
  /** Number of newest turns to skip before returning the current window. */
  turnOffset?: number;
  /** Maximum number of turns to return in the current window. */
  turnLimit?: number;
  /** If true, return rich messages with content blocks instead of plain text. */
  rich?: boolean;
}

/** Pagination window metadata for session message results. */
export interface SessionMessagesWindow {
  offset: number;
  limit: number;
  returnedTurns: number;
  totalTurns: number;
  hasOlder: boolean;
  hasNewer: boolean;
  startTurn: number;
  endTurn: number;
}

/** Result of a full session message read. */
export interface SessionMessagesResult {
  ok: boolean;
  messages: TailMessage[];
  richMessages?: RichMessage[];
  totalTurns: number;
  window?: SessionMessagesWindow;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Stage / ensure session types
// ---------------------------------------------------------------------------

/** Options for staging files into a session workspace. */
export interface StageSessionFilesOpts {
  agent: Agent;
  workdir: string;
  files: string[];
  sessionId?: string | null;
  title?: string | null;
  threadId?: string | null;
  /** When creating a fresh session due to cross-agent switch, record the source. */
  handoverFrom?: HandoverRef | null;
}

/** Result of staging files into a session workspace. */
export interface StageSessionFilesResult {
  sessionId: string;
  workspacePath: string;
  threadId: string | null;
  importedFiles: string[];
  handoverFrom: HandoverRef | null;
}

/** Options for ensuring a managed session exists. */
export interface EnsureManagedSessionOpts {
  agent: Agent;
  workdir: string;
  sessionId: string;
  title?: string | null;
  model?: string | null;
  threadId?: string | null;
}

// ---------------------------------------------------------------------------
// Export / import / migration types
// ---------------------------------------------------------------------------

/** Options for exporting a session to a file format. */
export interface ExportSessionOpts {
  workdir: string;
  agent: Agent;
  sessionId: string;
  format: 'markdown' | 'json' | 'text';
  lastNTurns?: number;
}

/** Result of a session export. */
export interface ExportSessionResult {
  ok: boolean;
  content: string;
  filename: string;
  error: string | null;
}

/** Options for importing a session from external content. */
export interface ImportSessionOpts {
  workdir: string;
  agent: Agent;
  content: string;
  format?: 'markdown' | 'json' | 'text';
}

/** Result of a session import. */
export interface ImportSessionResult {
  ok: boolean;
  /** Parsed messages ready to inject as context */
  messages: TailMessage[];
  error: string | null;
}

/** Options for migrating a session from one agent to another. */
export interface MigrateSessionOpts {
  source: { workdir: string; agent: Agent; sessionId: string };
  target: { workdir: string; agent: Agent };
  lastNTurns?: number;
}

// ---------------------------------------------------------------------------
// Agent listing types
// ---------------------------------------------------------------------------

/** Information about a detected agent CLI binary. */
export interface AgentInfo {
  agent: string;
  installed: boolean;
  path: string | null;
  version: string | null;
}

/** Result of listing all known agents. */
export interface AgentListResult { agents: AgentInfo[]; }

// ---------------------------------------------------------------------------
// Model listing types
// ---------------------------------------------------------------------------

/** A single model entry returned by the agent's model list. */
export interface ModelInfo { id: string; alias: string | null; }

/** Result of listing models for an agent. */
export interface ModelListResult {
  agent: Agent;
  models: ModelInfo[];
  sources: string[];
  note: string | null;
}

/** Options for listing models. */
export interface ModelListOpts {
  workdir?: string;
  currentModel?: string | null;
}

// ---------------------------------------------------------------------------
// Usage types
// ---------------------------------------------------------------------------

/** A single usage rate-limit window (e.g. "5h", "7d"). */
export interface UsageWindowInfo {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  resetAfterSeconds: number | null;
  status: string | null;
}

/** Result of a usage/rate-limit query for an agent. */
export interface UsageResult {
  ok: boolean;
  agent: Agent;
  source: string | null;
  capturedAt: string | null;
  status: string | null;
  windows: UsageWindowInfo[];
  error: string | null;
}

/** Options for querying agent usage. */
export interface UsageOpts {
  agent: Agent;
  model?: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Set of image file extensions recognised for workspace file handling. */
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
