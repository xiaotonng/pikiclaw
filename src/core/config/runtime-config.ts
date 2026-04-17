/**
 * Runtime resolution of agent model and effort preferences.
 */

import type { Agent } from '../../agent/index.js';
import { normalizeClaudeModelId } from '../../agent/index.js';
import type { UserConfig } from './user-config.js';

export const DEFAULT_AGENT_MODELS: Record<Agent, string> = {
  claude: 'claude-opus-4-7',
  codex: 'gpt-5.4',
  gemini: 'gemini-3.1-pro-preview',
};

export const DEFAULT_AGENT_EFFORTS: Partial<Record<Agent, string>> = {
  claude: 'high',
  codex: 'xhigh',
};

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function agentModelEnv(agent: Agent, env: Record<string, string | undefined> = process.env): string {
  switch (agent) {
    case 'claude': return trimmed(env.CLAUDE_MODEL);
    case 'codex': return trimmed(env.CODEX_MODEL);
    case 'gemini': return trimmed(env.GEMINI_MODEL);
  }
  return '';
}

export function agentEffortEnv(agent: Agent, env: Record<string, string | undefined> = process.env): string {
  switch (agent) {
    case 'claude': return trimmed(env.CLAUDE_REASONING_EFFORT).toLowerCase();
    case 'codex': return trimmed(env.CODEX_REASONING_EFFORT).toLowerCase();
    case 'gemini': return '';
  }
  return '';
}

export function resolveAgentModel(config: Partial<UserConfig> | Record<string, any>, agent: Agent): string {
  let value = '';
  switch (agent) {
    case 'claude':
      value = trimmed((config as Partial<UserConfig>).claudeModel || agentModelEnv('claude') || DEFAULT_AGENT_MODELS.claude);
      return normalizeClaudeModelId(value);
    case 'codex':
      value = trimmed((config as Partial<UserConfig>).codexModel || agentModelEnv('codex') || DEFAULT_AGENT_MODELS.codex);
      return value || DEFAULT_AGENT_MODELS.codex;
    case 'gemini':
      value = trimmed((config as Partial<UserConfig>).geminiModel || agentModelEnv('gemini') || DEFAULT_AGENT_MODELS.gemini);
      return value || DEFAULT_AGENT_MODELS.gemini;
  }
  return '';
}

export function resolveAgentEffort(config: Partial<UserConfig> | Record<string, any>, agent: Agent): string | null {
  switch (agent) {
    case 'claude': {
      const value = trimmed((config as Partial<UserConfig>).claudeReasoningEffort || agentEffortEnv('claude') || DEFAULT_AGENT_EFFORTS.claude).toLowerCase();
      return value || DEFAULT_AGENT_EFFORTS.claude || null;
    }
    case 'codex': {
      const value = trimmed((config as Partial<UserConfig>).codexReasoningEffort || agentEffortEnv('codex') || DEFAULT_AGENT_EFFORTS.codex).toLowerCase();
      return value || DEFAULT_AGENT_EFFORTS.codex || null;
    }
    case 'gemini':
      return null;
  }
  return null;
}

export function setAgentModelEnv(agent: Agent, value: string, env: NodeJS.ProcessEnv = process.env): void {
  switch (agent) {
    case 'claude': env.CLAUDE_MODEL = value; break;
    case 'codex': env.CODEX_MODEL = value; break;
    case 'gemini': env.GEMINI_MODEL = value; break;
  }
}

export function setAgentEffortEnv(agent: Agent, value: string, env: NodeJS.ProcessEnv = process.env): void {
  switch (agent) {
    case 'claude': env.CLAUDE_REASONING_EFFORT = value; break;
    case 'codex': env.CODEX_REASONING_EFFORT = value; break;
    case 'gemini': break;
  }
}
