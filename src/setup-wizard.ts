import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { Agent, AgentInfo } from './code-agent.js';
import { buildSetupGuide, collectSetupState, type SetupState } from './onboarding.js';
import { getUserConfigPath, saveUserConfig } from './user-config.js';
import { VALIDATION_TIMEOUTS } from './constants.js';

type Channel = 'telegram' | 'feishu' | 'weixin' | 'whatsapp';

export interface TelegramBotIdentity {
  id: number;
  username: string | null;
  displayName: string | null;
}

export interface TelegramTokenCheckResult {
  ok: boolean;
  bot: TelegramBotIdentity | null;
  error: string | null;
}

export interface PromptIO {
  ask(prompt: string): Promise<string>;
  write(text: string): void;
  runCommand(command: string, args?: string[]): Promise<number>;
  close(): void;
}

export interface SetupWizardOptions {
  version: string;
  channel: Channel;
  argsAgent?: string | null;
  currentToken?: string | null;
  initialState: SetupState;
  listAgents: () => AgentInfo[];
  validateTelegramToken?: (token: string) => Promise<TelegramTokenCheckResult>;
  persistConfig?: typeof saveUserConfig;
  io?: PromptIO;
}

export interface SetupWizardResult {
  completed: boolean;
  token: string | null;
  agent: Agent | null;
  configPath: string | null;
  tokenCheck: TelegramTokenCheckResult | null;
}

function createTerminalIO(): PromptIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(prompt: string) {
      return rl.question(prompt);
    },
    write(text: string) {
      process.stdout.write(text);
    },
    runCommand(command: string, args: string[] = []) {
      return new Promise<number>(resolve => {
        const child = spawn(command, args, {
          stdio: 'inherit',
          env: process.env,
        });
        child.on('exit', code => resolve(code ?? 1));
        child.on('error', () => resolve(1));
      });
    },
    close() {
      void rl.close();
    },
  };
}

function parseChoice(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

async function askYesNo(io: PromptIO, prompt: string, def: boolean): Promise<boolean> {
  const suffix = def ? ' [Y/n] ' : ' [y/N] ';
  for (;;) {
    const answer = parseChoice(await io.ask(`${prompt}${suffix}`));
    if (!answer) return def;
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
    io.write('Please answer y or n.\n');
  }
}

async function askAgentChoice(io: PromptIO, installed: AgentInfo[]): Promise<Agent | null> {
  io.write('Choose your local coding agent:\n');
  io.write(`  1. Codex${installed.some(a => a.agent === 'codex' && a.installed) ? ' (installed)' : ''}\n`);
  io.write(`  2. Claude Code${installed.some(a => a.agent === 'claude' && a.installed) ? ' (installed)' : ''}\n`);
  io.write('  q. Quit setup\n');
  for (;;) {
    const answer = parseChoice(await io.ask('Selection [1/2/q]: '));
    if (answer === '1' || answer === 'codex') return 'codex';
    if (answer === '2' || answer === 'claude') return 'claude';
    if (answer === 'q' || answer === 'quit') return null;
    io.write('Please choose 1, 2, or q.\n');
  }
}

function preferredInstalledAgent(agents: AgentInfo[]): Agent | null {
  if (agents.some(agent => agent.agent === 'codex' && agent.installed)) return 'codex';
  if (agents.some(agent => agent.agent === 'claude' && agent.installed)) return 'claude';
  return null;
}

function parseAgent(value: string | null | undefined): Agent | null {
  return value === 'claude' || value === 'codex' ? value : null;
}

function title(label: string): string {
  return `\n${label}\n${'-'.repeat(label.length)}\n`;
}

export async function validateTelegramToken(token: string): Promise<TelegramTokenCheckResult> {
  const value = String(token || '').trim();
  if (!value) return { ok: false, bot: null, error: 'The token was empty.' };

  try {
    const resp = await fetch(`https://api.telegram.org/bot${value}/getMe`, {
      method: 'POST',
      signal: AbortSignal.timeout(VALIDATION_TIMEOUTS.telegramToken),
    });
    const raw = await resp.text();
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      return { ok: false, bot: null, error: `Telegram returned invalid JSON (${resp.status}).` };
    }

    if (!resp.ok || parsed?.ok !== true || !parsed?.result) {
      const detail = typeof parsed?.description === 'string' ? parsed.description : `HTTP ${resp.status}`;
      return { ok: false, bot: null, error: `Telegram rejected this token: ${detail}` };
    }

    return {
      ok: true,
      bot: {
        id: parsed.result.id,
        username: parsed.result.username || null,
        displayName: parsed.result.first_name || null,
      },
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? 'unknown error');
    return { ok: false, bot: null, error: `Failed to reach Telegram: ${msg}` };
  }
}

