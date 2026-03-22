import type { AgentInfo } from './code-agent.js';
import { getAgentInstallCommand, getAgentLabel } from './agent-npm.js';

export type ChannelStatus = 'ready' | 'missing' | 'invalid' | 'error' | 'checking';
export type SetupChannel = 'telegram' | 'feishu' | 'weixin' | 'whatsapp';

export interface AgentSetupState extends AgentInfo {
  label: string;
  installCommand: string;
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
  channel: string;
  tokenProvided: boolean;
  agents: AgentSetupState[];
  channels?: ChannelSetupState[];
}

function enrichAgent(agent: AgentInfo): AgentSetupState {
  const label = getAgentLabel(agent.agent);
  const installCommand = getAgentInstallCommand(agent.agent) || 'npm install -g <agent-package>';

  return {
    ...agent,
    label,
    installCommand,
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
  if (channel === 'weixin') {
    return {
      channel: 'weixin',
      configured: tokenProvided,
      ready: tokenProvided,
      validated: false,
      status: tokenProvided ? 'ready' : 'missing',
      detail: tokenProvided ? 'Weixin credentials are configured.' : 'Weixin is not configured.',
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
  channels?: ChannelSetupState[];
}): SetupState {
  return {
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
  return [
    `OK       ${state.label} found at ${state.path || '(unknown path)'}${version}`,
  ];
}

export function hasReadyAgent(state: SetupState): boolean {
  return state.agents.some(agent => agent.installed);
}

export function hasInstalledAgent(state: SetupState): boolean {
  return state.agents.some(agent => agent.installed);
}

export function isSetupReady(state: SetupState): boolean {
  const readyChannel = state.channels?.some(channel => channel.ready) ?? state.tokenProvided;
  return readyChannel && hasReadyAgent(state);
}

export function buildSetupGuide(state: SetupState, version: string, options?: { doctor?: boolean }): string {
  const doctor = !!options?.doctor;
  const isTelegram = state.channel === 'telegram';
  const channelLabel = isTelegram
    ? 'Telegram'
    : state.channel === 'feishu'
      ? 'Feishu'
      : state.channel === 'weixin'
        ? 'Weixin'
        : state.channel === 'whatsapp'
          ? 'WhatsApp'
          : 'your chat app';
  const lines: string[] = [
    `pikiclaw v${version}`,
    '',
    doctor ? 'Setup check' : 'First-time setup',
    '',
    `pikiclaw connects ${channelLabel} to a local coding agent running on your machine.`,
    'Before the bot can start, make sure these basics are ready:',
    '1. Claude Code, Codex, or Gemini CLI installed locally',
    isTelegram
      ? '2. A Telegram bot token from @BotFather'
      : '2. A supported channel token',
    '',
    'Step 1/2  Check your local coding agent',
  ];

  for (const agent of state.agents) lines.push(...agentSummary(agent));

  lines.push(
    '',
    isTelegram ? 'Step 2/2  Get a Telegram bot token' : 'Step 2/2  Check channel access',
  );

  if (isTelegram && state.tokenProvided) {
    lines.push('OK       A Telegram token was provided.');
  } else if (isTelegram) {
    lines.push(
      'MISSING  No Telegram token configured in ~/.pikiclaw/setting.json',
      '         Run `pikiclaw` to open the dashboard and configure, or:',
      '         1. Open Telegram and search for @BotFather',
      '         2. Send /newbot and copy the token',
      '         3. Add to ~/.pikiclaw/setting.json: { "telegramBotToken": "..." }',
    );
  } else if (state.channel === 'feishu' && state.tokenProvided) {
    lines.push('OK       Feishu credentials provided (FEISHU_APP_ID + FEISHU_APP_SECRET).');
  } else if (state.channel === 'feishu') {
    lines.push(
      'MISSING  No Feishu credentials configured in ~/.pikiclaw/setting.json',
      '         Run `pikiclaw` to open the dashboard and configure, or add feishuAppId/feishuAppSecret to setting.json.',
    );
  } else if (state.channel === 'weixin' && state.tokenProvided) {
    lines.push('OK       Weixin credentials provided (weixinBaseUrl + weixinBotToken + weixinAccountId).');
  } else if (state.channel === 'weixin') {
    lines.push(
      'MISSING  No Weixin credentials configured in ~/.pikiclaw/setting.json',
      '         Run `pikiclaw` to open the dashboard, scan the QR code, and validate the channel before enabling it.',
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
    lines.push('  npx pikiclaw@latest');
  } else if (!isTelegram) {
    lines.push('Start command:');
    lines.push('  npx pikiclaw@latest --channel telegram -t <YOUR_BOT_TOKEN>');
  } else {
    lines.push('Start command after you have the token:');
    lines.push('  npx pikiclaw@latest -t <YOUR_BOT_TOKEN>');
  }

  lines.push(
    '',
    'Tips:',
    '  - Run `npx pikiclaw@latest --doctor` any time to re-check your setup.',
    '  - Run `npx pikiclaw@latest --help` for the full CLI reference.',
  );

  if (!doctor && !hasInstalledAgent(state)) {
    lines.push('', 'You only need one local coding agent. Install Claude Code or Codex, then come back.');
  }

  return `${lines.join('\n')}\n`;
}
