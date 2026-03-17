#!/usr/bin/env node
/**
 * cli.ts — CLI entry point for pikiclaw.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { startAgentAutoUpdate } from './agent-auto-update.js';
import { envBool, DEFAULT_RUN_TIMEOUT_S } from './bot.js';
import { TelegramBot } from './bot-telegram.js';
import { hasConfiguredChannelToken, resolveConfiguredChannels } from './cli-channels.js';
import { listAgents } from './code-agent.js';
import { startDashboard, type DashboardServer } from './dashboard.js';
import { buildSetupGuide, collectSetupState, hasReadyAgent, isSetupReady } from './onboarding.js';
import {
  buildRestartCommand,
  clearRestartStateFile,
  consumeRestartStateFile,
  createRestartStateFilePath,
  PROCESS_RESTART_EXIT_CODE,
  requestProcessRestart,
} from './process-control.js';
import { runSetupWizard } from './setup-wizard.js';
import {
  applyUserConfig,
  loadUserConfig,
  startUserConfigSync,
  updateUserConfig,
  type ChannelName,
  type UserConfig,
} from './user-config.js';
import { VERSION } from './version.js';

/* ── Daemon (watchdog) mode ─────────────────────────────────────────── */

const DAEMON_RESTART_DELAY_MS = 3_000;
const DAEMON_MAX_RESTART_DELAY_MS = 60_000;
const DAEMON_RAPID_CRASH_WINDOW_MS = 10_000;

function daemonLog(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[daemon ${ts}] ${msg}\n`);
}

/** Args that are daemon-specific and should not be forwarded to the child. */
const DAEMON_STRIP_ARGS = new Set(['--daemon', '--no-daemon']);

/**
 * Runs the bot as a supervised child process. On non-zero exit the child is
 * restarted with exponential back-off. A clean exit (code 0) stops the daemon.
 * Restart requests use a dedicated exit code and are respawned immediately.
 */
async function runDaemon(userArgs: string[]): Promise<never> {
  // Forward user's CLI args (strip daemon-related flags).
  const forwardedArgs = userArgs.filter(a => !DAEMON_STRIP_ARGS.has(a));
  const restartCmd = process.env.PIKICLAW_RESTART_CMD;
  const restartStateFile = createRestartStateFilePath(process.pid);

  let restartDelay = DAEMON_RESTART_DELAY_MS;
  let attempt = 0;
  let nextRestartEnv: Record<string, string> = {};

  const spawnChild = (extraEnv: Record<string, string> = {}) => {
    clearRestartStateFile(restartStateFile);
    const { bin, args } = buildRestartCommand(forwardedArgs, restartCmd);
    daemonLog(`exec: ${bin} ${args.join(' ')}`);
    return spawn(bin, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...extraEnv,
        PIKICLAW_DAEMON_CHILD: '1',
        PIKICLAW_RESTART_STATE_FILE: restartStateFile,
        npm_config_yes: 'true',
      },
    });
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    daemonLog(`starting child process (attempt #${attempt})`);
    const child = spawnChild(nextRestartEnv);
    nextRestartEnv = {};
    daemonLog(`child running (pid=${child.pid})`);
    const startedAt = Date.now();

    let shutdownSignal: 'SIGINT' | 'SIGTERM' | null = null;

    // Forward termination and restart signals to the active child.
    const forwardShutdownSignal = (sig: 'SIGINT' | 'SIGTERM') => {
      shutdownSignal = sig;
      child.kill(sig);
    };
    const forwardRestartSignal = () => {
      child.kill('SIGUSR2');
    };
    process.on('SIGINT', forwardShutdownSignal);
    process.on('SIGTERM', forwardShutdownSignal);
    process.on('SIGUSR2', forwardRestartSignal);

    const code = await new Promise<number | null>(resolve => {
      child.on('exit', (c) => resolve(c));
    });

    process.removeListener('SIGINT', forwardShutdownSignal);
    process.removeListener('SIGTERM', forwardShutdownSignal);
    process.removeListener('SIGUSR2', forwardRestartSignal);

    if (shutdownSignal) {
      const exitCode = shutdownSignal === 'SIGINT' ? 130 : 143;
      daemonLog(`received ${shutdownSignal}, daemon stopping`);
      process.exit(exitCode);
    }

    if (code === PROCESS_RESTART_EXIT_CODE) {
      nextRestartEnv = consumeRestartStateFile(restartStateFile);
      restartDelay = DAEMON_RESTART_DELAY_MS;
      daemonLog('child requested restart, respawning immediately');
      continue;
    }

    // Clean exit → stop daemon.
    if (code === 0 || code === null) {
      daemonLog(`child exited cleanly (code=${code}), daemon stopping`);
      process.exit(0);
    }

    // Exponential back-off for rapid crashes.
    const uptime = Date.now() - startedAt;
    if (uptime > DAEMON_RAPID_CRASH_WINDOW_MS) {
      restartDelay = DAEMON_RESTART_DELAY_MS; // reset if it ran for a while
    } else {
      restartDelay = Math.min(restartDelay * 2, DAEMON_MAX_RESTART_DELAY_MS);
    }

    daemonLog(`child crashed (code=${code}, uptime=${Math.round(uptime / 1000)}s), restarting in ${Math.round(restartDelay / 1000)}s...`);
    await new Promise(resolve => setTimeout(resolve, restartDelay));
  }
}

