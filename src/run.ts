#!/usr/bin/env node
/**
 * run.ts — Standalone CLI commands for pikiclaw.
 *
 * Usage:
 *   npm run command -- status
 *   npm run command -- claude-models
 *   npm run command -- codex-models
 */

import { ensureGitignore, formatThinkingForDisplay, DEFAULT_RUN_TIMEOUT_S } from './bot.js';
import { initializeProjectSkills, listAgents, listModels, listSkills, getUsage, doStream, getSessions, getSessionTail } from './code-agent.js';
import type { Agent, StreamOpts } from './code-agent.js';
import { getDriver } from './agent-driver.js';
import { loadUserConfig, resolveUserWorkdir } from './user-config.js';
import { VERSION } from './version.js';

function parseArgs(argv: string[]) {
  const args: Record<string, any> = {
    command: null, model: null, workdir: null, prompt: null, timeout: DEFAULT_RUN_TIMEOUT_S, help: false,
    session: null, n: 4,
  };
  const positional: string[] = [];
  const it = argv[Symbol.iterator]();
  for (const arg of it) {
    switch (arg) {
      case '-m': case '--model': args.model = it.next().value; break;
      case '-w': case '--workdir': args.workdir = it.next().value; break;
      case '-p': case '--prompt': args.prompt = it.next().value; break;
      case '-s': case '--session': args.session = it.next().value; break;
      case '-n': args.n = parseInt(it.next().value ?? '', 10) || 4; break;
      case '--timeout': args.timeout = parseInt(it.next().value ?? '', 10) || DEFAULT_RUN_TIMEOUT_S; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (arg.startsWith('-')) { process.stderr.write(`Unknown option: ${arg}\n`); process.exit(1); }
        else positional.push(arg);
    }
  }
  args.command = positional[0] ?? null;
  // If no -p flag, treat remaining positional args as the prompt
  if (!args.prompt && positional.length > 1) args.prompt = positional.slice(1).join(' ');
  return args;
}

