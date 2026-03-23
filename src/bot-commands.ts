/**
 * bot-commands.ts — channel-agnostic command data layer.
 *
 * Each function returns structured data objects that any IM renderer can consume.
 * No rendering, no HTML, no platform-specific formatting.
 *
 * Usage from a channel-specific bot (e.g. bot-telegram.ts, bot-feishu.ts):
 *   const data = await getSessionsPageData(bot, chatId, 0);
 *   const rendered = renderSessionsPage(data); // channel-specific renderer
 */

import path from 'node:path';
import type { Bot, ChatId, Agent, SessionInfo, SessionRuntime, ChatState, StreamResult } from './bot.js';
import { fmtTokens, fmtUptime, fmtBytes } from './bot.js';
import { getProjectSkillPaths, normalizeClaudeModelId } from './code-agent.js';
import { getDriver } from './agent-driver.js';
import { buildWelcomeIntro, buildSkillCommandName, indexSkillsByCommand, SKILL_CMD_PREFIX } from './bot-menu.js';
import { buildBotMenuState } from './bot-orchestration.js';
import { summarizePromptForStatus } from './bot-streaming.js';
import { getSessionStatusForChat } from './session-status.js';
import { VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Welcome / Start
// ---------------------------------------------------------------------------

export interface AgentDetail {
  agent: Agent;
  model: string;
  effort: string | null;
}

export interface StartData {
  title: string;
  subtitle: string;
  version: string;
  agent: Agent;
  workdir: string;
  agentDetails: AgentDetail[];
  commands: Array<{ command: string; description: string }>;
}

export function getStartData(bot: Bot, chatId: ChatId): StartData {
  const cs = bot.chat(chatId);
  const intro = buildWelcomeIntro(VERSION);
  const commands = buildBotMenuState(bot).commands;
  const res = bot.fetchAgents();
  const agentDetails: AgentDetail[] = res.agents
    .filter(a => a.installed)
    .map(a => ({
      agent: a.agent,
      model: bot.modelForAgent(a.agent) || '(default)',
      effort: bot.effortForAgent(a.agent),
    }));
  return {
    ...intro,
    agent: cs.agent,
    workdir: bot.workdir,
    agentDetails,
    commands,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionEntry {
  key: string;
  title: string;
  time: string;
  isCurrent: boolean;
  isRunning: boolean;
  runState: 'running' | 'completed' | 'incomplete';
  runDetail: string | null;
}

export interface SessionsPageData {
  agent: Agent;
  total: number;
  page: number;
  totalPages: number;
  sessions: SessionEntry[];
}

export interface SessionTurnPreviewData {
  userText: string | null;
  assistantText: string | null;
}

export interface SessionRunSummary {
  state: 'running' | 'completed' | 'incomplete';
  shortLabel: string;
  noticeDetail: string;
}

export function summarizeSessionRun(session: Pick<SessionInfo, 'running' | 'runState' | 'runDetail'>): SessionRunSummary {
  if (session.running || session.runState === 'running') {
    return {
      state: 'running',
      shortLabel: 'running',
      noticeDetail: 'Status: running',
    };
  }
  if (session.runState === 'incomplete') {
    const detail = String(session.runDetail || '').trim();
    return {
      state: 'incomplete',
      shortLabel: 'unfinished',
      noticeDetail: detail ? `Status: unfinished · ${detail}` : 'Status: unfinished',
    };
  }
  return {
    state: 'completed',
    shortLabel: 'done',
    noticeDetail: 'Status: completed',
  };
}

export async function getSessionsPageData(bot: Bot, chatId: ChatId, page: number, pageSize = 5): Promise<SessionsPageData> {
  const cs = bot.chat(chatId);
  const res = await bot.fetchSessions(cs.agent);
  const sessions = res.ok ? res.sessions : [];
  const total = sessions.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pg = Math.max(0, Math.min(page, totalPages - 1));
  const slice = sessions.slice(pg * pageSize, (pg + 1) * pageSize);

  const entries: SessionEntry[] = [];
  for (const s of slice) {
    const sessionKey = s.sessionId || '';
    if (!sessionKey) continue;
    const status = getSessionStatusForChat(bot, cs, s);
    const runSummary = summarizeSessionRun({
      running: status.isRunning,
      runState: status.isRunning ? 'running' : s.runState,
      runDetail: s.runDetail,
    });
    const title = s.title ? s.title.replace(/\n/g, ' ').slice(0, 10) : sessionKey.slice(0, 10);
    const time = s.createdAt
      ? new Date(s.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '?';
    entries.push({
      key: sessionKey,
      title,
      time: `${time} · ${runSummary.shortLabel}`,
      isCurrent: status.isCurrent,
      isRunning: status.isRunning,
      runState: runSummary.state,
      runDetail: s.runDetail,
    });
  }

  return { agent: cs.agent, total, page: pg, totalPages, sessions: entries };
}

export function extractLastSessionTurn(
  messages: Array<{ role: 'user' | 'assistant'; text: string }>,
): SessionTurnPreviewData | null {
  if (!messages.length) return null;

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  const userText = String(lastUserIndex >= 0 ? messages[lastUserIndex].text : '').trim() || null;
  const assistantTexts: string[] = [];
  for (let i = lastUserIndex >= 0 ? lastUserIndex + 1 : 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && messages[i].text) assistantTexts.push(messages[i].text);
  }
  const assistantText = assistantTexts.join('\n\n').trim() || null;

  if (!userText && !assistantText) return null;
  return { userText, assistantText };
}

export async function getSessionTurnPreviewData(
  bot: Bot,
  agent: Agent,
  sessionId: string | null,
  limit = 50,
): Promise<SessionTurnPreviewData | null> {
  if (!sessionId) return null;
  const tail = await bot.fetchSessionTail(agent, sessionId, limit);
  if (!tail.ok || !tail.messages.length) return null;
  return extractLastSessionTurn(tail.messages);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentEntry {
  agent: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  isCurrent: boolean;
}

export interface AgentsListData {
  currentAgent: Agent;
  agents: AgentEntry[];
}

export function getAgentsListData(bot: Bot, chatId: ChatId): AgentsListData {
  const cs = bot.chat(chatId);
  const res = bot.fetchAgents();
  return {
    currentAgent: cs.agent,
    agents: res.agents.map(a => ({
      agent: a.agent,
      installed: a.installed,
      version: a.version ?? null,
      path: a.path ?? null,
      isCurrent: a.agent === cs.agent,
    })),
  };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillEntryData {
  name: string;
  label: string;
  description: string | null;
  command: string;
  source: 'skills';
}

export interface SkillsListData {
  agent: Agent;
  workdir: string;
  skills: SkillEntryData[];
}

export function getSkillsListData(bot: Bot, chatId: ChatId): SkillsListData {
  const cs = bot.chat(chatId);
  const skills = bot.fetchSkills().skills
    .map(skill => {
      const command = buildSkillCommandName(skill.name);
      if (!command) return null;
      return {
        name: skill.name,
        label: skill.label || skill.name.charAt(0).toUpperCase() + skill.name.slice(1),
        description: skill.description,
        command,
        source: skill.source,
      };
    })
    .filter((skill): skill is SkillEntryData => !!skill);
  return { agent: cs.agent, workdir: bot.workdir, skills };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelEntry {
  id: string;
  alias: string | null;
  isCurrent: boolean;
}

export interface EffortEntry {
  id: string;
  label: string;
  isCurrent: boolean;
}

export interface ModelsListData {
  agent: Agent;
  currentModel: string;
  sources: string[];
  note: string | null;
  models: ModelEntry[];
  /** null when agent doesn't support effort (e.g. gemini) */
  effort: { current: string; levels: EffortEntry[] } | null;
}

function claudeModelSelectionKey(modelId: string | null | undefined): string | null {
  const value = normalizeClaudeModelId(modelId).toLowerCase();
  if (!value) return null;
  if (value === 'opus' || value.startsWith('claude-opus-')) return 'opus';
  if (value === 'sonnet' || value.startsWith('claude-sonnet-')) return 'sonnet';
  if (value === 'haiku' || value.startsWith('claude-haiku-')) return 'haiku';
  return null;
}

export function modelMatchesSelection(agent: Agent, selection: string, currentModel: string): boolean {
  if (selection === currentModel) return true;
  if (agent !== 'claude') return false;
  const a = claudeModelSelectionKey(selection);
  const b = claudeModelSelectionKey(currentModel);
  return !!a && a === b;
}

const EFFORT_LEVELS: Record<string, { id: string; label: string }[]> = {
  claude: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
  ],
  codex: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Very High' },
  ],
};

function buildEffortData(bot: Bot, agent: Agent): ModelsListData['effort'] {
  const currentEffort = bot.effortForAgent(agent);
  if (!currentEffort) return null;
  const levels = EFFORT_LEVELS[agent];
  if (!levels) return null;
  return {
    current: currentEffort,
    levels: levels.map(l => ({ ...l, isCurrent: l.id === currentEffort })),
  };
}

export async function getModelsListData(bot: Bot, chatId: ChatId): Promise<ModelsListData> {
  const cs = bot.chat(chatId);
  const currentModel = bot.modelForAgent(cs.agent);
  const res = await bot.fetchModels(cs.agent);
  return {
    agent: cs.agent,
    currentModel,
    sources: res.sources,
    note: res.note ?? null,
    models: res.models.map(m => ({
      id: m.id,
      alias: m.alias ?? null,
      isCurrent: modelMatchesSelection(cs.agent, m.id, currentModel),
    })),
    effort: buildEffortData(bot, cs.agent),
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusData {
  version: string;
  uptime: number;
  memRss: number;
  memHeap: number;
  pid: number;
  workdir: string;
  agent: Agent;
  model: string;
  sessionId: string | null;
  workspacePath: string | null;
  activeTasksCount: number;
  running: { prompt: string; startedAt: number } | null;
  stats: { totalTurns: number; totalInputTokens: number; totalOutputTokens: number; totalCachedTokens: number };
  usage: any;
}

export async function getStatusDataAsync(bot: Bot, chatId: ChatId): Promise<StatusData> {
  const d = bot.getStatusData(chatId);
  const driver = getDriver(d.agent);
  const usage = driver.getUsageLive
    ? await driver.getUsageLive({ agent: d.agent, model: d.model }).catch(() => d.usage)
    : d.usage;
  return {
    ...d,
    running: d.running ? { prompt: d.running.prompt, startedAt: d.running.startedAt } : null,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export type HostData = ReturnType<Bot['getHostData']>;

export function getHostDataSync(bot: Bot): HostData {
  return bot.getHostData();
}

// ---------------------------------------------------------------------------
// Skill routing
// ---------------------------------------------------------------------------

export { SKILL_CMD_PREFIX, indexSkillsByCommand };

function relSkillPath(workdir: string, filePath: string): string {
  const relative = path.relative(workdir, filePath).replace(/\\/g, '/');
  return relative && !relative.startsWith('..') ? relative : filePath;
}

export function resolveSkillPrompt(bot: Bot, chatId: ChatId, cmd: string, args: string): { prompt: string; skillName: string } | null {
  const skills = bot.fetchSkills().skills;
  const skill = indexSkillsByCommand(skills).get(cmd);
  if (!skill) return null;
  const cs = bot.chat(chatId);
  const extra = args.trim();
  const suffix = extra ? ` Additional context: ${extra}` : '';
  const workdirHint = `[Project directory: ${bot.workdir}]\n\n`;
  let prompt: string;
  const paths = getProjectSkillPaths(bot.workdir, skill.name);
  const skillFile = paths.claudeSkillFile || paths.sharedSkillFile || paths.agentsSkillFile;
  if (skillFile) {
    prompt = `${workdirHint}Read the skill definition at \`${skillFile}\` and execute the instructions defined there.${suffix}`;
  } else {
    const fallbackPath = `${bot.workdir}/.pikiclaw/skills/${skill.name}/SKILL.md`;
    prompt = `${workdirHint}Read the skill definition at \`${fallbackPath}\` and execute the instructions defined there.${suffix}`;
  }
  return { prompt, skillName: skill.name };
}

// ---------------------------------------------------------------------------
// Re-export commonly used helpers for convenience
// ---------------------------------------------------------------------------

export { summarizePromptForStatus, fmtTokens, fmtUptime, fmtBytes, VERSION };
