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
import './drivers/hermes.js';

// ── Re-export: types ────────────────────────────────────────────────────────
export type {
  Agent, AgentDetectOptions, AgentInfo, AgentListResult,
  AgentDriverCapabilities, SessionLineageRef,
  CodexCumulativeUsage, CodexTurnControl,
  AgentInteractionOption, AgentInteractionQuestion, AgentInteraction,
  StreamPreviewMeta, StreamPreviewPlanStep, StreamPreviewPlan, StreamSubAgent,
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
  isPendingSessionId, emitSessionIdUpdate,
  sessionListDisplayTitle,
} from './utils.js';

// ── Re-export: session management ───────────────────────────────────────────
export {
  updateSessionMeta, promoteSessionId, recordFork,
  listPikiclawSessions, findPikiclawSession, getSessionStoredConfig,
  ensureManagedSession, findManagedThreadSession, findThreadSessionAcrossAgents, stageSessionFiles,
  mergeManagedAndNativeSessions,
  getSessions, getSessionTail, getSessionMessages,
  applyTurnWindow, applyTurnFilter,
  classifySession, deriveUserStatus,
  exportSession, importSession,
  isProcessAlive, isRunningSessionStale, reconcileOrphanedRunningSessions,
} from './session.js';

// ── Re-export: stream & detection ───────────────────────────────────────────
export {
  detectAgentBin, listAgents,
  run, doStream,
  listModels, resolveAgentModels, getUsage, getAgentBoundModelId, setAgentBoundModelId,
} from './stream.js';

// ── Re-export: driver registry ──────────────────────────────────────────────
export {
  type AgentDriver, type AgentNativeConfig, registerDriver, getDriver, getDriverCapabilities,
  allDrivers, allDriverIds, hasDriver, shutdownAllDrivers,
} from './driver.js';

// ── Re-export: skills ───────────────────────────────────────────────────────
export {
  getProjectSkillPaths, initializeProjectSkills, listSkills, getGlobalSkillsRoot,
  collapseSkillPrompt,
  type ProjectSkillPaths, type SkillInfo, type SkillListResult, type SkillScope,
} from './skills.js';

// ── Re-export: goal (persistent thread objective) ────────────────────────────
export {
  readGoal, writeGoal, clearGoal, setGoal, pauseGoal, resumeGoal, completeGoal,
  accountTurn, bumpContinuationCount, shouldContinueAfterTurn,
  renderContinuationPrompt, renderBudgetLimitPrompt,
  sessionGoalPath, DEFAULT_MAX_CONTINUATIONS,
  type ThreadGoal, type GoalStatus, type TurnUsage, type ContinuationDecision,
} from './goal.js';

// ── Re-export: native codex goal bridge ──────────────────────────────────────
export {
  setCodexGoal, getCodexGoal, clearCodexGoal, pauseCodexGoal, resumeCodexGoal,
  type CodexThreadGoal, type CodexGoalStatus,
} from './drivers/codex.js';

// ── Re-export: native claude goal bridge ─────────────────────────────────────
export {
  getClaudeNativeGoal, buildClaudeSetGoalPrompt, buildClaudeClearGoalPrompt,
  type ClaudeNativeGoal, type ClaudeNativeGoalStatus,
} from './drivers/claude.js';

// ── Re-export: MCP extensions ───────────────────────────────────────────────
export {
  listAllMcpExtensions,
  addGlobalMcpExtension, removeGlobalMcpExtension, updateGlobalMcpExtension,
  addWorkspaceMcpExtension, removeWorkspaceMcpExtension, updateWorkspaceMcpExtension,
  loadGlobalMcpExtensions, loadWorkspaceMcpExtensions,
  getCatalogItems, getCatalogItem, buildInstalledConfigFromRecommended,
  checkMcpHealth, getCachedHealth, cacheHealth,
  type McpExtensionEntry, type ExtensionScope, type McpHealthResult,
  type McpCatalogItem, type McpCatalogState,
} from './mcp/extensions.js';

export {
  getRecommendedMcpServers, getRecommendedMcpServer, getRecommendedSkillRepos,
  searchMcpServers, searchSkills as searchSkillRepos,
  type RecommendedMcpServer, type RecommendedSkillRepo,
  type McpSearchResult, type SkillSearchResult,
  type McpAuthSpec, type McpTransportSpec, type McpCategory,
  type CredentialField, type SkillCategory,
} from './mcp/registry.js';

export {
  getMcpToken, saveMcpToken, deleteMcpToken, hasValidMcpToken,
  startAuthorization, completeAuthorization, refreshMcpToken, injectOAuthHeaders,
  type StartOAuthResult, type CompleteOAuthResult,
} from './mcp/oauth.js';

export {
  installSkill, removeSkill, checkSkillUpdates, getGlobalSkillsDir,
  type SkillInstallOpts, type SkillInstallResult, type SkillRemoveResult,
} from './skill-installer.js';

// ── Re-export: CLI extensions ───────────────────────────────────────────────
export {
  getRecommendedClis, getRecommendedCli,
  detectCli, getCachedCliStatus, invalidateCliStatus, currentPlatform,
  getCliCatalog, refreshCliStatus,
  startCliAuthSession, getAuthSession, cancelAuthSession,
  applyCliToken, logoutCli,
  startCliInstallSession,
  type RecommendedCli, type CliCategory, type CliAuthType,
  type CliInstallSpec, type CliInstallCommand, type CliAuthSpec,
  type CliState, type CliStatus, type CliCatalogItem,
  type AuthSession, type AuthSessionEvent,
  type ApplyTokenResult, type LogoutResult, type StartAuthSessionResult,
} from './cli/index.js';

// ── Re-export: driver-specific functions ────────────────────────────────────
export { doClaudeStream } from './drivers/claude.js';
export { doCodexStream, buildCodexTurnInput, shutdownCodexServer, getCodexUsageLive } from './drivers/codex.js';
export { doGeminiStream } from './drivers/gemini.js';
export { doHermesStream } from './drivers/hermes.js';
