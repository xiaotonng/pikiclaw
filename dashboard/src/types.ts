export type Agent = 'claude' | 'codex' | 'gemini';

export interface AgentInfo {
  agent: Agent;
  label: string;
  installed: boolean;
  version?: string;
  authStatus?: string;
  installCommand?: string;
  authDetail?: string;
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

export type ChannelStatus = 'ready' | 'missing' | 'invalid' | 'error';

export interface ChannelSetupState {
  channel: 'telegram' | 'feishu' | 'whatsapp';
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

export interface BotStatus {
  workdir: string;
  defaultAgent: Agent;
  uptime: number;
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
  defaultWorkdir?: string;
  telegramBotToken?: string;
  telegramAllowedChatIds?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  channels?: string[];
}

export interface AppState {
  version: string;
  ready: boolean;
  config: UserConfig;
  runtimeWorkdir: string;
  setupState: SetupState | null;
  permissions: Record<string, PermissionStatus>;
  platform: string;
  pid: number;
  nodeVersion: string;
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
  disk?: { used: string; total: string; percent: string };
  battery?: { percent: string; state: string };
}

export interface SessionInfo {
  sessionId: string;
  localSessionId?: string;
  title?: string;
  createdAt?: string;
  running?: boolean;
  model?: string;
  workdir?: string;
}

export interface SessionTailMessage {
  role: 'user' | 'assistant';
  text: string;
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