const HELP = `pikiclaw run — standalone commands

Usage:
  npm run command -- <command> [options]

Commands:
  skills          List project-defined custom skills (.pikiclaw/skills)
  claude-run      Run a single Claude prompt and print the result
  codex-run       Run a single Codex prompt and print the result
  claude-status   Show Claude agent info and API usage
  codex-status    Show Codex agent info and API usage
  gemini-status   Show Gemini agent info and API usage
  claude-models   List available Claude models
  codex-models    List available Codex models
  claude-sessions List recent Claude sessions for the workdir
  codex-sessions  List recent Codex sessions for the workdir
  gemini-sessions List recent Gemini sessions for the workdir
  claude-tail     Show last N messages of a Claude session
  codex-tail      Show last N messages of a Codex session
  gemini-tail     Show last N messages of a Gemini session

Options:
  -p, --prompt <text>   Prompt text (or pass after command as positional args)
  -m, --model <model>   Model to use / highlight
  -w, --workdir <dir>   Working directory  [default: current process cwd]
  -s, --session <id>    Session ID (for tail; omit to use latest session)
  -n <count>            Number of messages to show  [default: 4]
  --timeout <seconds>   Max seconds per request  [default: ${DEFAULT_RUN_TIMEOUT_S}]
  -h, --help            Print this help

Examples:
  npm run command -- claude-run -p "Hello world"
  npm run command -- codex-run -m o3 "Explain this repo"
  npm run command -- claude-run -m sonnet --timeout 60 -p "What is 1+1?"
  npm run command -- claude-tail
  npm run command -- claude-tail -n 10 -s <session-id>
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userConfig = loadUserConfig();
  const workdir = resolveUserWorkdir({ workdir: args.workdir, config: userConfig });
  ensureGitignore(workdir);
  initializeProjectSkills(workdir);

  if (args.help || !args.command) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  switch (args.command) {
    case 'skills': {
      const result = listSkills(workdir);
      if (!result.skills.length) {
        process.stdout.write(`No custom skills found in ${workdir} (.pikiclaw/skills)\n`);
        break;
      }
      process.stdout.write(`Project skills (${result.skills.length}):\n\n`);
      for (const sk of result.skills) {
        const desc = sk.description ? `  ${sk.description}` : '';
        process.stdout.write(`  ${sk.name}${desc}\n`);
      }
      break;
    }
    case 'claude-status': {
      const info = listAgents({ includeVersion: true }).agents.find(a => a.agent === 'claude')!;
      const mark = info.installed ? '\u2713' : '\u2717';
      process.stdout.write(`${mark} claude  ${info.version ?? 'not installed'}  ${info.path ?? ''}\n`);
      const usage = getUsage({ agent: 'claude' });
      if (usage.error) {
        process.stdout.write(`  ${usage.error}\n`);
      } else {
        for (const w of usage.windows) {
          process.stdout.write(`  [${w.label}] ${w.usedPercent ?? '?'}% used  status=${w.status ?? 'n/a'}\n`);
        }
      }
      break;
    }
    case 'codex-status': {
      const info = listAgents({ includeVersion: true }).agents.find(a => a.agent === 'codex')!;
      const mark = info.installed ? '\u2713' : '\u2717';
      process.stdout.write(`${mark} codex  ${info.version ?? 'not installed'}  ${info.path ?? ''}\n`);
      const usage = getUsage({ agent: 'codex' });
      if (usage.error) {
        process.stdout.write(`  ${usage.error}\n`);
      } else {
        for (const w of usage.windows) {
          process.stdout.write(`  [${w.label}] ${w.usedPercent ?? '?'}% used  status=${w.status ?? 'n/a'}\n`);
        }
      }
      break;
    }
    case 'gemini-status': {
      const info = listAgents({ includeVersion: true }).agents.find(a => a.agent === 'gemini')!;
      const mark = info.installed ? '\u2713' : '\u2717';
      process.stdout.write(`${mark} gemini  ${info.version ?? 'not installed'}  ${info.path ?? ''}\n`);
      const driver = getDriver('gemini');
      const usage = driver.getUsageLive
        ? await driver.getUsageLive({ agent: 'gemini', model: args.model })
        : getUsage({ agent: 'gemini', model: args.model });
      if (usage.error) {
        process.stdout.write(`  ${usage.error}\n`);
      } else {
        for (const w of usage.windows) {
          process.stdout.write(`  [${w.label}] ${w.usedPercent ?? '?'}% used  status=${w.status ?? 'n/a'}\n`);
        }
      }
      break;
    }
    case 'claude-models': {
      const result = await listModels('claude', { workdir, currentModel: args.model });
      process.stdout.write(`Claude models${result.note ? ` (${result.note})` : ''}:\n`);
      for (const m of result.models) {
        process.stdout.write(`  ${m.id}${m.alias ? ` (${m.alias})` : ''}\n`);
      }
      break;
    }
    case 'codex-models': {
      const result = await listModels('codex', { workdir, currentModel: args.model });
      process.stdout.write(`Codex models${result.note ? ` (${result.note})` : ''}:\n`);
      for (const m of result.models) {
        process.stdout.write(`  ${m.id}${m.alias ? ` (${m.alias})` : ''}\n`);
      }
      break;
    }
    case 'claude-sessions': case 'codex-sessions': case 'gemini-sessions': {
      const agent: Agent = args.command === 'codex-sessions'
        ? 'codex'
        : args.command === 'gemini-sessions'
          ? 'gemini'
          : 'claude';
      const limit = 20;
      const result = await getSessions({ agent, workdir, limit });
      if (!result.ok) {
        process.stderr.write(`Error: ${result.error}\n`);
        process.exit(1);
      }
      if (!result.sessions.length) {
        process.stdout.write(`No ${agent} sessions found for ${workdir}\n`);
        break;
      }
      process.stdout.write(`${agent} sessions (${result.sessions.length}) for ${workdir}:\n\n`);
      for (const s of result.sessions) {
        const run = s.running ? ' [RUNNING]' : '';
        const date = s.createdAt ? s.createdAt.replace('T', ' ').slice(0, 19) : '?';
        const model = s.model ? ` model=${s.model}` : '';
        const title = s.title ? `  ${s.title}` : '';
        const displayId = s.sessionId || '(none)';
        process.stdout.write(`  ${displayId}  ${date}${model}${run}\n`);
        if (title) process.stdout.write(`    ${title}\n`);
      }
      process.exit(0);
    }
    case 'claude-tail': case 'codex-tail': case 'gemini-tail': {
      const agent: Agent = args.command === 'codex-tail'
        ? 'codex'
        : args.command === 'gemini-tail'
          ? 'gemini'
          : 'claude';
      let sessionId: string | null = args.session;

      // Default: find the latest session
      if (!sessionId) {
        const sessions = await getSessions({ agent, workdir, limit: 1 });
        if (!sessions.ok || !sessions.sessions.length) {
          process.stderr.write(`No ${agent} sessions found for ${workdir}\n`);
          process.exit(1);
        }
        sessionId = sessions.sessions[0].sessionId;
        if (!sessionId) {
          process.stderr.write(`Latest ${agent} session has no usable session ID\n`);
          process.exit(1);
        }
      }

      const tail = await getSessionTail({ agent, sessionId, workdir, limit: args.n });
      if (!tail.ok) {
        process.stderr.write(`Error: ${tail.error}\n`);
        process.exit(1);
      }
      if (!tail.messages.length) {
        process.stdout.write(`No messages found in session ${sessionId}\n`);
        break;
      }

      process.stdout.write(`${agent} session ${sessionId.slice(0, 16)}  (last ${tail.messages.length} messages)\n\n`);
      for (const m of tail.messages) {
        const icon = m.role === 'user' ? '👤 User' : '🤖 Assistant';
        const preview = m.text.length > 300 ? m.text.slice(0, 300) + '...' : m.text;
        process.stdout.write(`${icon}:\n${preview}\n\n`);
      }
      process.exit(0);
    }
    case 'claude-run': case 'codex-run': {
      const agent: Agent = args.command === 'codex-run' ? 'codex' : 'claude';
      const prompt = args.prompt;
      if (!prompt) {
        process.stderr.write(`Missing prompt. Use -p "..." or pass text after the command.\n`);
        process.exit(1);
      }
      const opts: StreamOpts = {
        agent, prompt, workdir, timeout: args.timeout,
        sessionId: null, model: null, thinkingEffort: 'max',
        onText: (text, _thinking) => {
          process.stdout.write(`\r\x1b[K${text.slice(-120)}`);
        },
        claudeModel: agent === 'claude' ? (args.model || undefined) : undefined,
        claudePermissionMode: agent === 'claude' ? 'bypassPermissions' : undefined,
        codexModel: agent === 'codex' ? (args.model || undefined) : undefined,
        codexFullAccess: agent === 'codex' ? true : undefined,
      };
      process.stdout.write(`Running ${agent}${args.model ? ` (model: ${args.model})` : ''}...\n`);
      const result = await doStream(opts);
      // Clear the streaming line and print final result
      process.stdout.write('\r\x1b[K');
      process.stdout.write(`--- ${agent} result ---\n`);
      process.stdout.write(`ok:        ${result.ok}\n`);
      process.stdout.write(`model:     ${result.model ?? '(unknown)'}\n`);
      process.stdout.write(`session:   ${result.sessionId ?? '(none)'}\n`);
      process.stdout.write(`elapsed:   ${result.elapsedS.toFixed(1)}s\n`);
      process.stdout.write(`tokens:    in=${result.inputTokens ?? '?'} out=${result.outputTokens ?? '?'} cached=${result.cachedInputTokens ?? '?'} cacheCreate=${result.cacheCreationInputTokens ?? '?'}\n`);
      if (result.contextPercent != null) {
        process.stdout.write(`context:   ${result.contextUsedTokens}/${result.contextWindow} (${result.contextPercent}%)\n`);
      }
      process.stdout.write(`stop:      ${result.stopReason ?? 'n/a'}\n`);
      if (result.error) process.stdout.write(`error:     ${result.error}\n`);
      process.stdout.write(`---\n`);
      if (result.thinking) {
        process.stdout.write(`\n<thinking>\n${formatThinkingForDisplay(result.thinking, 800)}\n</thinking>\n`);
      }
      process.stdout.write(`\n${result.message}\n`);
      process.exit(result.ok ? 0 : 1);
    }
    default:
      process.stderr.write(`Unknown command: ${args.command}\n`);
      process.stderr.write(`Available commands: skills, claude-run, codex-run, claude-status, codex-status, claude-models, codex-models, claude-sessions, codex-sessions, claude-tail, codex-tail\n`);
      process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