export async function runSetupWizard(options: SetupWizardOptions): Promise<SetupWizardResult> {
  const io = options.io || createTerminalIO();
  const validate = options.validateTelegramToken || validateTelegramToken;
  const persistConfig = options.persistConfig || saveUserConfig;
  let state = options.initialState;
  let selectedAgent: Agent | null = parseAgent(options.argsAgent);
  let token = String(options.currentToken || '').trim() || null;
  let tokenCheck: TelegramTokenCheckResult | null = null;
  let configPath: string | null = null;

  const refreshState = () => {
    state = collectSetupState({
      agents: options.listAgents(),
      channel: options.channel,
      tokenProvided: !!token,
    });
    return state;
  };

  try {
    io.write(title(`pikiclaw v${options.version} setup`));

    if (options.channel !== 'telegram') {
      io.write(buildSetupGuide(state, options.version));
      io.write('\nInteractive setup is currently only available for Telegram.\n');
      return { completed: false, token, agent: null, configPath: null, tokenCheck: null };
    }

    io.write('This wizard will help you install or verify a local agent, validate your Telegram bot token, and optionally save the setup for next time.\n');

    refreshState();
    io.write(title('Step 1: Local agent'));

    if (!selectedAgent) {
      const installedAgent = preferredInstalledAgent(state.agents);
      if (state.agents.filter(agent => agent.installed).length > 1) {
        selectedAgent = await askAgentChoice(io, state.agents);
      } else {
        selectedAgent = installedAgent || await askAgentChoice(io, state.agents);
      }
    }
    if (!selectedAgent) {
      io.write('Setup cancelled.\n');
      return { completed: false, token, agent: null, configPath: null, tokenCheck: null };
    }

    let selectedState = refreshState().agents.find(agent => agent.agent === selectedAgent) || null;
    if (!selectedState?.installed) {
      io.write(`${selectedState?.label || selectedAgent} is not installed.\n`);
      const installNow = await askYesNo(io, `Install ${selectedAgent === 'claude' ? 'Claude Code' : 'Codex'} now?`, true);
      if (!installNow) {
        io.write('Setup cancelled. Install the agent first, then run `npx pikiclaw@latest` again.\n');
        return { completed: false, token, agent: selectedAgent, configPath: null, tokenCheck: null };
      }

      io.write(`Running: ${selectedState?.installCommand || `npm install -g ${selectedAgent}`}\n`);
      const exitCode = await io.runCommand('npm', ['install', '-g', selectedAgent === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex']);
      selectedState = refreshState().agents.find(agent => agent.agent === selectedAgent) || null;
      if (exitCode !== 0 || !selectedState?.installed) {
        io.write(`Install did not complete successfully. You can try manually: ${selectedState?.installCommand || ''}\n`);
        return { completed: false, token, agent: selectedAgent, configPath: null, tokenCheck: null };
      }
    }

    io.write(`Using ${selectedState.label}.\n`);

    io.write(title('Step 2: Telegram bot token'));
    if (token) {
      tokenCheck = await validate(token);
      if (tokenCheck.ok) {
        io.write(`Existing token looks valid for @${tokenCheck.bot?.username || 'unknown_bot'}.\n`);
      } else {
        io.write(`The existing token could not be verified: ${tokenCheck.error}\n`);
        token = null;
      }
    }

    if (!token) {
      io.write('Get a bot token from Telegram first:\n');
      io.write('  1. Open Telegram and search for @BotFather\n');
      io.write('  2. Send /newbot\n');
      io.write('  3. Choose a display name and a username\n');
      io.write('  4. Paste the token here\n');
    }

    while (!token) {
      const answer = String(await io.ask('Paste your Telegram bot token (or type q to quit): ')).trim();
      if (!answer) continue;
      if (parseChoice(answer) === 'q') {
        io.write('Setup cancelled.\n');
        return { completed: false, token: null, agent: selectedAgent, configPath: null, tokenCheck: null };
      }
      const check = await validate(answer);
      if (!check.ok) {
        io.write(`${check.error}\n`);
        continue;
      }
      token = answer;
      tokenCheck = check;
      io.write(`Telegram bot verified: @${check.bot?.username || 'unknown_bot'}${check.bot?.displayName ? ` (${check.bot.displayName})` : ''}\n`);
    }

    io.write(title('Step 3: Save setup'));
    const configFile = getUserConfigPath();
    const saveIt = await askYesNo(io, `Save this setup to ${configFile}?`, true);
    if (saveIt) {
      configPath = persistConfig({
        channel: 'telegram',
        defaultAgent: selectedAgent,
        telegramBotToken: token,
      });
      io.write(`Saved config to ${configPath}\n`);
    } else {
      io.write('Skipping config save. This run will still start now, but you may need to provide the token again next time.\n');
    }

    io.write(title('Ready'));
    io.write(`Agent: ${selectedAgent}\n`);
    io.write(`Telegram bot: @${tokenCheck?.bot?.username || 'unknown_bot'}\n`);
    io.write('Starting pikiclaw now...\n');

    return {
      completed: true,
      token,
      agent: selectedAgent,
      configPath,
      tokenCheck,
    };
  } finally {
    io.close();
  }
}
