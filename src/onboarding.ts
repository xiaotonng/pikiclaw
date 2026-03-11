import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentInfo } from './code-agent.js';

export type AuthStatus = 'ready' | 'needs_login' | 'unknown';
export type ChannelStatus = 'ready' | 'missing' | 'invalid' | 'error';
export type SetupChannel = 'telegram' | 'feishu' | 'whatsapp';

export interface AgentSetupState extends AgentInfo {
  label: string;
  installCommand: string;
  loginCommand: string;
  authStatus: AuthStatus;
  authDetail: string;
}

export interface ChannelSetupState {
  channel: SetupChannel;
  configured: boolean;
  ready: boolean;
  validated: boolean;
  status: ChannelStatus;
  detail: string;
}

export interface SetupState {
  nodeVersion: string;
  nodeOk: boolean;
  channel: string;
  tokenProvided: boolean;
  agents: AgentSetupState[];
  channels?: ChannelSetupState[];
}

function parseMajor(version: string): number {
  const major = Number.parseInt(String(version || '').split('.')[0] || '', 10);
  return Number.isFinite(major) ? major : 0;
}

export function isSupportedNode(version = process.versions.node): boolean {
  return parseMajor(version) >= 18;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function hasClaudeKeychainToken(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    return !!raw;
  } catch {
    return false;
  }
}

function detectClaudeAuth(homeDir: string): { status: AuthStatus; detail: string } {
  if ((process.env.ANTHROPIC_API_KEY || '').trim()) {
    return { status: 'ready', detail: 'ANTHROPIC_API_KEY detected.' };
  }
  if (hasClaudeKeychainToken()) {
    return { status: 'ready', detail: 'Local Claude credentials detected.' };
  }

  const claudeStatePaths = [
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.claude'),
  ];
  if (claudeStatePaths.some(fileExists)) {
    return {
      status: 'unknown',
      detail: 'Local Claude state was found, but sign-in could not be verified automatically.',
    };
  }

  return {
    status: 'needs_login',
    detail: 'No local Claude credentials were detected.',
  };
}

function hasCodexAuthFile(homeDir: string): boolean {
  const authPath = path.join(homeDir, '.codex', 'auth.json');
  if (!fileExists(authPath)) return false;
  try {
    const raw = fs.readFileSync(authPath, 'utf-8');
    return /access|refresh|token|api[_-]?key/i.test(raw);
  } catch {
    return true;
  }
}

function hasCodexState(homeDir: string): boolean {
  const codexDir = path.join(homeDir, '.codex');
  if (!fileExists(codexDir)) return false;

  try {
    const entries = fs.readdirSync(codexDir);
    if (entries.some(name => /^state.*\.sqlite$/i.test(name))) return true;
    if (entries.includes('sessions')) return true;
  } catch {
    return true;
  }

  return false;
}

function detectCodexAuth(homeDir: string): { status: AuthStatus; detail: string } {
  if ((process.env.OPENAI_API_KEY || '').trim()) {
    return { status: 'ready', detail: 'OPENAI_API_KEY detected.' };
  }
  if (hasCodexAuthFile(homeDir)) {
    return { status: 'ready', detail: 'Local Codex credentials detected.' };
  }
  if (hasCodexState(homeDir)) {
    return {
      status: 'unknown',
      detail: 'Local Codex state was found, but sign-in could not be verified automatically.',
    };
  }

  return {
    status: 'needs_login',
    detail: 'No local Codex credentials were detected.',
  };
}

function detectGeminiAuth(homeDir: string): { status: AuthStatus; detail: string } {
  if ((process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '').trim()) {
    return { status: 'ready', detail: 'GOOGLE_API_KEY or GEMINI_API_KEY detected.' };
  }

  const geminiStatePaths = [
    path.join(homeDir, '.gemini'),
    path.join(homeDir, '.config', 'gemini'),
  ];
  if (geminiStatePaths.some(fileExists)) {
    return {
      status: 'unknown',
      detail: 'Local Gemini state detected. Verify login manually.',
    };
  }

  return {
    status: 'needs_login',
    detail: 'No local Gemini credentials were detected.',
  };
}