function parseArgs(argv: string[]) {
  const args: Record<string, any> = {
    token: null, agent: null, model: null, workdir: null,
    fullAccess: null, safeMode: false, allowedIds: null,
    timeout: null, version: false, help: false, doctor: false, setup: false,
    noDashboard: false, dashboardPort: null, daemon: true,
  };
  const it = argv[Symbol.iterator]();
  for (const arg of it) {
    switch (arg) {
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
      case '--daemon': args.daemon = true; break;
      case '--no-daemon': args.daemon = false; break;
      case '-v': case '--version': args.version = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (arg.startsWith('-')) { process.stderr.write(`Unknown option: ${arg}\n`); process.exit(1); }
    }
  }
  return args;
}

export async function main() {
  // ── MCP server mode: launched by agent CLI via --mcp-config ──
  if (process.argv.includes('--mcp-serve')) {
    await import('./mcp-session-server.js');
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  let userConfig = loadUserConfig();

  if (args.version) { process.stdout.write(`pikiclaw ${VERSION}\n`); process.exit(0); }

  // Fresh CLI launch (not a daemon-managed child): persist the current working
  // directory (or explicit -w) into setting.json so the bot session — and any
  // subsequent daemon-managed restarts — starts in the right place.
  if (!process.env.PIKICLAW_DAEMON_CHILD) {
    const cliWorkdir = path.resolve(args.workdir || '.');
    if (userConfig.workdir !== cliWorkdir) {
      updateUserConfig({ workdir: cliWorkdir });
      userConfig = loadUserConfig();
    }
  }

  // Daemon mode (default): become a watchdog that supervises the real bot process.
  // The child is spawned via `npx pikiclaw@latest` so restarts always pull latest code.
  // Use --no-daemon to disable.
  if (args.daemon && !process.env.PIKICLAW_DAEMON_CHILD) {
    await runDaemon(process.argv.slice(2));
  }

  const processLog = (message: string) => {
    const ts = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`[pikiclaw ${ts}] ${message}\n`);
  };
  const onSigusr2 = () => {
    processLog('SIGUSR2 received, restarting...');
    void requestProcessRestart({ log: processLog });
  };
  process.on('SIGUSR2', onSigusr2);
  process.once('exit', () => {
    process.off('SIGUSR2', onSigusr2);
  });

  const configOverrides: Partial<UserConfig> = {};
  if (args.agent) configOverrides.defaultAgent = args.agent;
  // Apply config early so managed env vars are populated from setting.json.
  applyUserConfig({ ...userConfig, ...configOverrides }, undefined, { overwrite: true, clearMissing: true });

  const effectiveConfig = () => ({ ...userConfig, ...configOverrides });

  // Resolve channels from config / auto-detect from tokens
  let channels = resolveConfiguredChannels({
    config: effectiveConfig(),
    tokenOverride: args.token,
  });
  // Primary channel used for setup wizard / doctor checks (feishu preferred)
  let channel: ChannelName = channels[0] || 'feishu';
  const tokenProvided = channels.length > 0 && hasConfiguredChannelToken(effectiveConfig(), channel, args.token);
  if (args.help) {
    process.stdout.write(
`pikiclaw v${VERSION} — Run local coding agents through IM.

Run a bot that forwards IM messages to a local AI coding agent
(Claude Code or Codex CLI), streams responses in real-time, and manages
sessions, models, and workdirs.

Channels are auto-detected from configured tokens. If both Feishu and
Telegram tokens are present, both channels launch simultaneously.

Usage:
  npx pikiclaw                              # auto-detect from config/env
  npx pikiclaw -w ~/project                 # set working directory

Options:
  -t, --token <token>       Channel auth token (env: PIKICLAW_TOKEN)
  -a, --agent <agent>       AI agent: claude | codex  [default: codex]
  -m, --model <model>       Default model, switchable in chat via /models
  -w, --workdir <dir>       Working directory for the agent  [default: current process cwd]
  --full-access             Codex full-access + Claude bypassPermissions + Gemini yolo/no-sandbox  [default]
  --safe-mode               Use safer agent permission modes
  --allowed-ids <id,id>     Comma-separated chat/user ID whitelist
  --timeout <seconds>       Max seconds per agent request  [default: ${DEFAULT_RUN_TIMEOUT_S}]
  --doctor                  Run setup checks and exit
  --setup                   Run the interactive setup wizard
  --no-daemon               Disable watchdog (auto-restart on crash is ON by default)
  --no-dashboard            Skip the web dashboard
  --dashboard-port <port>   Dashboard port  [default: 3939]
  -v, --version             Print version
  -h, --help                Print this help

Environment variables (general):
  PIKICLAW_TOKEN             Channel auth token (same as -t, channel-agnostic)
  DEFAULT_AGENT              Default agent (same as -a)
  PIKICLAW_WORKDIR           Working directory (same as -w)
  PIKICLAW_TIMEOUT           Timeout in seconds (same as --timeout)
  PIKICLAW_ALLOWED_IDS       Comma-separated chat/user ID whitelist
  PIKICLAW_FULL_ACCESS       Default full-access behavior (true/false)

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
  GEMINI_MODEL               Gemini model name
  GEMINI_APPROVAL_MODE       Approval mode (default: yolo)
  GEMINI_SANDBOX             Sandbox mode (default: false)
  GEMINI_EXTRA_ARGS          Extra CLI args for gemini

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
  FEISHU_ALLOWED_CHAT_IDS    Comma-separated allowed Feishu chat IDs

Notes:
  - whatsapp is planned but not implemented yet.
  - --safe-mode delegates to the agent's own permission model; it does not add
    a pikiclaw-specific approval workflow.

Prerequisites: Node.js >= 18, and at least one agent CLI installed (claude or codex).
Docs: https://github.com/xiaotonng/pikiclaw
`);
    process.exit(0);
  }

  const listStartupAgents = () => listAgents().agents;
  const listVerboseAgents = () => listAgents({ includeVersion: true }).agents;
  const setupState = collectSetupState({
    agents: args.doctor ? listVerboseAgents() : listStartupAgents(),
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

  const noChannelsDetected = channels.length === 0;
  const needsSetup = noChannelsDetected || !tokenProvided || !hasReadyAgent(setupState);

  if (useDashboard) {
    // Start dashboard — always. If config is incomplete, it serves as the setup UI.
    dashboard = await startDashboard({
      port: args.dashboardPort || 3939,
      open: true,
    });

    if (needsSetup) {
      // Dashboard is showing the config page. Wait until configuration becomes ready,
      // then continue startup without requiring a manual restart.
      const ts = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`[pikiclaw ${ts}] waiting for configuration via dashboard...\n`);
      process.stdout.write(`[pikiclaw ${ts}] configure at ${dashboard.url}; startup will continue automatically once ready.\n`);

      while (true) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        userConfig = loadUserConfig();
        channels = resolveConfiguredChannels({
          config: { ...userConfig, ...configOverrides },
          tokenOverride: args.token,
        });
        channel = channels[0] || 'feishu';

        const nextSetupState = collectSetupState({
          agents: listStartupAgents(),
          channel,
          tokenProvided: channels.length > 0 && hasConfiguredChannelToken({ ...userConfig, ...configOverrides }, channel, args.token),
        });
        const nextNeedsSetup = channels.length === 0
          || !hasReadyAgent(nextSetupState);
        if (!nextNeedsSetup) break;
      }

      const resumeTs = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`[pikiclaw ${resumeTs}] configuration detected, starting bot channels...\n`);
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
      listAgents: listVerboseAgents,
    });
    if (!wizard.completed) process.exit(1);
    userConfig = loadUserConfig();
  } else if (needsSetup) {
    // --no-dashboard and needs setup: show guide and exit
    process.stdout.write(buildSetupGuide(setupState, VERSION));
    process.exit(0);
  }

  // Re-resolve channels after wizard/dashboard may have changed configuration.
  channels = resolveConfiguredChannels({
    config: effectiveConfig(),
    tokenOverride: args.token,
  });
  channel = channels[0] || 'feishu';
  const refreshedTokenProvided = channels.length > 0;
  if (!refreshedTokenProvided) {
    const refreshedSetupState = collectSetupState({
      agents: listStartupAgents(),
      channel,
      tokenProvided: false,
    });
    process.stdout.write(buildSetupGuide(refreshedSetupState, VERSION));
    process.exit(0);
  }

  const refreshedSetupState = collectSetupState({
    agents: listStartupAgents(),
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
  startAgentAutoUpdate({
    config: runtimeConfig,
    agents: listAgents({ includeVersion: true, refresh: true }).agents,
    log: processLog,
  });
  if (args.model) {
    const ag = args.agent || runtimeConfig.defaultAgent || 'codex';
    if (ag === 'codex') process.env.CODEX_MODEL = args.model;
    else if (ag === 'gemini') process.env.GEMINI_MODEL = args.model;
    else process.env.CLAUDE_MODEL = args.model;
  }
  if (args.timeout != null) process.env.PIKICLAW_TIMEOUT = String(args.timeout);
  if (args.safeMode) {
    process.env.CODEX_FULL_ACCESS = 'false';
    process.env.CLAUDE_PERMISSION_MODE = 'default';
    process.env.GEMINI_APPROVAL_MODE = 'default';
    process.env.GEMINI_SANDBOX = 'true';
  } else if (args.fullAccess || envBool('PIKICLAW_FULL_ACCESS', true)) {
    process.env.CODEX_FULL_ACCESS = 'true';
    process.env.CLAUDE_PERMISSION_MODE = 'bypassPermissions';
    process.env.GEMINI_APPROVAL_MODE = 'yolo';
    process.env.GEMINI_SANDBOX = 'false';
  }
  const stopUserConfigSync = startUserConfigSync({
    overrides: runtimeConfig,
    log: message => {
      const ts = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`[pikiclaw ${ts}] ${message}\n`);
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
    process.stdout.write(`[pikiclaw ${ts}] launching channels: ${channels.join(', ')}\n`);
    await Promise.all(channels.map(ch => launchChannel(ch)));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
