/**
 * Shared selection UI models and action executor for interactive commands.
 */

import type { Bot, ChatId, Agent, SessionRuntime } from './bot.js';
import { normalizeAgent } from './bot.js';
import { getSessionStatusForChat } from './session-status.js';
import {
  getAgentsListData,
  getModelsListData,
  getSessionsPageData,
  getSkillsListData,
  summarizeSessionRun,
  modelMatchesSelection,
  resolveSkillPrompt,
} from './commands.js';

export type CommandAction =
  | { kind: 'sessions.page'; page: number }
  | { kind: 'session.new' }
  | { kind: 'session.switch'; sessionId: string }
  | { kind: 'agent.switch'; agent: Agent }
  | { kind: 'model.switch'; modelId: string }
  | { kind: 'effort.set'; effort: string }
  | { kind: 'models.select.model'; modelId: string }
  | { kind: 'models.select.effort'; effort: string }
  | { kind: 'models.confirm' }
  | { kind: 'skill.run'; command: string }
  | { kind: 'mode.switch'; mode: string };

export type CommandItemState = 'default' | 'current' | 'running' | 'unavailable';

export interface CommandActionButton {
  label: string;
  action: CommandAction;
  state?: CommandItemState;
  primary?: boolean;
}

export interface CommandSelectionItem {
  label: string;
  detail?: string | null;
  state?: CommandItemState;
}

export interface CommandSelectionView {
  kind: 'sessions' | 'agents' | 'models' | 'skills' | 'mode';
  title: string;
  detail?: string | null;
  metaLines: string[];
  items: CommandSelectionItem[];
  emptyText?: string | null;
  helperText?: string | null;
  rows: CommandActionButton[][];
}

export interface CommandNotice {
  title: string;
  value?: string | null;
  detail?: string | null;
  valueMode?: 'code' | 'plain';
}

export type CommandActionResult =
  | { kind: 'view'; view: CommandSelectionView; callbackText?: string | null }
  | { kind: 'notice'; notice: CommandNotice; callbackText?: string | null; session?: SessionRuntime | null; previewSession?: { agent: Agent; sessionId: string | null } | null }
  | { kind: 'skill'; prompt: string; skillName: string; callbackText?: string | null }
  | { kind: 'noop'; message: string };

