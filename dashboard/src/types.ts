export type Agent = 'claude' | 'codex' | 'gemini' | 'hermes';
export type OpenTarget = 'vscode' | 'cursor' | 'windsurf' | 'finder' | 'default';

export interface AgentInfo {
  agent: Agent;
  label: string;
  installed: boolean;
  version?: string;
  installCommand?: string;
}

export interface ModelInfo {
  id: string;
  alias: string | null;
}

export interface UsageWindowInfo {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  resetAfterSeconds: number | null;
  status: string | null;
}

export interface UsageResult {
  ok: boolean;
  agent: Agent;
  source: string | null;
  capturedAt: string | null;
  status: string | null;
  windows: UsageWindowInfo[];
  error: string | null;
}

/**
 * Read-only snapshot of an agent's *external* configuration (e.g. Hermes'
 * ~/.hermes/config.yaml). Pikiclaw never writes to the source — this is
 * surfaced only so the dashboard can display what an unbound agent will
 * actually run with.
 */
export interface AgentNativeConfig {
  model: string;
  provider: string;
  baseURL: string | null;
  effort: string | null;
  configPath: string;
  source: string;
}

export interface AgentRuntimeStatus extends AgentInfo {
  selectedModel: string | null;
  selectedEffort: string | null;
  /** Native-auth model/effort, independent of any active BYOK Profile.
   *  AgentTab uses these when the user toggles a card back to "Native"
   *  provider, so a previously-active BYOK model id doesn't leak in as the
   *  initial value of the native-mode model field. */
  nativeSelectedModel?: string | null;
  nativeSelectedEffort?: string | null;
  isDefault: boolean;
  models: ModelInfo[];
  usage: UsageResult | null;
  /** Driver-supplied snapshot of the agent's external config, when applicable. */
  nativeConfig?: AgentNativeConfig | null;
  /** Static driver capability flags, e.g. fork support. */
  capabilities?: { fork?: boolean; modelSwitch?: boolean };
  /** BYOK provider name (e.g. "OpenRouter") when this agent has a Profile
   *  bound; null otherwise. Drives the dashboard "via <provider>" tag on
   *  turns where the bound model id matches the saved turn's model. */
  byokProviderName?: string | null;
  /** Cached model list of the BYOK-bound provider (from `/models`). Surfaced
   *  separately from the native `models` field so AgentTab can still list the
   *  CLI's native catalogue when the user previews the "native" provider.
   *  InputComposer's cascade prefers this when `byokProviderName` is set. */
  byokModels?: { id: string; alias: string | null }[] | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  updateStatus?: string | null;
  updateDetail?: string | null;
}

export interface AgentStatusResponse {
  defaultAgent: Agent;
  workdir: string;
  agents: AgentRuntimeStatus[];
}

export type ChannelStatus = 'ready' | 'missing' | 'invalid' | 'error' | 'checking';

export interface ChannelSetupState {
  channel: 'telegram' | 'feishu' | 'weixin' | 'slack' | 'discord' | 'dingtalk' | 'wecom';
  configured: boolean;
  ready: boolean;
  validated: boolean;
  status: ChannelStatus;
  detail: string;
}

export interface SetupState {
  agents: AgentInfo[];
  channel: string;
  tokenProvided: boolean;
  channels?: ChannelSetupState[];
}

export interface PermissionStatus {
  granted: boolean;
  checkable: boolean;
  detail: string;
}

export type PermissionRequestAction = 'already_granted' | 'prompted' | 'opened_settings' | 'unsupported';

export interface PermissionRequestResult {
  ok: boolean;
  action: PermissionRequestAction;
  granted: boolean;
  requiresManualGrant: boolean;
  error?: string;
}

