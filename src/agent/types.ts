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
  contextPercent: number | null;
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
  /** Override stdin payload (used for stream-json multimodal input) */
  _stdinOverride?: string;
  /** MCP bridge: callback when agent requests file send via MCP tool. Enables MCP bridge when provided. */
  mcpSendFile?: import('./mcp/bridge.js').McpSendFileCallback;
  /** Path to MCP config JSON — set by prepareStreamOpts, consumed by drivers. */
  mcpConfigPath?: string;
  /** Extra environment variables for the spawned agent process. */
  extraEnv?: Record<string, string>;
  /** Abort the in-flight stream. */
  abortSignal?: AbortSignal;
  /** Optional callback for agent human-in-the-loop interactions (all drivers). */
  onInteraction?: (request: AgentInteraction) => Promise<Record<string, any> | null>;
  /** Optional callback when a running agent can accept steer input in-place. */
  onSteerReady?: (steer: (prompt: string, attachments?: string[]) => Promise<boolean>) => void;
  /** Optional callback when a Codex turn can be steered in place. */
  onCodexTurnReady?: (control: CodexTurnControl) => void;
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
  stagedFiles: string[];
  runState: SessionRunState;
  runDetail: string | null;
  runUpdatedAt: string | null;
  classification: SessionClassification | null;
  userStatus: 'inbox' | 'active' | 'review' | 'done' | 'parked' | null;
  userNote: string | null;
  lastQuestion: string | null;
  lastAnswer: string | null;
  lastMessageText: string | null;
  lastThinking: string | null;
  lastPlan: StreamPreviewPlan | null;
  migratedFrom: { agent: Agent; sessionId: string } | null;
  migratedTo: { agent: Agent; sessionId: string } | null;
  linkedSessions: Array<{ agent: Agent; sessionId: string }>;
  numTurns?: number | null;
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
  createdAt: string | null;
  title: string | null;
  running: boolean;
  runState: SessionRunState;
  runDetail: string | null;
  runUpdatedAt: string | null;
  classification: SessionClassification | null;
  userStatus: 'inbox' | 'active' | 'review' | 'done' | 'parked' | null;
  userNote: string | null;
  lastQuestion: string | null;
  lastAnswer: string | null;
  lastMessageText: string | null;
  migratedFrom: { agent: Agent; sessionId: string } | null;
  migratedTo: { agent: Agent; sessionId: string } | null;
  linkedSessions: Array<{ agent: Agent; sessionId: string }>;
  numTurns: number | null;
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
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'plan';
  content: string;
  toolName?: string;
  toolId?: string;
  phase?: 'commentary' | 'final_answer';
  plan?: StreamPreviewPlan | null;
}

/** Rich message with structured content blocks. */
export interface RichMessage {
  role: 'user' | 'assistant';
  text: string;
  blocks: MessageBlock[];
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
}

/** Result of staging files into a session workspace. */
export interface StageSessionFilesResult {
  sessionId: string;
  workspacePath: string;
  threadId: string | null;
  importedFiles: string[];
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
