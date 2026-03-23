#!/usr/bin/env node
/**
 * cli.ts — CLI entry point for pikiclaw.
 */

// Mark this process as a Claude Code context so nested claude launches are blocked.
// The spawn framework in code-agent.ts strips this before launching agent subprocesses.
process.env.CLAUDECODE = '1';

import { spawn } from 'node:child_process';
import path from 'node:path';
import { startAgentAutoUpdate } from './agent-auto-update.js';
import { envBool, DEFAULT_RUN_TIMEOUT_S } from './bot.js';
import { DAEMON_TIMEOUTS } from './constants.js';
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

const DAEMON_RESTART_DELAY_MS = DAEMON_TIMEOUTS.restartDelay;
const DAEMON_MAX_RESTART_DELAY_MS = DAEMON_TIMEOUTS.maxRestartDelay;
const DAEMON_RAPID_CRASH_WINDOW_MS = DAEMON_TIMEOUTS.rapidCrashWindow;

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

/* ── Shared helpers ────────────────────────────────────────────────── */

function processLog(message: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[pikiclaw ${ts}] ${message}\n`);
}

const listStartupAgents = () => listAgents().agents;
const listVerboseAgents = () => listAgents({ includeVersion: true }).agents;

/* ── Phase: early exits (MCP serve, --version, --help) ────────────── */

/** If launched as an MCP stdio server, run that and exit. */
async function handleMcpServeMode(): Promise<boolean> {
  if (process.argv.includes('--mcp-serve')) {
    await import('./mcp-session-server.js');
    return true;
  }
  if (process.argv.includes('--playwright-mcp-proxy')) {
    await import('./mcp-playwright-proxy.js');
    return true;
  }
  return false;
}

/** Print help text and exit. */
function printHelp(): never {
  process.stdout.write(
`pikiclaw v${VERSION} — Run local coding agents through IM.

Run a bot that forwards IM messages to a local AI coding agent
(Claude Code or Codex CLI), streams responses in real-time, and manages
sessions, models, and workdirs.

Channels are auto-detected from configured credentials. If multiple
validated channels are enabled, they launch simultaneously.

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

Environment variables (Weixin):
  WEIXIN_BASE_URL            Weixin API base URL (default: https://ilinkai.weixin.qq.com)
  WEIXIN_BOT_TOKEN           Weixin bot token (normally configured from dashboard QR login)
  WEIXIN_ACCOUNT_ID          Weixin bot account ID

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
  - weixin setup is QR-based in the dashboard and currently supports text-only replies.
  - whatsapp is planned but not implemented yet.
  - --safe-mode delegates to the agent's own permission model; it does not add
    a pikiclaw-specific approval workflow.

Prerequisites: Node.js >= 18, and at least one agent CLI installed (claude or codex).
Docs: https://github.com/xiaotonng/pikiclaw
`);
  process.exit(0);
}

/* ── Phase: workdir persistence & daemon handoff ──────────────────── */

/**
 * For a fresh CLI launch (not a daemon-managed child), persist the working
 * directory into setting.json so restarts start in the right place.
 */
function persistWorkdir(args: Record<string, any>, userConfig: Partial<UserConfig>): Partial<UserConfig> {
  if (!process.env.PIKICLAW_DAEMON_CHILD) {
    // Only overwrite persisted workdir when the user explicitly passed -w.
    // Falling back to cwd when no flag is given can clobber a valid saved
    // workdir with a temp directory (e.g. after a non-daemon restart).
    if (args.workdir) {
      const cliWorkdir = path.resolve(args.workdir);
      if (userConfig.workdir !== cliWorkdir) {
        updateUserConfig({ workdir: cliWorkdir });
        return loadUserConfig();
      }
    }
  }
  return userConfig;
}

/**
 * If daemon mode is active and we are the top-level process, become the
 * watchdog. This function never returns in daemon mode.
 */
async function enterDaemonIfNeeded(args: Record<string, any>): Promise<void> {
  if (args.daemon && !process.env.PIKICLAW_DAEMON_CHILD) {
    await runDaemon(process.argv.slice(2));
  }
}

/** Install SIGUSR2 restart handler and clean it up on exit. */
function installRestartSignalHandler(): void {
  const onSigusr2 = () => {
    processLog('SIGUSR2 received, restarting...');
    void requestProcessRestart({ log: processLog });
  };
  process.on('SIGUSR2', onSigusr2);
  process.once('exit', () => {
    process.off('SIGUSR2', onSigusr2);
  });
}

/* ── Phase: doctor check ──────────────────────────────────────────── */

/** Run setup diagnostics and exit (--doctor). */
function runDoctorCheck(channel: ChannelName, tokenProvided: boolean): never {
  const setupState = collectSetupState({
    agents: listVerboseAgents(),
    channel,
    tokenProvided,
  });
  const guide = buildSetupGuide(setupState, VERSION, { doctor: true });
  const ready = isSetupReady(setupState);
  if (ready) process.stdout.write(`${guide}\nSetup looks ready.\n`);
  else process.stderr.write(guide);
  process.exit(ready ? 0 : 1);
}

/* ── Phase: setup (dashboard / wizard / guide) ────────────────────── */

/**
 * Poll the dashboard until the user completes configuration.
 * Mutates `ctx` in place with freshly resolved channels.
 */
async function awaitDashboardConfig(
  dashboard: DashboardServer,
  ctx: { userConfig: Partial<UserConfig>; configOverrides: Partial<UserConfig>; args: Record<string, any> },
): Promise<{ channels: ChannelName[]; channel: ChannelName }> {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[pikiclaw ${ts}] waiting for configuration via dashboard...\n`);
  process.stdout.write(`[pikiclaw ${ts}] configure at ${dashboard.url}; startup will continue automatically once ready.\n`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise(resolve => setTimeout(resolve, DAEMON_TIMEOUTS.configPollInterval));
    ctx.userConfig = loadUserConfig();
    const channels = resolveConfiguredChannels({
      config: { ...ctx.userConfig, ...ctx.configOverrides },
      tokenOverride: ctx.args.token,
    });
    const channel: ChannelName = channels[0] || 'feishu';

    const nextSetupState = collectSetupState({
      agents: listStartupAgents(),
      channel,
      tokenProvided: channels.length > 0 && hasConfiguredChannelToken({ ...ctx.userConfig, ...ctx.configOverrides }, channel, ctx.args.token),
    });
    const nextNeedsSetup = channels.length === 0
      || !hasReadyAgent(nextSetupState);
    if (!nextNeedsSetup) {
      const resumeTs = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`[pikiclaw ${resumeTs}] configuration detected, starting bot channels...\n`);
      return { channels, channel };
    }
  }
}

