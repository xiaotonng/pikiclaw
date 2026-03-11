#!/usr/bin/env node
/**
 * cli.ts — CLI entry point for codeclaw.
 */

import { VERSION, envBool } from './bot.js';
import { TelegramBot } from './bot-telegram.js';
import { listAgents } from './code-agent.js';
import { startDashboard, type DashboardServer } from './dashboard.js';
import { buildSetupGuide, collectSetupState, hasReadyAgent, isSetupReady } from './onboarding.js';
import { runSetupWizard } from './setup-wizard.js';
import { applyUserConfig, loadUserConfig, startUserConfigSync, type ChannelName, type UserConfig } from './user-config.js';

const VALID_CHANNELS = new Set<ChannelName>(['telegram', 'feishu', 'whatsapp']);

function parseArgs(argv: string[]) {
  const args: Record<string, any> = {
    channel: null, token: null, agent: null, model: null, workdir: null,
    fullAccess: null, safeMode: false, allowedIds: null,
    timeout: null, version: false, help: false, doctor: false, setup: false,
    noDashboard: false, dashboardPort: null,
  };
  const it = argv[Symbol.iterator]();
  for (const arg of it) {
    switch (arg) {
      case '-c': case '--channel': args.channel = it.next().value; break;
      case '-t': case '--token': args.token = it.next().value; break;
      case '-a': case '--agent': args.agent = it.next().value; break;
      case '-m': case '--model': args.model = it.next().value; break;
      case '-w': case '--workdir': args.workdir = it.next().value; break;
      case '--full-access': args.fullAccess = true; break;
      case '--safe-mode': args.safeMode = true; break;
      case '--allowed-ids': args.allowedIds = it.next().value; break;
      case '--timeout': args.timeout = parseInt(it.next().value ?? '', 10); break;
      case '--doctor': args.doctor = true; break;
      case '--setup': args.setup = true; break;
      case '--no-dashboard': args.noDashboard = true; break;
      case '--dashboard-port': args.dashboardPort = parseInt(it.next().value ?? '', 10); break;
      case '-v': case '--version': args.version = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (arg.startsWith('-')) { process.stderr.write(`Unknown option: ${arg}\n`); process.exit(1); }
    }
  }
  return args;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  let userConfig = loadUserConfig();

  if (args.version) { process.stdout.write(`codeclaw ${VERSION}\n`); process.exit(0); }

  const configOverrides: Partial<UserConfig> = {};
  if (args.agent) configOverrides.defaultAgent = args.agent;
  if (args.workdir) configOverrides.defaultWorkdir = args.workdir;

  // Apply config early so managed env vars are populated from setting.json.
  applyUserConfig({ ...userConfig, ...configOverrides }, undefined, { overwrite: true, clearMissing: true });

  // Detect which channels have credentials configured (config file is authoritative)
  function hasChannelToken(ch: ChannelName): boolean {
    const config = { ...userConfig, ...configOverrides };
    switch (ch) {
      case 'telegram': return !!(config.telegramBotToken || args.token);
      case 'feishu': return !!(config.feishuAppId || args.token);
      case 'whatsapp': return !!(args.token);
    }
  }

  // Resolve channels: explicit flag > config > auto-detect from tokens
  let channels: ChannelName[];
  const rawChannels = args.channel || '';
  if (rawChannels) {
    channels = rawChannels.split(',').map((c: string) => c.trim().toLowerCase()) as ChannelName[];
  } else if (userConfig.channels?.length) {
    channels = userConfig.channels;
  } else {
    // Auto-detect: launch all channels that have tokens configured
    const detected: ChannelName[] = [];
    // Feishu first (default priority)
    if (hasChannelToken('feishu')) detected.push('feishu');
    if (hasChannelToken('telegram')) detected.push('telegram');
    channels = detected.length ? detected : [];
  }
  for (const ch of channels) {
    if (!VALID_CHANNELS.has(ch)) {
      process.stderr.write(`Unknown channel: ${ch}. Available: ${[...VALID_CHANNELS].join(', ')}\n`);
      process.exit(1);
    }
  }
  // Primary channel used for setup wizard / doctor checks (feishu preferred)
  const channel: ChannelName = channels[0] || 'feishu';
  const tokenProvided = channels.length > 0 && hasChannelToken(channel);
  if (args.help) {
    process.stdout.write(
`codeclaw v${VERSION} — Run local coding agents through IM.

Run a bot that forwards IM messages to a local AI coding agent
(Claude Code or Codex CLI), streams responses in real-time, and manages
sessions, models, and workdirs.

Channels are auto-detected from configured tokens. If both Feishu and
Telegram tokens are present, both channels launch simultaneously.

Usage:
  npx codeclaw                              # auto-detect from config/env
  npx codeclaw -c feishu,telegram           # explicit multi-channel
  npx codeclaw -c telegram -t <BOT_TOKEN>   # single channel with token
  npx codeclaw -w ~/project                 # set working directory

Options:
  -c, --channel <channels>  IM channel(s), comma-separated  [default: auto-detect]
  -t, --token <token>       Channel auth token (env: CODECLAW_TOKEN)
  -a, --agent <agent>       AI agent: claude | codex  [default: codex]
  -m, --model <model>       Default model, switchable in chat via /models
  -w, --workdir <dir>       Working directory for the agent  [default: current process cwd]
  --full-access             Codex full-access + Claude bypassPermissions  [default]
  --safe-mode               Use safer agent permission modes
  --allowed-ids <id,id>     Comma-separated chat/user ID whitelist
  --timeout <seconds>       Max seconds per agent request  [default: 1800]
  --doctor                  Run setup checks and exit
  --setup                   Run the interactive setup wizard
  --no-dashboard            Skip the web dashboard
  --dashboard-port <port>   Dashboard port  [default: 3939]
  -v, --version             Print version
  -h, --help                Print this help

Environment variables (general):
  CODECLAW_TOKEN             Channel auth token (same as -t, channel-agnostic)
  DEFAULT_AGENT              Default agent (same as -a)
  CODECLAW_WORKDIR           Working directory (same as -w)
  CODECLAW_TIMEOUT           Timeout in seconds (same as --timeout)
  CODECLAW_ALLOWED_IDS       Comma-separated chat/user ID whitelist
  CODECLAW_FULL_ACCESS       Default full-access behavior (true/false)

Environment variables (Telegram):
  TELEGRAM_BOT_TOKEN         Telegram bot token (from @BotFather)
  TELEGRAM_ALLOWED_CHAT_IDS  Comma-separated allowed Telegram chat IDs

Environment variables (per agent):
  CLAUDE_MODEL               Claude model name
  CLAUDE_PERMISSION_MODE     Permission mode (default: bypassPermissions)
  CLAUDE_EXTRA_ARGS          Extra CLI args for claude
  CODEX_MODEL                Codex model name
  CODEX_REASONING_EFFORT     Reasoning effort (default: xhigh)
  CODEX_FULL_ACCESS          Full-access mode (default: true)
  CODEX_EXTRA_ARGS           Extra CLI args for codex

Bot commands (available once running):
  /sessions   List or switch coding sessions
  /agents     List or switch AI agents
  /models     List or switch models
  /status     Bot status, uptime, and token usage
  /host       Host machine info (CPU, memory, disk, battery)
  /switch     Browse and change working directory
  /restart    Restart with latest version

Environment variables (Feishu):
  FEISHU_APP_ID              Feishu app ID (from Feishu Open Platform)
  FEISHU_APP_SECRET          Feishu app secret
  FEISHU_DOMAIN              API domain (default: https://open.feishu.cn)
  FEISHU_USE_PROXY           Force Feishu APIs and WS to use process proxy settings
  FEISHU_ALLOWED_CHAT_IDS    Comma-separated allowed Feishu chat IDs

Notes:
  - whatsapp is planned but not implemented yet.
  - --safe-mode delegates to the agent's own permission model; it does not add
    a codeclaw-specific approval workflow.

Prerequisites: Node.js >= 18, and at least one agent CLI installed (claude or codex).
Docs: https://github.com/xiaotonng/codeclaw
`);
    process.exit(0);
  }

  const setupState = collectSetupState({
    agents: listAgents().agents,
    channel,
    tokenProvided,
  });
  const canPromptInteractively = !!(process.stdin.isTTY && process.stdout.isTTY);

  // ── Doctor mode: quick check and exit ──
  if (args.doctor) {
    const guide = buildSetupGuide(setupState, VERSION, { doctor: true });
    const ready = isSetupReady(setupState);
    if (ready) process.stdout.write(`${guide}\nSetup looks ready.\n`);
    else process.stderr.write(guide);
    process.exit(ready ? 0 : 1);
  }

  // ── Dashboard mode (default) ──
  // If config is incomplete or first-time: open dashboard for configuration.
  // If config is ready: open dashboard + start bot channels.
  const useDashboard = !args.noDashboard && !args.setup;
  let dashboard: DashboardServer | null = null;

  const needsAgentAttention = setupState.agents.filter(agent => agent.installed).every(agent => agent.authStatus !== 'ready');
  const noChannelsDetected = channels.length === 0;
  const needsSetup = noChannelsDetected || !tokenProvided || !hasReadyAgent(setupState) || needsAgentAttention;

  if (useDashboard) {
    // Start dashboard — always. If config is incomplete, it serves as the setup UI.
    dashboard = await startDashboard({
      port: args.dashboardPort || 3939,
      open: true,
    });

    if (needsSetup) {
      // Dashboard is showing the config page. Wait for user to configure and restart.
      const ts = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`[codeclaw ${ts}] waiting for configuration via dashboard...\n`);
      process.stdout.write(`[codeclaw ${ts}] configure at ${dashboard.url}, then restart codeclaw.\n`);
      // Keep process alive so dashboard remains accessible
      await new Promise<void>(() => {}); // block forever
    }
  } else if (args.setup) {
    // Explicit --setup: use the terminal-based wizard
    if (!canPromptInteractively) {
      process.stderr.write('--setup requires an interactive terminal.\n');
      process.exit(1);
    }
    const wizard = await runSetupWizard({
      version: VERSION,
      channel,
      argsAgent: args.agent || userConfig.defaultAgent || null,
      currentToken: args.token || userConfig.telegramBotToken || null,
      initialState: setupState,
      listAgents: () => listAgents().agents,
    });
    if (!wizard.completed) process.exit(1);
    userConfig = loadUserConfig();
  } else if (needsSetup) {
    // --no-dashboard and needs setup: show guide and exit
    process.stdout.write(buildSetupGuide(setupState, VERSION));
    process.exit(0);
  }

  // Re-detect channels after wizard/dashboard may have set tokens
  if (channels.length === 0) {
    const detected: ChannelName[] = [];
    if (hasChannelToken('feishu')) detected.push('feishu');
    if (hasChannelToken('telegram')) detected.push('telegram');
    channels = detected;
  }
  const refreshedTokenProvided = channels.length > 0;
  if (!refreshedTokenProvided) {
    const refreshedSetupState = collectSetupState({
      agents: listAgents().agents,
      channel,
      tokenProvided: false,
    });
    process.stdout.write(buildSetupGuide(refreshedSetupState, VERSION));
    process.exit(0);
  }

  const refreshedSetupState = collectSetupState({
    agents: listAgents().agents,
    channel,
    tokenProvided: refreshedTokenProvided,
  });
  if (!hasReadyAgent(refreshedSetupState)) {
    process.stderr.write(buildSetupGuide(refreshedSetupState, VERSION, { doctor: true }));
    process.exit(1);
  }

  const runtimeConfig: Partial<UserConfig> = { ...userConfig, ...configOverrides };
  if (args.token) {
    if (channel === 'telegram') runtimeConfig.telegramBotToken = args.token;
    else if (channel === 'feishu') {
      const [appId, ...rest] = args.token.split(':');
      runtimeConfig.feishuAppId = appId;
      runtimeConfig.feishuAppSecret = rest.join(':');
    }
  }
  if (args.allowedIds && channel === 'telegram') runtimeConfig.telegramAllowedChatIds = args.allowedIds;
  applyUserConfig(runtimeConfig, undefined, { overwrite: true, clearMissing: true });
  if (args.model) {
    const ag = args.agent || runtimeConfig.defaultAgent || 'codex';
    if (ag === 'codex') process.env.CODEX_MODEL = args.model;
    else if (ag === 'gemini') process.env.GEMINI_MODEL = args.model;
    else process.env.CLAUDE_MODEL = args.model;
  }
  if (args.timeout != null) process.env.CODECLAW_TIMEOUT = String(args.timeout);
  if (args.safeMode) {
    process.env.CODEX_FULL_ACCESS = 'false';
    process.env.CLAUDE_PERMISSION_MODE = 'default';
  } else if (args.fullAccess || envBool('CODECLAW_FULL_ACCESS', true)) {
    process.env.CODEX_FULL_ACCESS = 'true';
    process.env.CLAUDE_PERMISSION_MODE = 'bypassPermissions';
  }
  const stopUserConfigSync = startUserConfigSync({
    overrides: runtimeConfig,
    log: message => {
      const ts = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`[codeclaw ${ts}] ${message}\n`);
    },
  });
  process.once('exit', stopUserConfigSync);

  // dispatch to channel-specific bot(s) — launch all channels concurrently
  async function launchChannel(ch: ChannelName): Promise<void> {
    switch (ch) {
      case 'telegram': {
        const bot = new TelegramBot();
        // Attach bot to dashboard for runtime monitoring
        if (dashboard) dashboard.attachBot(bot);
        await bot.run();
        break;
      }
      case 'feishu': {
        const { FeishuBot } = await import('./bot-feishu.js');
        const bot = new FeishuBot();
        if (dashboard) dashboard.attachBot(bot);
        await bot.run();
        break;
      }
      case 'whatsapp':
        process.stderr.write('WhatsApp channel is not yet implemented. Coming soon.\n');
        break;
    }
  }

  if (channels.length === 1) {
    await launchChannel(channels[0]);
  } else {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`[codeclaw ${ts}] launching channels: ${channels.join(', ')}\n`);
    await Promise.all(channels.map(ch => launchChannel(ch)));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