export interface BotStatus {
  workdir: string;
  defaultAgent: Agent;
  uptime: number;
  connected: boolean;
  stats: {
    totalTurns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  activeTasks: number;
  sessions: number;
}

export interface UserConfig {
  defaultAgent?: Agent;
  claudeModel?: string;
  claudeReasoningEffort?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  geminiModel?: string;
  workdir?: string;
  telegramBotToken?: string;
  telegramAllowedChatIds?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  weixinBaseUrl?: string;
  weixinBotToken?: string;
  weixinAccountId?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  discordBotToken?: string;
  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomEndpoint?: string;
  channels?: string[];
  browserEnabled?: boolean;
  browserHeadless?: boolean;
}

export interface WeixinValidationResult {
  ok: boolean;
  error?: string | null;
  normalizedBaseUrl?: string;
  account?: {
    accountId: string;
    baseUrl: string;
  } | null;
}

export interface WeixinLoginStartResult {
  ok: boolean;
  sessionKey: string;
  qrcodeUrl?: string;
  message: string;
  error?: string;
}

export interface WeixinLoginWaitResult {
  ok: boolean;
  connected: boolean;
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error';
  message: string;
  qrcodeUrl?: string;
  botToken?: string;
  accountId?: string;
  userId?: string;
  baseUrl?: string;
  error?: string;
}

export interface AppState {
  version: string;
  ready: boolean;
  configExists: boolean;
  config: UserConfig;
  runtimeWorkdir: string;
  setupState: SetupState | null;
  permissions: Record<string, PermissionStatus>;
  hostApp?: string | null;
  platform: string;
  pid: number;
  nodeVersion?: string;
  bot: BotStatus | null;
}

export interface HostInfo {
  hostName: string;
  cpuModel: string;
  cpuCount: number;
  totalMem: number;
  freeMem: number;
  memoryUsed?: number;
  memoryPercent?: number;
  platform: string;
  arch: string;
  cpuUsage?: { usedPercent: number };
  loadAverage?: { one: number; five: number; fifteen: number } | null;
  disk?: { used: string; total: string; percent: string };
  battery?: { percent: string; state: string };
}

// ---------------------------------------------------------------------------
// Local model backends (Ollama / LM Studio)
// ---------------------------------------------------------------------------

export interface LocalBackendStatus {
  id: 'ollama' | 'lmstudio';
  label: string;
  detected: boolean;
  version?: string;
  baseURL: string;
  openAIBaseURL: string;
  models: Array<{ id: string; sizeBytes?: number }>;
  /** Provider id (in the BYOK layer) already pointing at this backend, if any. */
  existingProviderId: string | null;
  installHint: { homepage: string; brewFormula?: string };
}

export interface LocalModelCatalogEntry {
  id: string;
  name: string;
  publisher: string;
  paramsB: number;
  sizeGb: number;
  minRamGb: number;
  description: string;
  descriptionZh: string;
  ollamaTag?: string;
  lmstudioId?: string;
  homepage?: string;
  installed: { backend: 'ollama' | 'lmstudio'; id: string } | null;
}

export interface LocalModelsProbeResponse {
  ok: boolean;
  backends?: LocalBackendStatus[];
  catalog?: LocalModelCatalogEntry[];
  error?: string;
}

/**
 * Single selectable option in a human-in-the-loop interaction question.
 * Mirrors AgentInteractionOption from the server.
 */
export interface InteractionOption {
  label: string;
  description?: string | null;
  value: string;
}

/** A single question presented in a human-in-the-loop interaction prompt. */
export interface InteractionQuestion {
  id: string;
  header: string;
  prompt: string;
  options?: InteractionOption[] | null;
  allowFreeform?: boolean;
  secret?: boolean;
  allowEmpty?: boolean;
}

/**
 * Serialisable snapshot of an active human-in-the-loop prompt. Mirrors the
 * server's InteractionSnapshot — surfaces in session stream snapshots so the
 * dashboard can render the matching popup.
 */
export interface InteractionSnapshot {
  promptId: string;
  kind: 'user-input' | 'permission' | 'confirmation';
  title: string;
  hint?: string | null;
  questions: InteractionQuestion[];
  /** 0-based index of the question currently awaiting an answer. Used by the
   *  client to render the active question on initial load / reconnect. */
  currentIndex?: number;
}

export interface SessionInfo {
  sessionId: string;
  title?: string;
  createdAt?: string;
  running?: boolean;
  isCurrent?: boolean;
  model?: string;
  thinkingEffort?: string | null;
  workdir?: string;
  runState: 'running' | 'completed' | 'incomplete';
  runDetail?: string | null;
  runUpdatedAt?: string | null;
  agent?: string;
  lastQuestion?: string | null;
  lastAnswer?: string | null;
  lastMessageText?: string | null;
  classification?: {
    outcome: 'answer' | 'proposal' | 'implementation' | 'partial' | 'blocked' | 'conversation';
    summary: string;
    suggestedNextAction?: string | null;
    classifiedAt?: string;
  } | null;
  userStatus?: 'inbox' | 'active' | 'review' | 'done' | 'parked' | null;
  userNote?: string | null;
  workspacePath?: string | null;
  migratedFrom?: SessionLineageRef | null;
  migratedTo?: SessionLineageRef | null;
  linkedSessions?: SessionLineageRef[];
  numTurns?: number | null;
}

/** Reference to a related session (migration twin or fork child/parent). */
export interface SessionLineageRef {
  agent: Agent;
  sessionId: string;
  /** 'fork' = branch off at a turn, 'migrate' = cross-agent twin (default). */
  kind?: 'migrate' | 'fork';
  /** 0-based turn index where the fork occurred (set on `migratedFrom` only). */
  forkedAtTurn?: number;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
}

export interface SessionHubResult {
  ok: boolean;
  workdir: string;
  workspaceName: string;
  sessions: SessionInfo[];
  statusCounts: Record<string, number>;
  total: number;
  errors: string[];
}

export interface SessionsPageResult {
  ok: boolean;
  sessions: SessionInfo[];
  error: string | null;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface SessionTailMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface MessageBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'plan' | 'sub_agent';
  content: string;
  toolName?: string;
  toolId?: string;
  phase?: 'commentary' | 'final_answer';
  plan?: StreamPlan | null;
  subAgent?: StreamSubAgent | null;
}

export interface RichMessage {
  role: 'user' | 'assistant';
  text: string;
  blocks: MessageBlock[];
  /** Per-turn token usage snapshot for assistant messages. Null when the
   *  driver does not surface per-message usage (Codex, Gemini). */
  usage?: StreamPreviewMeta | null;
}

export interface StreamPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface StreamPlan {
  explanation: string | null;
  steps: StreamPlanStep[];
}

export interface StreamPreviewMeta {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** Single-call context window occupancy. Use this for "% of context used"
   *  displays — the cumulative inputTokens/cachedInputTokens fields above
   *  double-count the same cached prefix on every tool roundtrip. */
  contextUsedTokens?: number | null;
  contextPercent: number | null;
  subAgents?: StreamSubAgent[];
  /** BYOK provider name (e.g. "OpenRouter") when the agent is bound to a
   *  Profile; absent for native-auth turns. Drives the "via <provider>" tag. */
  providerName?: string | null;
}

export interface StreamSubAgent {
  id: string;
  kind: string | null;
  description: string | null;
  model: string | null;
  tools: Array<{ id: string; name: string; summary: string }>;
  status: 'running' | 'done' | 'failed';
}

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

export interface SessionMessagesResult {
  ok: boolean;
  messages: SessionMessage[];
  richMessages?: RichMessage[];
  totalTurns?: number;
  window?: SessionMessagesWindow;
  error: string | null;
}

export type BrowserProfileStatus = 'disabled' | 'ready' | 'needs_setup' | 'chrome_missing';

export interface BrowserStatus {
  status: BrowserProfileStatus;
  enabled: boolean;
  headlessMode: 'headless' | 'headed';
  chromeInstalled: boolean;
  profileCreated: boolean;
  running: boolean;
  pid: number | null;
  profileDir: string;
  detail?: string | null;
}

export interface BrowserStatusResponse {
  browser: BrowserStatus;
}

export interface BrowserSetupResponse {
  ok: boolean;
  browser: BrowserStatus;
  error?: string;
}

export interface SkillInfo {
  name: string;
  label: string | null;
  description: string | null;
  scope?: 'global' | 'project';
  mcpRequires?: string[];
}

// ---------------------------------------------------------------------------
// MCP Extensions
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  disabled?: boolean;
  catalogId?: string;
}

