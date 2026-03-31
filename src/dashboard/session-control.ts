/**
 * Public session task control surface for dashboard and API routes.
 */

import path from 'node:path';
import { stageSessionFiles, type Agent } from '../agent/index.js';
import { loadUserConfig } from '../core/config/user-config.js';
import { runtime } from './runtime.js';

const KNOWN_AGENTS = new Set<Agent>(['claude', 'codex', 'gemini']);

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
    prompt: request.prompt || 'Please inspect the attached file(s).',
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
