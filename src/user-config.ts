import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from './code-agent.js';

export interface UserConfig {
  version: 1;
  channel?: 'telegram' | 'feishu' | 'whatsapp';
  defaultAgent?: Agent;
  defaultWorkdir?: string;
  telegramBotToken?: string;
}

function expandHomeDir(value: string): string {
  return value.replace(/^~/, process.env.HOME || '');
}

function configRootDir(): string {
  const custom = (process.env.CODECLAW_CONFIG_DIR || '').trim();
  if (custom) return path.resolve(custom);

  if (process.platform === 'win32') {
    const appData = (process.env.APPDATA || '').trim();
    if (appData) return path.join(appData, 'codeclaw');
  }

  const xdg = (process.env.XDG_CONFIG_HOME || '').trim();
  if (xdg) return path.join(xdg, 'codeclaw');

  return path.join(os.homedir(), '.config', 'codeclaw');
}

export function getUserConfigPath(): string {
  const custom = (process.env.CODECLAW_CONFIG || '').trim();
  if (custom) return path.resolve(custom);
  return path.join(configRootDir(), 'config.json');
}

export function loadUserConfig(): Partial<UserConfig> {
  const filePath = getUserConfigPath();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function saveUserConfig(config: Partial<UserConfig>): string {
  const filePath = getUserConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export function updateUserConfig(patch: Partial<UserConfig>): string {
  return saveUserConfig({ ...loadUserConfig(), ...patch });
}

export function resolveUserWorkdir(opts: {
  workdir?: string | null;
  config?: Partial<UserConfig>;
  cwd?: string;
} = {}): string {
  const config = opts.config || loadUserConfig();
  const raw = String(
    opts.workdir
    || process.env.CODECLAW_WORKDIR
    || config.defaultWorkdir
    || opts.cwd
    || process.cwd(),
  ).trim();
  return path.resolve(expandHomeDir(raw));
}

export function applyUserConfig(config: Partial<UserConfig>, channel: string) {
  if (!process.env.CODECLAW_CHANNEL && config.channel) process.env.CODECLAW_CHANNEL = config.channel;
  if (!process.env.DEFAULT_AGENT && config.defaultAgent) process.env.DEFAULT_AGENT = config.defaultAgent;
  if (!process.env.CODECLAW_WORKDIR && config.defaultWorkdir) process.env.CODECLAW_WORKDIR = config.defaultWorkdir;

  if (channel === 'telegram' && !process.env.TELEGRAM_BOT_TOKEN && config.telegramBotToken) {
    process.env.TELEGRAM_BOT_TOKEN = config.telegramBotToken;
  }
}