function chunkRows<T>(items: T[], columns: number): T[][] {
  const rows: T[][] = [];
  const size = Math.max(1, columns);
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function buttonStateFromFlags(opts: { isCurrent?: boolean; isRunning?: boolean; unavailable?: boolean }): CommandItemState {
  if (opts.unavailable) return 'unavailable';
  if (opts.isRunning) return 'running';
  if (opts.isCurrent) return 'current';
  return 'default';
}

export function encodeCommandAction(action: CommandAction): string {
  switch (action.kind) {
    case 'sessions.page':
      return `sp:${Math.max(0, action.page)}`;
    case 'session.new':
      return 'sess:new';
    case 'session.switch':
      return `sess:${action.sessionId}`;
    case 'agent.switch':
      return `ag:${action.agent}`;
    case 'model.switch':
      return `mod:${action.modelId}`;
    case 'effort.set':
      return `eff:${action.effort}`;
    case 'models.select.model':
      return `md:${action.modelId}`;
    case 'models.select.effort':
      return `ed:${action.effort}`;
    case 'models.confirm':
      return 'mc';
    case 'skill.run':
      return `skr:${action.command}`;
    case 'mode.switch':
      return `pm:${action.mode}`;
  }
}

export function decodeCommandAction(data: string): CommandAction | null {
  if (data === 'sess:new') return { kind: 'session.new' };
  if (data.startsWith('sp:')) {
    const page = Number.parseInt(data.slice(3), 10);
    if (!Number.isFinite(page) || page < 0) return null;
    return { kind: 'sessions.page', page };
  }
  if (data.startsWith('sess:')) {
    const sessionId = data.slice(5);
    if (!sessionId) return null;
    return { kind: 'session.switch', sessionId };
  }
  if (data.startsWith('ag:')) {
    try {
      return { kind: 'agent.switch', agent: normalizeAgent(data.slice(3)) };
    } catch {
      return null;
    }
  }
  if (data.startsWith('mod:')) {
    const modelId = data.slice(4);
    if (!modelId) return null;
    return { kind: 'model.switch', modelId };
  }
  if (data.startsWith('eff:')) {
    const effort = data.slice(4);
    if (!effort) return null;
    return { kind: 'effort.set', effort };
  }
  if (data.startsWith('md:')) {
    const modelId = data.slice(3);
    if (!modelId) return null;
    return { kind: 'models.select.model', modelId };
  }
  if (data.startsWith('ed:')) {
    const effort = data.slice(3);
    if (!effort) return null;
    return { kind: 'models.select.effort', effort };
  }
  if (data === 'mc') return { kind: 'models.confirm' };
  if (data.startsWith('skr:')) {
    const command = data.slice(4);
    if (!command) return null;
    return { kind: 'skill.run', command };
  }
  if (data.startsWith('pm:')) {
    const mode = data.slice(3);
    if (!mode) return null;
    return { kind: 'mode.switch', mode };
  }
  return null;
}

export async function buildSessionsCommandView(
  bot: Bot,
  chatId: ChatId,
  page: number,
  pageSize = 5,
): Promise<CommandSelectionView> {
  const data = await getSessionsPageData(bot, chatId, page, pageSize);
  const sessionButtons = data.sessions.map(session => [{
    label: session.title,
    action: { kind: 'session.switch', sessionId: session.key } as CommandAction,
    state: buttonStateFromFlags({ isCurrent: session.isCurrent, isRunning: session.isRunning }),
    primary: session.isCurrent,
  }]);
  const navRow: CommandActionButton[] = [];
  if (data.page > 0) navRow.push({ label: `◀ p${data.page}`, action: { kind: 'sessions.page', page: data.page - 1 } });
  navRow.push({ label: '+ New', action: { kind: 'session.new' } });
  if (data.page < data.totalPages - 1) navRow.push({ label: `p${data.page + 2} ▶`, action: { kind: 'sessions.page', page: data.page + 1 } });

  return {
    kind: 'sessions',
    title: 'Sessions',
    detail: data.agent,
    metaLines: [`${data.total} total · p${data.page + 1}/${data.totalPages}`],
    items: data.sessions.map(session => ({
      label: session.title,
      detail: session.time,
      state: buttonStateFromFlags({ isCurrent: session.isCurrent, isRunning: session.isRunning }),
    })),
    emptyText: 'No sessions found.',
    helperText: data.totalPages > 1
      ? `Use the controls below to switch or turn pages.`
      : 'Use the controls below to switch or start a new session.',
    rows: navRow.length ? [...sessionButtons, navRow] : sessionButtons,
  };
}

export function buildAgentsCommandView(bot: Bot, chatId: ChatId): CommandSelectionView {
  const data = getAgentsListData(bot, chatId);
  const actions = data.agents
    .filter(agent => agent.installed)
    .map(agent => ({
      label: agent.version ? `${agent.agent} ${agent.version}` : agent.agent,
      action: { kind: 'agent.switch', agent: agent.agent as Agent } as CommandAction,
      state: buttonStateFromFlags({ isCurrent: agent.isCurrent }),
      primary: agent.isCurrent,
    }));

  return {
    kind: 'agents',
    title: 'Agents',
    metaLines: [],
    items: [],
    emptyText: actions.length ? undefined : 'No installed agents.',
    rows: actions.map(action => [action]),
  };
}

// ---------------------------------------------------------------------------
// Models draft state — "select then confirm" pattern
// ---------------------------------------------------------------------------

interface ModelsDraft {
  modelId: string;
  effort: string | null;
}

const modelsDrafts = new Map<string, ModelsDraft>();

async function initModelsDraft(bot: Bot, chatId: ChatId): Promise<ModelsDraft> {
  const data = await getModelsListData(bot, chatId);
  const draft: ModelsDraft = { modelId: data.currentModel, effort: data.effort?.current ?? null };
  modelsDrafts.set(String(chatId), draft);
  return draft;
}

export async function buildModelsCommandView(
  bot: Bot,
  chatId: ChatId,
  draft?: ModelsDraft,
): Promise<CommandSelectionView> {
  const data = await getModelsListData(bot, chatId);

  // Initialize draft from current state or use the provided one
  const d: ModelsDraft = draft ?? {
    modelId: data.currentModel,
    effort: data.effort?.current ?? null,
  };
  modelsDrafts.set(String(chatId), d);

  const isSelected = (modelId: string) => modelMatchesSelection(data.agent, modelId, d.modelId);

  const models = [...data.models].sort((a, b) => Number(isSelected(b.id)) - Number(isSelected(a.id)));
  const modelButtons = models.map(model => ({
    label: model.alias || model.id,
    action: { kind: 'models.select.model', modelId: model.id } as CommandAction,
    state: buttonStateFromFlags({ isCurrent: isSelected(model.id) }),
    primary: isSelected(model.id),
  }));
  const rows = chunkRows(modelButtons, 1);

  if (data.effort) {
    const effortButtons = data.effort.levels.map(level => ({
      label: level.label,
      action: { kind: 'models.select.effort', effort: level.id } as CommandAction,
      state: buttonStateFromFlags({ isCurrent: level.id === d.effort }),
      primary: level.id === d.effort,
    }));
    // Section label — clicking it is harmless (triggers confirm, which is noop if nothing changed)
    rows.push([{
      label: '— Thinking Effort —',
      action: { kind: 'models.confirm' } as CommandAction,
      state: 'default' as CommandItemState,
      primary: false,
    }]);
    // ≤3 levels fit in one row; 4+ split into rows of 2 to avoid Feishu truncation
    rows.push(...chunkRows(effortButtons, effortButtons.length <= 3 ? effortButtons.length : 2));
  }

  // Detect whether draft differs from current live values
  const modelChanged = !modelMatchesSelection(data.agent, d.modelId, data.currentModel);
  const effortChanged = !!(data.effort && d.effort !== data.effort.current);
  const hasChanges = modelChanged || effortChanged;

  rows.push([{
    label: hasChanges ? '✓ Apply' : '✓ OK',
    action: { kind: 'models.confirm' } as CommandAction,
    state: 'default' as CommandItemState,
    primary: hasChanges,
  }]);

  return {
    kind: 'models',
    title: 'Models',
    detail: data.agent,
    metaLines: [
      ...(data.sources.length ? [`Source: ${data.sources.join(', ')}`] : []),
      ...(data.note ? [data.note] : []),
      ...(data.effort ? [`Thinking Effort: ${d.effort}`] : []),
    ],
    items: models.map(model => ({
      label: model.alias || model.id,
      detail: model.alias ? model.id : null,
      state: buttonStateFromFlags({ isCurrent: isSelected(model.id) }),
    })),
    emptyText: 'No discoverable models found.',
    helperText: data.models.length ? 'Select model and effort, then tap Apply.' : null,
    rows,
  };
}

export function buildSkillsCommandView(bot: Bot, chatId: ChatId): CommandSelectionView {
  const data = getSkillsListData(bot, chatId);
  const buttons = data.skills.map(skill => ({
    label: skill.label,
    action: { kind: 'skill.run', command: skill.command } as CommandAction,
  }));

  return {
    kind: 'skills',
    title: 'Skills',
    detail: data.agent,
    metaLines: [`Workdir: ${data.workdir}`],
    items: data.skills.map(skill => ({
      label: skill.label,
      detail: skill.description || `/${skill.command}`,
    })),
    emptyText: 'No project skills found.',
    helperText: data.skills.length ? 'Use the controls below to run a skill.' : null,
    rows: chunkRows(buttons, buttons.some(button => button.label.length > 14) ? 1 : 2),
  };
}

export function buildModeCommandView(bot: Bot, chatId: ChatId): CommandSelectionView {
  const cs = bot.chat(chatId);
  const isPlanMode = cs.agent === 'claude' && bot.claudePermissionMode === 'plan';
  return {
    kind: 'mode',
    title: 'Agent Mode',
    detail: `Current: ${isPlanMode ? 'Plan (read-only)' : 'Code (full access)'}`,
    metaLines: cs.agent !== 'claude' ? ['Only available for Claude agent'] : [],
    items: [],
    rows: [
      [
        { label: 'Code', action: { kind: 'mode.switch', mode: 'bypassPermissions' },
          state: isPlanMode ? 'default' : 'current', primary: !isPlanMode },
        { label: 'Plan', action: { kind: 'mode.switch', mode: 'plan' },
          state: isPlanMode ? 'current' : 'default', primary: isPlanMode },
      ],
    ],
  };
}

export async function executeCommandAction(
  bot: Bot,
  chatId: ChatId,
  action: CommandAction,
  opts: { sessionsPageSize?: number } = {},
): Promise<CommandActionResult> {
  const sessionsPageSize = opts.sessionsPageSize ?? 5;

  switch (action.kind) {
    case 'sessions.page':
      return {
        kind: 'view',
        view: await buildSessionsCommandView(bot, chatId, action.page, sessionsPageSize),
        callbackText: '',
      };

    case 'session.new':
      bot.resetConversationForChat(chatId);
      return {
        kind: 'notice',
        callbackText: 'New session',
        notice: {
          title: 'New Session',
          detail: 'Send a message to start.',
        },
      };

    case 'session.switch': {
      const chat = bot.chat(chatId);
      const result = await bot.fetchSessions(chat.agent, bot.chatWorkdir(chatId));
      if (!result.ok) return { kind: 'noop', message: 'Failed to load sessions' };

      const session = result.sessions.find(entry => entry.sessionId === action.sessionId);
      if (!session) return { kind: 'noop', message: 'Session not found' };

      const runtime = bot.adoptExistingSessionForChat(chatId, session);
      const displayId = session.sessionId || action.sessionId;
      const sessionStatus = getSessionStatusForChat(bot, chat, session);
      return {
        kind: 'notice',
        callbackText: `Switched: ${displayId.slice(0, 12)}`,
        notice: {
          title: 'Session Switched',
          value: displayId,
          detail: summarizeSessionRun({ ...session, running: sessionStatus.isRunning }).noticeDetail,
          valueMode: 'code',
        },
        session: runtime,
        previewSession: { agent: session.agent, sessionId: session.sessionId },
      };
    }

    case 'agent.switch': {
      const chat = bot.chat(chatId);
      if (chat.agent === action.agent) return { kind: 'noop', message: `Already using ${action.agent}` };
      bot.switchAgentForChat(chatId, action.agent);
      const resumed = bot.selectedSession(chatId);
      return {
        kind: 'notice',
        callbackText: `Switched to ${action.agent}`,
        notice: {
          title: 'Agent',
          value: action.agent,
          detail: resumed?.agent === action.agent && resumed.sessionId ? 'Resumed previous session' : 'Session reset',
          valueMode: 'plain',
        },
        session: resumed?.agent === action.agent ? resumed : undefined,
        previewSession: resumed?.agent === action.agent
          ? { agent: resumed.agent, sessionId: resumed.sessionId }
          : null,
      };
    }

    case 'model.switch': {
      const chat = bot.chat(chatId);
      const currentModel = bot.modelForAgent(chat.agent);
      if (modelMatchesSelection(chat.agent, action.modelId, currentModel)) {
        return { kind: 'noop', message: `Already using ${action.modelId}` };
      }
      bot.switchModelForChat(chatId, action.modelId);
      return {
        kind: 'notice',
        callbackText: `Switched to ${action.modelId}`,
        notice: {
          title: 'Model',
          value: action.modelId,
          detail: `${chat.agent} · session reset`,
          valueMode: 'code',
        },
      };
    }

    case 'effort.set': {
      const chat = bot.chat(chatId);
      const currentEffort = bot.effortForAgent(chat.agent);
      if (action.effort === currentEffort) {
        return { kind: 'noop', message: `Already using ${action.effort} effort` };
      }
      bot.switchEffortForChat(chatId, action.effort);
      return {
        kind: 'notice',
        callbackText: `Effort set to ${action.effort}`,
        notice: {
          title: 'Thinking Effort',
          value: action.effort,
          detail: `${chat.agent} · takes effect on next message`,
          valueMode: 'code',
        },
      };
    }

    case 'models.select.model': {
      const draft = modelsDrafts.get(String(chatId)) ?? await initModelsDraft(bot, chatId);
      draft.modelId = action.modelId;
      return { kind: 'view', view: await buildModelsCommandView(bot, chatId, draft), callbackText: '' };
    }

    case 'models.select.effort': {
      const draft = modelsDrafts.get(String(chatId)) ?? await initModelsDraft(bot, chatId);
      draft.effort = action.effort;
      return { kind: 'view', view: await buildModelsCommandView(bot, chatId, draft), callbackText: '' };
    }

    case 'models.confirm': {
      const chat = bot.chat(chatId);
      const draft = modelsDrafts.get(String(chatId));
      modelsDrafts.delete(String(chatId));
      if (!draft) return { kind: 'noop', message: 'No changes' };

      const currentModel = bot.modelForAgent(chat.agent);
      const currentEffort = bot.effortForAgent(chat.agent);
      const modelChanged = !modelMatchesSelection(chat.agent, draft.modelId, currentModel);
      const effortChanged = draft.effort != null && draft.effort !== currentEffort;

      if (!modelChanged && !effortChanged) {
        return { kind: 'noop', message: 'No changes' };
      }

      const parts: string[] = [];
      if (modelChanged) {
        bot.switchModelForChat(chatId, draft.modelId);
        parts.push(`Model: ${draft.modelId}`);
      }
      if (effortChanged) {
        bot.switchEffortForChat(chatId, draft.effort!);
        parts.push(`Effort: ${draft.effort}`);
      }

      return {
        kind: 'notice',
        callbackText: parts.join(', '),
        notice: {
          title: 'Configuration Updated',
          value: parts.join('\n'),
          detail: modelChanged
            ? `${chat.agent} · session reset`
            : `${chat.agent} · takes effect on next message`,
          valueMode: 'plain',
        },
      };
    }

    case 'skill.run': {
      const resolved = resolveSkillPrompt(bot, chatId, action.command, '');
      if (!resolved) return { kind: 'noop', message: 'Skill not found' };
      return {
        kind: 'skill',
        prompt: resolved.prompt,
        skillName: resolved.skillName,
        callbackText: `Run ${resolved.skillName}`,
      };
    }

    case 'mode.switch': {
      const cs = bot.chat(chatId);
      if (cs.agent !== 'claude') {
        return { kind: 'noop', message: 'Mode toggle is only available for Claude agent' };
      }
      bot.switchPermissionModeForChat(chatId, action.mode);
      const label = action.mode === 'plan' ? 'Plan (read-only)' : 'Code (full access)';
      return {
        kind: 'notice',
        callbackText: `Mode: ${label}`,
        notice: { title: 'Agent Mode', value: label },
      };
    }
  }
}
