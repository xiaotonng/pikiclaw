/**
 * agent/index.ts — Barrel export for the agent layer.
 *
 * This module loads all agent drivers (side-effect) and re-exports the public
 * API from focused sub-modules:
 *
 *   types.ts    — Shared type definitions (StreamOpts, StreamResult, SessionInfo, …)
 *   utils.ts    — Pure utility functions (Q, agentLog, normalizeErrorMessage, …)
 *   session.ts  — Session workspace management, metadata, classification, export/import
 *   stream.ts   — CLI spawn framework, stream orchestration, agent detection, delegation
 *   driver.ts   — AgentDriver interface and registry
 *   skills.ts   — Project skill discovery
 *   drivers/    — Per-agent driver implementations (claude, codex, gemini)
 */

// ── Load all drivers (side-effect: each calls registerDriver) ───────────────
import './drivers/claude.js';
import './drivers/codex.js';
import './drivers/gemini.js';

// ── Re-export: types ────────────────────────────────────────────────────────
export type {
  Agent, AgentDetectOptions, AgentInfo, AgentListResult,
  CodexCumulativeUsage, CodexInteractionOption, CodexInteractionQuestion,
  CodexInteractionRequest, CodexTurnControl,
  StreamPreviewMeta, StreamPreviewPlanStep, StreamPreviewPlan,
  StreamOpts, StreamResult,
  ManagedSessionRecord, SessionRunState, SessionClassification,
  SessionInfo, SessionListResult, SessionListOpts,
  TailMessage, MessageBlock, RichMessage,
  SessionTailResult, SessionTailOpts,
  SessionMessagesOpts, SessionMessagesWindow, SessionMessagesResult,
  StageSessionFilesOpts, StageSessionFilesResult, EnsureManagedSessionOpts,
  ExportSessionOpts, ExportSessionResult, ImportSessionOpts, ImportSessionResult,
  MigrateSessionOpts,
  ModelInfo, ModelListResult, ModelListOpts,
  UsageWindowInfo, UsageResult, UsageOpts,
} from './types.js';
export { IMAGE_EXTS } from './types.js';

// ── Re-export: utilities ────────────────────────────────────────────────────
export {
  Q, agentLog, agentWarn, agentError,
  dedupeStrings, numberOrNull,
  normalizeStreamPreviewPlan, parseTodoWriteAsPlan, normalizeActivityLine, pushRecentActivity,
  firstNonEmptyLine, shortValue, normalizeErrorMessage, joinErrorMessages,
  appendSystemPrompt, mimeForExt, computeContext, buildStreamPreviewMeta,
  summarizeClaudeToolUse, summarizeClaudeToolResult,
  roundPercent, toIsoFromEpochSeconds, normalizeUsageStatus,
  labelFromWindowMinutes, usageWindowFromRateLimit,
  parseJsonTail, modelFamily, normalizeClaudeModelId, emptyUsage,
  readTailLines, stripInjectedPrompts, sanitizeSessionUserPreviewText,
  SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE,
  isPendingSessionId,
} from './utils.js';

// ── Re-export: session management ───────────────────────────────────────────
export {
  updateSessionMeta, promoteSessionId,
  listPikiclawSessions, findPikiclawSession,
  ensureManagedSession, findManagedThreadSession, stageSessionFiles,
  mergeManagedAndNativeSessions,
  getSessions, getSessionTail, getSessionMessages,
  applyTurnWindow, applyTurnFilter,
  classifySession, deriveUserStatus,
  exportSession, importSession,
} from './session.js';

// ── Re-export: stream & detection ───────────────────────────────────────────
export {
  detectAgentBin, listAgents,
  run, doStream,
  listModels, getUsage,
} from './stream.js';

// ── Re-export: driver registry ──────────────────────────────────────────────
export {
  type AgentDriver, registerDriver, getDriver,
  allDrivers, allDriverIds, hasDriver, shutdownAllDrivers,
} from './driver.js';

// ── Re-export: skills ───────────────────────────────────────────────────────
export {
  getProjectSkillPaths, initializeProjectSkills, listSkills,
  type ProjectSkillPaths, type SkillInfo, type SkillListResult,
} from './skills.js';

// ── Re-export: driver-specific functions ────────────────────────────────────
export { doClaudeStream } from './drivers/claude.js';
export { doCodexStream, buildCodexTurnInput, shutdownCodexServer, getCodexUsageLive } from './drivers/codex.js';
export { doGeminiStream } from './drivers/gemini.js';