export interface McpExtensionEntry {
  name: string;
  config: McpServerConfig;
  scope: 'global' | 'workspace' | 'builtin';
  source?: string;
}

export interface McpHealthResult {
  ok: boolean;
  tools?: string[];
  error?: string;
  elapsedMs?: number;
  cached?: boolean;
}

export type McpCatalogState = 'recommended' | 'needs_auth' | 'disabled' | 'ready' | 'unhealthy';

export interface McpCredentialField {
  key: string;
  label: string;
  labelZh: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  helpUrl?: string;
}

export type McpAuthSpec =
  | { type: 'none' }
  | { type: 'credentials'; fields: McpCredentialField[] }
  | {
      type: 'mcp-oauth';
      authorizationEndpoint?: string;
      tokenEndpoint?: string;
      registrationEndpoint?: string;
      clientId?: string;
      scopes?: string[];
    };

export type RecommendedScope = 'global' | 'workspace' | 'both';

export interface McpCatalogItem {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  category: 'dev' | 'productivity' | 'communication' | 'data' | 'search' | 'utility' | 'custom';
  iconSlug?: string;
  iconUrl?: string;
  homepage?: string;
  transport: { type: 'stdio' | 'http'; summary: string };
  auth: McpAuthSpec;
  state: McpCatalogState;
  isRecommended: boolean;
  installed: boolean;
  scope?: 'global' | 'workspace' | 'builtin';
  config?: McpServerConfig;
  installedKey?: string;
  recommendedScope?: RecommendedScope;
  isBuiltin?: boolean;
}

