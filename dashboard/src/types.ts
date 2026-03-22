export type Agent = 'claude' | 'codex' | 'gemini';

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

export interface AgentRuntimeStatus extends AgentInfo {
  selectedModel: string | null;
  selectedEffort: string | null;
  isDefault: boolean;
  models: ModelInfo[];
  usage: UsageResult | null;
}

export interface AgentStatusResponse {
  defaultAgent: Agent;
  workdir: string;
  agents: AgentRuntimeStatus[];
}

export type ChannelStatus = 'ready' | 'missing' | 'invalid' | 'error' | 'checking';

export interface ChannelSetupState {
  channel: 'telegram' | 'feishu' | 'weixin' | 'whatsapp';
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

export interface SessionInfo {
  sessionId: string;
  title?: string;
  createdAt?: string;
  running?: boolean;
  isCurrent?: boolean;
  model?: string;
  workdir?: string;
  runState: 'running' | 'completed' | 'incomplete';
  runDetail?: string | null;
  runUpdatedAt?: string | null;
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
  desktop: {
    enabled: boolean;
    installed: boolean;
    running: boolean;
    appiumUrl: string;
  };
}

export interface BrowserSetupResponse {
  ok: boolean;
  browser: BrowserStatus;
  error?: string;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface LsDirResult {
  ok: boolean;
  path: string;
  parent: string;
  dirs: DirEntry[];
  isGit: boolean;
  error?: string;
}
