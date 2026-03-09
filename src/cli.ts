#!/usr/bin/env node
/**
 * cli.ts — CLI entry point for codeclaw.
 */

import { VERSION, envBool } from './bot.js';
import { TelegramBot } from './bot-telegram.js';

type Channel = 'telegram' | 'feishu' | 'whatsapp';
const VALID_CHANNELS = new Set<Channel>(['telegram', 'feishu', 'whatsapp']);

function parseArgs(argv: string[]) {
  const args: Record<string, any> = {
    channel: null, token: null, agent: null, model: null, workdir: null,
    fullAccess: null, safeMode: false, allowedIds: null,
    timeout: null, version: false, help: false,
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

  if (args.version) { process.stdout.write(`codeclaw ${VERSION}\n`); process.exit(0); }

  const noToken = !args.token && !process.env.CODECLAW_TOKEN
    && !process.env.TELEGRAM_BOT_TOKEN
    && !process.env.FEISHU_APP_ID
    && !process.env.WHATSAPP_TOKEN;
  if (args.help || noToken) {
    process.stdout.write(
`codeclaw v${VERSION} — Bridge AI coding agents to your IM.

Run a bot that forwards messages to a local AI coding agent (Claude, Codex,
Gemini), streams responses in real-time, and manages sessions and workdirs.

Usage:
  npx codeclaw -c telegram -t <BOT_TOKEN>
  npx codeclaw -c telegram -t <BOT_TOKEN> -a codex
  npx codeclaw -c telegram -t <BOT_TOKEN> -w ~/project
  npx codeclaw -c feishu   -t <APP_ID>:<APP_SECRET>
  npx codeclaw -c whatsapp -t <TOKEN>
  CODECLAW_TOKEN=<TOKEN> npx codeclaw

Options:
  -c, --channel <channel>   IM channel: telegram | feishu | whatsapp  [default: telegram]
  -t, --token <token>       Channel auth token (env: CODECLAW_TOKEN)
  -a, --agent <agent>       AI agent: claude | codex | gemini  [default: claude]
  -m, --model <model>       Default model, switchable in chat via /agents
  -w, --workdir <dir>       Working directory for the agent  [default: cwd]
  --full-access             Skip confirmation prompts  [default]
  --safe-mode               Require confirmation before destructive actions
  --allowed-ids <id,id>     Comma-separated chat/user ID whitelist
  --timeout <seconds>       Max seconds per agent request  [default: 900]
  -v, --version             Print version
  -h, --help                Print this help

Environment variables (general):
  CODECLAW_TOKEN             Channel auth token (same as -t, channel-agnostic)
  DEFAULT_AGENT              Default agent (same as -a)
  CODECLAW_WORKDIR           Working directory (same as -w)
  CODECLAW_TIMEOUT           Timeout in seconds (same as --timeout)

Environment variables (per channel):
  TELEGRAM_BOT_TOKEN         Telegram bot token (from @BotFather)
  TELEGRAM_ALLOWED_CHAT_IDS  Comma-separated allowed Telegram chat IDs
  FEISHU_APP_ID              Feishu/Lark app ID
  FEISHU_APP_SECRET          Feishu/Lark app secret
  WHATSAPP_TOKEN             WhatsApp Business API token
  WHATSAPP_PHONE_ID          WhatsApp phone number ID

Environment variables (per agent):
  CLAUDE_MODEL               Claude model name
  CLAUDE_PERMISSION_MODE     Permission mode (default: bypassPermissions)
  CLAUDE_EXTRA_ARGS          Extra CLI args for claude
  CODEX_MODEL                Codex model name
  CODEX_REASONING_EFFORT     Reasoning effort (default: xhigh)
  CODEX_FULL_ACCESS          Full-access mode (default: true)
  CODEX_EXTRA_ARGS           Extra CLI args for codex
  GEMINI_MODEL               Gemini model name
  GEMINI_EXTRA_ARGS          Extra CLI args for gemini

Bot commands (available once running):
  /sessions   List or switch coding sessions
  /agents     List or switch AI agents
  /status     Bot status, uptime, and token usage
  /host       Host machine info (CPU, memory, disk)
  /switch     Browse and change working directory
  /restart    Restart with latest version

Prerequisites: Node.js >= 18, and at least one agent CLI installed (claude, codex, or gemini).
Docs: https://github.com/xiaotonng/codeclaw
`);
    process.exit(0);
  }

  // resolve channel
  const channel = (args.channel || process.env.CODECLAW_CHANNEL || 'telegram').trim().toLowerCase() as Channel;
  if (!VALID_CHANNELS.has(channel)) {
    process.stderr.write(`Unknown channel: ${channel}. Available: ${[...VALID_CHANNELS].join(', ')}\n`);
    process.exit(1);
  }

  // map CLI flags to env (channel-agnostic → channel-specific)
  if (args.token) {
    if (channel === 'telegram') process.env.TELEGRAM_BOT_TOKEN = args.token;
    else if (channel === 'feishu') {
      const [appId, ...rest] = args.token.split(':');
      process.env.FEISHU_APP_ID = appId;
      if (rest.length) process.env.FEISHU_APP_SECRET = rest.join(':');
    }
    else if (channel === 'whatsapp') process.env.WHATSAPP_TOKEN = args.token;
  }
  // fallback: CODECLAW_TOKEN → channel-specific env
  if (!args.token && process.env.CODECLAW_TOKEN) {
    if (channel === 'telegram' && !process.env.TELEGRAM_BOT_TOKEN) process.env.TELEGRAM_BOT_TOKEN = process.env.CODECLAW_TOKEN;
    else if (channel === 'whatsapp' && !process.env.WHATSAPP_TOKEN) process.env.WHATSAPP_TOKEN = process.env.CODECLAW_TOKEN;
  }

  if (args.agent) process.env.DEFAULT_AGENT = args.agent;
  if (args.workdir) process.env.CODECLAW_WORKDIR = args.workdir;
  if (args.model) {
    const ag = args.agent || process.env.DEFAULT_AGENT || 'claude';
    if (ag === 'codex') process.env.CODEX_MODEL = args.model;
    else if (ag === 'gemini') process.env.GEMINI_MODEL = args.model;
    else process.env.CLAUDE_MODEL = args.model;
  }
  if (args.allowedIds) {
    if (channel === 'telegram') process.env.TELEGRAM_ALLOWED_CHAT_IDS = args.allowedIds;
  }
  if (args.timeout != null) process.env.CODECLAW_TIMEOUT = String(args.timeout);
  if (args.safeMode) {
    process.env.CODEX_FULL_ACCESS = 'false';
    process.env.CLAUDE_PERMISSION_MODE = 'default';
  } else if (args.fullAccess || envBool('CODECLAW_FULL_ACCESS', true)) {
    process.env.CODEX_FULL_ACCESS = 'true';
    process.env.CLAUDE_PERMISSION_MODE = 'bypassPermissions';
  }

  // dispatch to channel-specific bot
  switch (channel) {
    case 'telegram':
      await new TelegramBot().run();
      break;
    case 'feishu':
      process.stderr.write('Feishu channel is not yet implemented. Coming soon.\n');
      process.exit(1);
      break;
    case 'whatsapp':
      process.stderr.write('WhatsApp channel is not yet implemented. Coming soon.\n');
      process.exit(1);
      break;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