/**
 * Run the setup phase: dashboard wait-loop, terminal wizard, or guide printout.
 * Returns the dashboard instance (if started) and possibly-updated userConfig.
 */
async function runSetupPhase(
  args: Record<string, any>,
  userConfig: Partial<UserConfig>,
  configOverrides: Partial<UserConfig>,
  channels: ChannelName[],
  channel: ChannelName,
  tokenProvided: boolean,
): Promise<{
  dashboard: DashboardServer | null;
  userConfig: Partial<UserConfig>;
  channels: ChannelName[];
  channel: ChannelName;
}> {
  const setupState = collectSetupState({
    agents: listStartupAgents(),
    channel,
    tokenProvided,
  });

  const useDashboard = !args.noDashboard && !args.setup;
  let dashboard: DashboardServer | null = null;
  const needsSetup = channels.length === 0 || !tokenProvided || !hasReadyAgent(setupState);

  if (useDashboard) {
    dashboard = await startDashboard({
      port: args.dashboardPort || 3939,
      open: true,
    });

    if (needsSetup) {
      const ctx = { userConfig, configOverrides, args };
      const resolved = await awaitDashboardConfig(dashboard, ctx);
      userConfig = ctx.userConfig;
      channels = resolved.channels;
      channel = resolved.channel;
    }
  } else if (args.setup) {
    const canPromptInteractively = !!(process.stdin.isTTY && process.stdout.isTTY);
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
    process.stdout.write(buildSetupGuide(setupState, VERSION));
    process.exit(0);
  }

  return { dashboard, userConfig, channels, channel };
}

/* ── Phase: post-setup validation ─────────────────────────────────── */

/**
 * Re-resolve channels after setup phase and validate that we have at least
 * one working channel with a ready agent. Exits on failure.
 */
