/**
 * Public session task control surface for dashboard and API routes.
 */

import path from 'node:path';
import { getProjectSkillPaths, listSkills, stageSessionFiles, type Agent } from '../agent/index.js';
import { loadUserConfig } from '../core/config/user-config.js';
import { runtime } from './runtime.js';

const KNOWN_AGENTS = new Set<Agent>(['claude', 'codex', 'gemini']);

/**
 * Resolve a `/skill-name [args]` prompt into the full skill execution prompt.
 * Returns null if the prompt is not a skill invocation or the skill is not found.
 */
function resolveSkillFromPrompt(workdir: string, prompt: string): { resolvedPrompt: string; skillName: string } | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/')) return null;
  // Extract command name and args: "/skill-name some args" → name="skill-name", args="some args"
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/s);
  if (!match) return null;
  const name = match[1];
  const args = (match[2] || '').trim();

  const { skills } = listSkills(workdir);
  // Match by exact skill name (case-insensitive)
  const skill = skills.find(s => s.name.toLowerCase() === name.toLowerCase());
  if (!skill) return null;

  const extra = args ? ` Additional context: ${args}` : '';
  const workdirHint = `[Project directory: ${workdir}]\n\n`;
  const paths = getProjectSkillPaths(workdir, skill.name);
  const skillFile = paths.claudeSkillFile || paths.sharedSkillFile || paths.agentsSkillFile;
  const targetPath = skillFile || `${workdir}/.pikiclaw/skills/${skill.name}/SKILL.md`;
  const resolvedPrompt = `${workdirHint}Read the skill definition at \`${targetPath}\` and execute the instructions defined there.${extra}`;
  return { resolvedPrompt, skillName: skill.name };
}

export interface QueueSessionTaskRequest {
  workdir: string;
  agent?: Agent | string | null;
  sessionId: string;
  prompt: string;
  model?: string | null;
  effort?: string | null;
  attachments?: string[];
}

export function queueDashboardSessionTask(request: QueueSessionTaskRequest) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  if (!request.workdir || (!request.prompt && !(request.attachments || []).length)) {
    return { ok: false as const, error: 'workdir and either prompt or attachments are required' };
  }

  const config = loadUserConfig();
  const resolvedAgent = typeof request.agent === 'string' && KNOWN_AGENTS.has(request.agent as Agent)
    ? request.agent as Agent
    : runtime.getRuntimeDefaultAgent(config);
  const modelId = typeof request.model === 'string' ? request.model.trim() : '';
  const thinkingEffort = resolvedAgent === 'gemini'
    ? ''
    : (typeof request.effort === 'string' ? request.effort.trim().toLowerCase() : '');

  // Resolve /skill-name prompts into full skill execution prompts
  let prompt = request.prompt;
  const skillResult = prompt ? resolveSkillFromPrompt(request.workdir, prompt) : null;
  if (skillResult) {
    prompt = skillResult.resolvedPrompt;
    runtime.debug(`[session-send] resolved skill: ${skillResult.skillName}`);
  }

  let sessionId = request.sessionId;
  let attachments = request.attachments || [];

  // Stage files into the session workspace so temp uploads survive cleanup.
  // Also creates a new pending session when no sessionId is provided.
  if (!sessionId || attachments.length) {
    const staged = stageSessionFiles({
      agent: resolvedAgent,
      workdir: request.workdir,
      files: attachments,
      sessionId: sessionId || null,
      title: request.prompt || 'New session',
      threadId: null,
    });
    if (!sessionId) sessionId = staged.sessionId;
    if (staged.importedFiles.length) {
      attachments = staged.importedFiles.map(f => path.join(staged.workspacePath, f));
    }
  }

  return bot.submitSessionTask({
    workdir: request.workdir,
    agent: resolvedAgent,
    sessionId,
    prompt: prompt || 'Please inspect the attached file(s).',
    attachments,
    ...(modelId ? { modelId } : {}),
    ...(thinkingEffort ? { thinkingEffort } : {}),
  });
}

export function getSessionStreamState(agent: string, sessionId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: true as const, state: null };
  return { ok: true as const, state: bot.getStreamSnapshot(`${agent}:${sessionId}`) };
}

export function cancelSessionTask(taskId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.cancelTask(taskId);
  return { ok: true as const, recalled: result.cancelled || result.interrupted };
}

export async function steerSessionTask(taskId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = await bot.steerTask(taskId);
  return { ok: true as const, steered: result.steered };
}

// ---------------------------------------------------------------------------
// Interaction prompt control (human-in-the-loop)
// ---------------------------------------------------------------------------

export function interactionSelectOption(promptId: string, optionValue: string, opts?: { requestFreeform?: boolean }) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.interactionSelectOption(promptId, optionValue, opts);
  if (!result) return { ok: false as const, error: 'Prompt not found or no longer active' };
  return { ok: true as const, completed: result.completed, advanced: result.advanced };
}

export function interactionSubmitText(promptId: string, text: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.interactionSubmitText(promptId, text);
  if (!result) return { ok: false as const, error: 'Prompt not found or not awaiting text' };
  return { ok: true as const, completed: result.completed, advanced: result.advanced };
}

export function interactionSkip(promptId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.interactionSkip(promptId);
  if (!result) return { ok: false as const, error: 'Prompt not found or no longer active' };
  return { ok: true as const, completed: result.completed, advanced: result.advanced };
}

export function interactionCancel(promptId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.interactionCancel(promptId);
  if (!result) return { ok: false as const, error: 'Prompt not found or no longer active' };
  return { ok: true as const };
}

export function getInteractionPrompt(promptId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const prompt = bot.interactionPrompt(promptId);
  if (!prompt) return { ok: true as const, prompt: null };
  return {
    ok: true as const,
    prompt: {
      promptId: prompt.promptId,
      taskId: prompt.taskId,
      title: prompt.title,
      hint: prompt.hint,
      questions: prompt.questions,
      currentIndex: prompt.currentIndex,
      answers: prompt.answers,
    },
  };
}
