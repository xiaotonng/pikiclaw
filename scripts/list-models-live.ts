import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { listModels } from '../src/code-agent.ts';

function hasCmd(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getVersion(cmd: string): string | null {
  try {
    return execSync(`${cmd} --version 2>/dev/null`, { encoding: 'utf-8' }).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

const workdir = path.resolve(process.argv[2] || process.env.PIKICLAW_WORKDIR || process.cwd());
const claudeCurrentModel = (process.env.CLAUDE_MODEL || 'claude-opus-4-7').trim();
const codexCurrentModel = (process.env.CODEX_MODEL || 'gpt-5.4').trim();

const result = {
  generatedAt: new Date().toISOString(),
  workdir,
  claude: hasCmd('claude')
    ? {
        installed: true,
        version: getVersion('claude'),
        currentModel: claudeCurrentModel,
        discovered: listModels('claude', { workdir, currentModel: claudeCurrentModel }),
      }
    : {
        installed: false,
        version: null,
        currentModel: claudeCurrentModel,
        discovered: null,
      },
  codex: hasCmd('codex')
    ? {
        installed: true,
        version: getVersion('codex'),
        currentModel: codexCurrentModel,
        discovered: listModels('codex', { workdir, currentModel: codexCurrentModel }),
      }
    : {
        installed: false,
        version: null,
        currentModel: codexCurrentModel,
        discovered: null,
      },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