export interface RecommendedSkillRepo {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  source: string;
  skills?: string[];
  category?: string;
  homepage?: string;
}

export interface SkillCatalogItem {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  source: string;
  category: string;
  recommendedScope?: RecommendedScope;
  homepage?: string;
  installed: boolean;
  scope?: 'global' | 'project';
  installedNames: string[];
  stars?: number;
  pushedAt?: string;
  iconUrl?: string;
  totalCount?: number;
  partial?: boolean;
}

export interface RemoteSkillInfo {
  name: string;
  description?: string;
  path: string;
}

export interface McpSearchResult {
  name: string;
  description: string;
  npmPackage?: string;
  source?: string;
}

export interface GitChange {
  status: 'added' | 'modified' | 'deleted';
  file: string;
  path: string;
}

export interface GitChangesResult {
  ok: boolean;
  changes: GitChange[];
  isGit: boolean;
  error?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir?: boolean;
}

export interface LsDirResult {
  ok: boolean;
  path: string;
  parent: string;
  dirs: DirEntry[];
  isGit: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// CLI Extensions
// ---------------------------------------------------------------------------

export type CliCategory = 'dev' | 'cloud' | 'productivity' | 'data';
export type CliState = 'not_installed' | 'installed_not_auth' | 'ready' | 'unknown';
export type CliAuthType = 'oauth-web' | 'token' | 'none';

export interface CliInstallCommand {
  cmd: string;
  label?: string;
}

export interface CliInstallSpec {
  darwin?: CliInstallCommand[];
  linux?: CliInstallCommand[];
  win?: CliInstallCommand[];
  docs?: string;
}

export interface CliAuthSpec {
  type: CliAuthType;
  statusArgv?: string[];
  loginArgv?: string[];
  logoutArgv?: string[];
  tokenFields?: McpCredentialField[];
  applyTokenArgv?: string[];
  envKey?: string;
  loginHint?: string;
  loginHintZh?: string;
}

export interface CliCatalogItem {
  id: string;
  binary: string;
  name: string;
  description: string;
  descriptionZh: string;
  category: CliCategory;
  iconSlug?: string;
  iconUrl?: string;
  homepage?: string;
  install: CliInstallSpec;
  auth: CliAuthSpec;
  state: CliState;
  version?: string;
  authDetail?: string;
  platform: 'darwin' | 'linux' | 'win';
  /** Present when the CLI has an npm-only install command that's safe to auto-run. */
  autoInstall?: { label: string };
}

export interface CliStatus {
  id: string;
  binary: string;
  state: CliState;
  version?: string;
  authDetail?: string;
  error?: string;
  checkedAt: number;
}

export type CliAuthStreamEvent =
  | { type: 'output'; chunk: string }
  | { type: 'status'; status: CliStatus }
  | { type: 'error'; message: string }
  | { type: 'done'; ok: boolean; exitCode: number | null };