function validatePostSetupChannels(
  configOverrides: Partial<UserConfig>,
  userConfig: Partial<UserConfig>,
  args: Record<string, any>,
): { channels: ChannelName[]; channel: ChannelName } {
  const effectiveConfig = { ...userConfig, ...configOverrides };
  const channels = resolveConfiguredChannels({
    config: effectiveConfig,
    tokenOverride: args.token,
  });
  const channel: ChannelName = channels[0] || 'feishu';
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

  return { channels, channel };
}

/* ── Phase: runtime config & env setup ────────────────────────────── */

/**
 * Build the final runtime config, apply token/model/permission overrides to
 * the environment, start config file sync, and kick off agent auto-update.
 */
function applyRuntimeConfig(
  args: Record<string, any>,
  userConfig: Partial<UserConfig>,
  configOverrides: Partial<UserConfig>,
  channel: ChannelName,
): Partial<UserConfig> {
  const runtimeConfig: Partial<UserConfig> = { ...userConfig, ...configOverrides };

  // Inject CLI token into channel-specific config fields.
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

  // Model override: route to the correct agent env var.
  if (args.model) {
    const ag = args.agent || runtimeConfig.defaultAgent || 'codex';
    if (ag === 'codex') process.env.CODEX_MODEL = args.model;
    else if (ag === 'gemini') process.env.GEMINI_MODEL = args.model;
    else process.env.CLAUDE_MODEL = args.model;
  }
  if (args.timeout != null) process.env.PIKICLAW_TIMEOUT = String(args.timeout);

  // Permission mode: safe vs full-access.
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

  // Live-reload config file sync.
  const stopUserConfigSync = startUserConfigSync({
    overrides: runtimeConfig,
    log: message => processLog(message),
  });
  process.once('exit', stopUserConfigSync);

  return runtimeConfig;
}

/* ── Phase: channel launch ────────────────────────────────────────── */

/** Start bot(s) for each configured channel, attaching to dashboard if present. */
async function launchChannels(
  channels: ChannelName[],
  dashboard: DashboardServer | null,
): Promise<void> {
  async function launchChannel(ch: ChannelName): Promise<void> {
    switch (ch) {
      case 'telegram': {
        const bot = new TelegramBot();
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
      case 'weixin': {
        const { WeixinBot } = await import('./bot-weixin.js');
        const bot = new WeixinBot();
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
    processLog(`launching channels: ${channels.join(', ')}`);
    await Promise.all(channels.map(ch => launchChannel(ch)));
  }
}

/* ── main() ───────────────────────────────────────────────────────── */

export async function main() {
  if (await handleMcpServeMode()) return;

  const args = parseArgs(process.argv.slice(2));
  let userConfig = loadUserConfig();

  if (args.version) { process.stdout.write(`pikiclaw ${VERSION}\n`); process.exit(0); }
  if (args.help) printHelp();

  // Persist workdir for fresh (non-daemon-child) launches.
  userConfig = persistWorkdir(args, userConfig);

  // Daemon mode: become watchdog (never returns in daemon mode).
  await enterDaemonIfNeeded(args);

  // Child / no-daemon process: install restart signal handler.
  installRestartSignalHandler();

  // Apply config overrides from CLI args.
  const configOverrides: Partial<UserConfig> = {};
  if (args.agent) configOverrides.defaultAgent = args.agent;
  applyUserConfig({ ...userConfig, ...configOverrides }, undefined, { overwrite: true, clearMissing: true });

  // Resolve initial channels.
  const effectiveConfig = () => ({ ...userConfig, ...configOverrides });
  let channels = resolveConfiguredChannels({ config: effectiveConfig(), tokenOverride: args.token });
  let channel: ChannelName = channels[0] || 'feishu';
  const tokenProvided = channels.length > 0 && hasConfiguredChannelToken(effectiveConfig(), channel, args.token);

  // Doctor mode: check and exit.
  if (args.doctor) runDoctorCheck(channel, tokenProvided);

  // Setup phase: dashboard, wizard, or guide.
  let dashboard: DashboardServer | null;
  ({ dashboard, userConfig, channels, channel } = await runSetupPhase(
    args, userConfig, configOverrides, channels, channel, tokenProvided,
  ));

  // Validate channels are ready after setup.
  ({ channels, channel } = validatePostSetupChannels(configOverrides, userConfig, args));

  // Apply runtime config, env overrides, and start config sync.
  applyRuntimeConfig(args, userConfig, configOverrides, channel);

  // Launch bot channel(s).
  await launchChannels(channels, dashboard);
}

main().catch(err => { console.error(err); process.exit(1); });