function enrichAgent(agent: AgentInfo): AgentSetupState {
  const homeDir = os.homedir();
  const auth = agent.agent === 'claude'
    ? detectClaudeAuth(homeDir)
    : agent.agent === 'gemini'
      ? detectGeminiAuth(homeDir)
      : detectCodexAuth(homeDir);
  const label = agent.agent === 'claude'
    ? 'Claude Code'
    : agent.agent === 'gemini'
      ? 'Gemini CLI'
      : 'Codex';
  const installCommand = agent.agent === 'claude'
    ? 'npm install -g @anthropic-ai/claude-code'
    : agent.agent === 'gemini'
      ? 'npm install -g @google/gemini-cli'
      : 'npm install -g @openai/codex';

  return {
    ...agent,
    label,
    installCommand,
    loginCommand: agent.agent,
    authStatus: agent.installed ? auth.status : 'needs_login',
    authDetail: agent.installed ? auth.detail : 'Not installed yet.',
  };
}

function defaultChannelState(channel: string, tokenProvided: boolean): ChannelSetupState {
  if (channel === 'telegram') {
    return {
      channel: 'telegram',
      configured: tokenProvided,
      ready: tokenProvided,
      validated: false,
      status: tokenProvided ? 'ready' : 'missing',
      detail: tokenProvided ? 'Telegram credentials are configured.' : 'Telegram is not configured.',
    };
  }
  if (channel === 'feishu') {
    return {
      channel: 'feishu',
      configured: tokenProvided,
      ready: tokenProvided,
      validated: false,
      status: tokenProvided ? 'ready' : 'missing',
      detail: tokenProvided ? 'Feishu credentials are configured.' : 'Feishu is not configured.',
    };
  }
  return {
    channel: 'whatsapp',
    configured: tokenProvided,
    ready: tokenProvided,
    validated: false,
    status: tokenProvided ? 'ready' : 'missing',
    detail: tokenProvided ? 'WhatsApp credentials are configured.' : 'WhatsApp is not configured.',
  };
}

export function collectSetupState(args: {
  agents: AgentInfo[];
  channel: string;
  tokenProvided: boolean;
  nodeVersion?: string;
  channels?: ChannelSetupState[];
}): SetupState {
  const nodeVersion = args.nodeVersion || process.versions.node;
  return {
    nodeVersion,
    nodeOk: isSupportedNode(nodeVersion),
    channel: args.channel,
    tokenProvided: args.tokenProvided,
    agents: args.agents.map(enrichAgent),
    channels: args.channels?.length ? args.channels : [defaultChannelState(args.channel, args.tokenProvided)],
  };
}

function agentSummary(state: AgentSetupState): string[] {
  if (!state.installed) {
    return [
      `MISSING  ${state.label} is not installed.`,
      `         Install with: ${state.installCommand}`,
    ];
  }

  const version = state.version ? ` (${state.version})` : '';
  const lines = [
    `OK       ${state.label} found at ${state.path || '(unknown path)'}${version}`,
  ];

  if (state.authStatus === 'ready') {
    lines.push(`OK       ${state.label} sign-in looks ready. ${state.authDetail}`);
  } else if (state.authStatus === 'unknown') {
    lines.push(`NOTICE   ${state.authDetail}`);
    lines.push(`         Run \`${state.loginCommand}\` once and finish sign-in if prompted.`);
  } else {
    lines.push(`NOTICE   ${state.authDetail}`);
    lines.push(`         Run \`${state.loginCommand}\` once and sign in before starting codeclaw.`);
  }

  return lines;
}

export function hasReadyAgent(state: SetupState): boolean {
  return state.agents.some(agent => agent.installed && agent.authStatus === 'ready');
}

export function hasInstalledAgent(state: SetupState): boolean {
  return state.agents.some(agent => agent.installed);
}

export function isSetupReady(state: SetupState): boolean {
  const readyChannel = state.channels?.some(channel => channel.ready) ?? state.tokenProvided;
  return state.nodeOk && readyChannel && hasReadyAgent(state);
}

export function buildSetupGuide(state: SetupState, version: string, options?: { doctor?: boolean }): string {
  const doctor = !!options?.doctor;
  const isTelegram = state.channel === 'telegram';
  const channelLabel = isTelegram ? 'Telegram' : state.channel === 'feishu' ? 'Feishu' : state.channel === 'whatsapp' ? 'WhatsApp' : 'your chat app';
  const lines: string[] = [
    `codeclaw v${version}`,
    '',
    doctor ? 'Setup check' : 'First-time setup',
    '',
    `codeclaw connects ${channelLabel} to a local coding agent running on your machine.`,
    'Before the bot can start, make sure these basics are ready:',
    '1. Node.js 18 or newer',
    '2. Claude Code or Codex installed locally',
    isTelegram
      ? '3. A Telegram bot token from @BotFather'
      : '3. A supported channel token',
    '',
    'Step 1/3  Check Node.js',
    state.nodeOk
      ? `OK       Node.js ${state.nodeVersion}`
      : `MISSING  Node.js ${state.nodeVersion} detected. codeclaw requires Node.js 18 or newer.`,
    '',
    'Step 2/3  Check your local coding agent',
  ];

  for (const agent of state.agents) lines.push(...agentSummary(agent));

  lines.push(
    '',
    isTelegram ? 'Step 3/3  Get a Telegram bot token' : 'Step 3/3  Check channel access',
  );

  if (isTelegram && state.tokenProvided) {
    lines.push('OK       A Telegram token was provided.');
  } else if (isTelegram) {
    lines.push(
      'MISSING  No Telegram token configured in ~/.codeclaw/setting.json',
      '         Run `codeclaw` to open the dashboard and configure, or:',
      '         1. Open Telegram and search for @BotFather',
      '         2. Send /newbot and copy the token',
      '         3. Add to ~/.codeclaw/setting.json: { "telegramBotToken": "..." }',
    );
  } else if (state.channel === 'feishu' && state.tokenProvided) {
    lines.push('OK       Feishu credentials provided (FEISHU_APP_ID + FEISHU_APP_SECRET).');
  } else if (state.channel === 'feishu') {
    lines.push(
      'MISSING  No Feishu credentials configured in ~/.codeclaw/setting.json',
      '         Run `codeclaw` to open the dashboard and configure, or add feishuAppId/feishuAppSecret to setting.json.',
    );
  } else if (state.channel === 'whatsapp') {
    lines.push('MISSING  WhatsApp setup is not available yet. Use `--channel telegram` for now.');
  } else if (state.tokenProvided) {
    lines.push('OK       A channel token was provided.');
  } else {
    lines.push('MISSING  No supported channel token was provided.');
  }

  lines.push('');
  if (state.tokenProvided) {
    lines.push('Start command:');
    lines.push('  npx codeclaw@latest');
  } else if (!isTelegram) {
    lines.push('Start command:');
    lines.push('  npx codeclaw@latest --channel telegram -t <YOUR_BOT_TOKEN>');
  } else {
    lines.push('Start command after you have the token:');
    lines.push('  npx codeclaw@latest -t <YOUR_BOT_TOKEN>');
  }

  lines.push(
    '',
    'Tips:',
    '  - Run `claude` or `codex` once first if you are not sure whether sign-in is complete.',
    '  - Run `npx codeclaw@latest --doctor` any time to re-check your setup.',
    '  - Run `npx codeclaw@latest --help` for the full CLI reference.',
  );

  if (!doctor && !hasInstalledAgent(state)) {
    lines.push('', 'You only need one local coding agent. Install Claude Code or Codex, then come back.');
  }

  return `${lines.join('\n')}\n`;
}
