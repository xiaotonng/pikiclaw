import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { createT, type Locale } from '../../i18n';
import { useStore } from '../../store';
import type { Agent, AgentRuntimeStatus, AgentStatusResponse, ModelInfo } from '../../types';
import { cn, getAgentMeta } from '../../utils';
import { BrandIcon } from '../BrandIcon';
import { Badge, Button, Label, Modal, ModalHeader, Select, Spinner } from '../ui';
import { SectionCard } from './shared';

const AGENT_ORDER: Agent[] = ['claude', 'codex', 'gemini'];

const EFFORT_OPTIONS: Record<Agent, string[]> = {
  claude: ['low', 'medium', 'high'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  gemini: [],
};

type SnapshotState = {
  defaultAgent: Agent;
  agents: AgentRuntimeStatus[];
};

type DefaultsDraft = {
  agent: Agent;
  model: string;
  effort: string;
};

type CopyPack = {
  defaultsTitle: string;
  defaultsHint: string;
  defaultsEditTitle: string;
  defaultsEditHint: string;
  defaultsSaved: string;
  editDefaults: string;
  agentsTitle: string;
  defaultAgent: string;
  defaultModel: string;
  defaultEffort: string;
  status: string;
  model: string;
  models: string;
  version: string;
  defaultBadge: string;
  installed: string;
  notInstalled: string;
  noModel: string;
  currentModelPrefix: string;
  availableModelsSuffix: string;
  availableModels: string;
  recommendedFor: string;
  currentConfig: string;
  effort: string;
  readyHint: string;
  installHint: string;
  noVersion: string;
  moreModels: (count: number) => string;
  install: string;
  installing: string;
  noEffort: string;
  loadFailed: string;
};

function getCopy(locale: Locale): CopyPack {
  if (locale === 'zh-CN') {
    return {
      defaultsTitle: '新会话默认值',
      defaultsHint: '新会话会默认采用这里的智能体、模型和推理强度。',
      defaultsEditTitle: '编辑新会话默认值',
      defaultsEditHint: '在弹窗中选择默认智能体、模型和推理强度，保存后对新会话生效。',
      defaultsSaved: '新会话默认值已保存',
      editDefaults: '修改默认值',
      agentsTitle: '可用智能体',
      defaultAgent: '默认智能体',
      defaultModel: '默认模型',
      defaultEffort: '推理强度',
      status: '状态',
      model: '模型',
      models: '模型',
      version: '版本',
      defaultBadge: '默认',
      installed: '已安装',
      notInstalled: '未安装',
      noModel: '暂无可选模型',
      currentModelPrefix: '当前模型',
      availableModelsSuffix: '个可选',
      availableModels: '可用模型',
      recommendedFor: '建议场景',
      currentConfig: '当前配置',
      effort: '推理强度',
      readyHint: '已安装，可直接作为新会话执行智能体。',
      installHint: '尚未安装，需要先完成本地 CLI 安装。',
      noVersion: '版本未知',
      moreModels: count => `+${count}`,
      install: '安装',
      installing: '安装中...',
      noEffort: '不支持调整',
      loadFailed: '无法加载智能体状态',
    };
  }

  return {
    defaultsTitle: 'New Session Defaults',
    defaultsHint: 'New sessions use this agent, model, and effort by default.',
    defaultsEditTitle: 'Edit New Session Defaults',
    defaultsEditHint: 'Choose the default agent, model, and effort in the modal, then save them for new sessions.',
    defaultsSaved: 'New session defaults saved',
    editDefaults: 'Edit Defaults',
    agentsTitle: 'Available Agents',
    defaultAgent: 'Default Agent',
    defaultModel: 'Default Model',
    defaultEffort: 'Effort',
    status: 'Status',
    model: 'Model',
    models: 'Models',
    version: 'Version',
    defaultBadge: 'Default',
    installed: 'Installed',
    notInstalled: 'Not installed',
    noModel: 'No selectable models',
    currentModelPrefix: 'Current model',
    availableModelsSuffix: 'available',
    availableModels: 'Available models',
    recommendedFor: 'Recommended for',
    currentConfig: 'Current config',
    effort: 'Effort',
    readyHint: 'Installed and ready for new sessions.',
    installHint: 'Not installed locally yet.',
    noVersion: 'Version unavailable',
    moreModels: count => `+${count}`,
    install: 'Install',
    installing: 'Installing...',
    noEffort: 'Not supported',
    loadFailed: 'Failed to load agent status',
  };
}

function buildAgentOptions(agents: AgentRuntimeStatus[], copy: CopyPack) {
  const installedAgents = agents.filter(agent => agent.installed);
  const source = installedAgents.length ? installedAgents : agents;
  return source.map(agent => ({
    value: agent.agent,
    label: `${getAgentMeta(agent.agent).label} · ${agent.installed ? (agent.version || copy.installed) : copy.notInstalled}`,
  }));
}

function buildModelOptions(agent: AgentRuntimeStatus | null | undefined) {
  if (!agent) return [];
  const options = agent.models.map(model => ({
    value: model.id,
    label: model.alias ? `${model.alias} · ${model.id}` : model.id,
  }));
  if (agent.selectedModel && !options.some(option => option.value === agent.selectedModel)) {
    options.unshift({ value: agent.selectedModel, label: agent.selectedModel });
  }
  return options;
}

function buildEffortOptions(agent: AgentRuntimeStatus | null | undefined) {
  if (!agent) return [];
  return EFFORT_OPTIONS[agent.agent].map(value => ({ value, label: value }));
}

function summarizeModels(agent: AgentRuntimeStatus, copy: CopyPack): string {
  if (!agent.models.length) return copy.noModel;
  const currentModel = agent.selectedModel
    ? agent.models.find(model => model.id === agent.selectedModel)
    : agent.models[0];
  const modelLabel = currentModel?.alias || currentModel?.id || copy.noModel;
  return `${copy.currentModelPrefix}: ${modelLabel} · ${agent.models.length} ${copy.availableModelsSuffix}`;
}

function modelLabel(model: ModelInfo | null | undefined): string {
  if (!model) return '—';
  return model.alias || model.id;
}

function currentModelLabel(agent: AgentRuntimeStatus, copy: CopyPack): string {
  if (!agent.models.length) return copy.noModel;
  const currentModel = agent.selectedModel
    ? agent.models.find(model => model.id === agent.selectedModel)
    : agent.models[0];
  return modelLabel(currentModel);
}

function visibleModels(agent: AgentRuntimeStatus, limit = 4): Array<{ key: string; label: string }> {
  const seen = new Set<string>();
  const source = agent.models
    .map(model => ({ key: model.id, label: modelLabel(model) }))
    .filter(model => {
      if (seen.has(model.key)) return false;
      seen.add(model.key);
      return true;
    });
  return source.slice(0, limit);
}

function applySnapshot(setter: (value: SnapshotState) => void, next: AgentStatusResponse) {
  setter({
    defaultAgent: next.defaultAgent,
    agents: next.agents,
  });
}

function buildDefaultsDraft(agent: AgentRuntimeStatus | null, fallbackAgent: Agent): DefaultsDraft {
  return {
    agent: agent?.agent || fallbackAgent,
    model: agent?.selectedModel || '',
    effort: agent?.selectedEffort || '',
  };
}

function SummaryField({
  label,
  value,
  hint,
  loading = false,
}: {
  label: string;
  value: string;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-edge bg-panel-alt px-3.5 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-5">{label}</div>
      <div className="mt-1 flex items-center gap-2 text-[13px] font-semibold text-fg-2">
        {loading && <Spinner className="h-3.5 w-3.5" />}
        <span>{value}</span>
      </div>
      {hint && <div className="mt-0.5 text-[10px] leading-relaxed text-fg-5">{hint}</div>}
    </div>
  );
}

function AgentRow({
  agent,
  copy,
  t,
  installing,
  onInstall,
  loading = false,
}: {
  agent: AgentRuntimeStatus;
  copy: CopyPack;
  t: (key: string) => string;
  installing: boolean;
  onInstall: (agent: AgentRuntimeStatus) => void;
  loading?: boolean;
}) {
  const meta = getAgentMeta(agent.agent);
  const modelSummary = summarizeModels(agent, copy);
  const currentModel = currentModelLabel(agent, copy);
  const scenario = meta.advantageKey ? t(meta.advantageKey) : '—';
  const models = visibleModels(agent);
  const hiddenModelCount = Math.max(0, agent.models.length - models.length);
  const effort = agent.selectedEffort || copy.noEffort;
  const versionText = agent.version || copy.noVersion;
  const statusLabel = loading
    ? t('status.loading')
    : agent.installed
      ? copy.installed
      : copy.notInstalled;
  const statusVariant = loading
    ? 'muted'
    : agent.installed
      ? 'ok'
      : 'warn';
  const statusHint = loading
    ? t('status.loading')
    : agent.installed
      ? copy.readyHint
      : copy.installHint;
  const displayModel = loading ? t('status.loading') : currentModel;
  const displayEffort = loading ? t('status.loading') : effort;
  const displayScenario = loading ? t('status.loading') : scenario;
  const displayModelSummary = loading ? t('status.loading') : modelSummary;

  return (
    <div className="glass rounded-md border border-edge px-4 py-3 shadow-[0_1px_0_rgba(255,255,255,0.02),0_4px_12px_rgba(15,23,42,0.05)]">
      <div className="grid gap-x-5 gap-y-3 xl:grid-cols-[220px_130px_220px_minmax(0,1fr)_auto] xl:items-start">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-edge bg-panel-alt">
              <BrandIcon brand={agent.agent} size={22} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-[15px] font-semibold text-fg">{meta.label}</div>
                {agent.isDefault && <Badge variant="accent">{copy.defaultBadge}</Badge>}
              </div>
              <div className="mt-1 text-[12px] leading-relaxed text-fg-5">
                {copy.version}: {versionText}
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">{copy.status}</div>
          <div className="mt-1.5">
            <Badge variant={statusVariant}>
              {loading && <Spinner className="h-3 w-3" />}
              {statusLabel}
            </Badge>
          </div>
          <div className="mt-1.5 text-[12px] leading-relaxed text-fg-5">
            {statusHint}
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">{copy.currentConfig}</div>
          <div className="mt-1.5 space-y-1.5 text-[13px] leading-relaxed text-fg-3">
            <div className="flex items-start gap-2">
              <span className="w-16 shrink-0 text-fg-5">{copy.model}</span>
              <span className="min-w-0 break-words text-fg-2">{displayModel}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-16 shrink-0 text-fg-5">{copy.effort}</span>
              <span className="text-fg-2">{displayEffort}</span>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">{copy.recommendedFor}</div>
          <div className="mt-1.5 text-[13px] leading-relaxed text-fg-3">{displayScenario}</div>
          <div className="mt-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">{copy.availableModels}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {!loading && models.length > 0 ? models.map(model => (
              <span
                key={model.key}
                className="inline-flex h-6 max-w-full items-center rounded-md border border-edge bg-panel-alt px-2 text-[11px] text-fg-3"
                title={model.key}
              >
                <span className="truncate">{model.label}</span>
              </span>
            )) : (
              <span className="text-[12px] text-fg-5">{loading ? t('status.loading') : copy.noModel}</span>
            )}
            {!loading && hiddenModelCount > 0 && (
              <span className="inline-flex h-6 items-center rounded-md border border-edge bg-panel-alt px-2 text-[11px] text-fg-5">
                {copy.moreModels(hiddenModelCount)}
              </span>
            )}
          </div>
          <div className="mt-1.5 text-[12px] leading-relaxed text-fg-5">{displayModelSummary}</div>
        </div>

        <div className={cn('flex justify-start xl:justify-end', agent.installed && 'xl:self-start')}>
          {loading && (
            <div className="inline-flex h-7 items-center gap-2 rounded-md border border-edge bg-transparent px-2.5 text-[11px] text-fg-5">
              <Spinner className="h-3 w-3" />
              {t('status.loading')}
            </div>
          )}
          {!loading && !agent.installed && (
            <Button variant="outline" size="sm" disabled={installing} onClick={() => onInstall(agent)}>
              {installing ? copy.installing : copy.install}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentTab() {
  const { locale, toast } = useStore();
  const t = createT(locale);
  const copy = getCopy(locale);
  const [snapshot, setSnapshot] = useState<SnapshotState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [installingAgent, setInstallingAgent] = useState<Agent | null>(null);
  const [defaultsModalOpen, setDefaultsModalOpen] = useState(false);
  const [draft, setDraft] = useState<DefaultsDraft>({
    agent: 'codex',
    model: '',
    effort: '',
  });
  const hasLoaded = useRef(false);

  const refresh = useCallback(async () => {
    if (!hasLoaded.current) setLoading(true);
    try {
      const status = await api.getAgentStatus();
      applySnapshot(setSnapshot, status);
      setError(null);
      hasLoaded.current = true;
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : copy.loadFailed;
      setError(message);
      if (!hasLoaded.current) toast(message, false);
      return null;
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const agents = useMemo(() => {
    const source = snapshot?.agents || [];
    const map = new Map(source.map(agent => [agent.agent, agent] as const));
    return AGENT_ORDER.map(agentId => {
      const current = map.get(agentId);
      if (current) return current;
      const meta = getAgentMeta(agentId);
      return {
        agent: agentId,
        label: meta.label,
        installed: false,
        version: undefined,
        installCommand: undefined,
        selectedModel: null,
        selectedEffort: null,
        isDefault: snapshot?.defaultAgent === agentId,
        models: [],
        usage: null,
      } satisfies AgentRuntimeStatus;
    });
  }, [snapshot]);

  const defaultAgent = snapshot?.defaultAgent || 'codex';
  const defaultAgentStatus = agents.find(agent => agent.agent === defaultAgent) || null;
  const installedAgents = agents.filter(agent => agent.installed);
  const canEditDefaults = installedAgents.length > 0;
  const agentOptions = buildAgentOptions(agents, copy);
  const modalAgentStatus = agents.find(agent => agent.agent === draft.agent) || null;
  const modalModelOptions = buildModelOptions(modalAgentStatus);
  const modalEffortOptions = buildEffortOptions(modalAgentStatus);

  const updateRuntime = useCallback(async (patch: Record<string, unknown>) => {
    setUpdating(true);
    try {
      const result = await api.updateRuntimeAgent(patch);
      if (!result.ok) throw new Error(result.error || t('config.applyFailed'));
      applySnapshot(setSnapshot, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : t('config.applyFailed');
      toast(message, false);
      void refresh();
      return null;
    } finally {
      setUpdating(false);
    }
  }, [refresh, t, toast]);

  useEffect(() => {
    if (!defaultsModalOpen) return;
    setDraft(buildDefaultsDraft(defaultAgentStatus, defaultAgent));
  }, [defaultAgent, defaultAgentStatus, defaultsModalOpen]);

  useEffect(() => {
    if (!defaultsModalOpen || !modalAgentStatus) return;
    const nextModel = modalAgentStatus.selectedModel || '';
    const hasCurrentModel = !draft.model || modalModelOptions.some(option => option.value === draft.model);
    const nextEffort = modalAgentStatus.selectedEffort || '';
    const hasCurrentEffort = !draft.effort || modalEffortOptions.some(option => option.value === draft.effort);
    if (hasCurrentModel && hasCurrentEffort) return;
    setDraft(current => ({
      ...current,
      model: hasCurrentModel ? current.model : nextModel,
      effort: hasCurrentEffort ? current.effort : nextEffort,
    }));
  }, [defaultsModalOpen, draft.effort, draft.model, modalAgentStatus, modalEffortOptions, modalModelOptions]);

  const handleDraftAgentChange = useCallback((agentId: string) => {
    const next = agents.find(agent => agent.agent === agentId);
    if (!next?.installed) return;
    setDraft(buildDefaultsDraft(next, next.agent));
  }, [agents]);

  const handleSaveDefaults = useCallback(async () => {
    if (!modalAgentStatus?.installed) return;
    const patch: Record<string, unknown> = {};
    if (draft.agent !== defaultAgent) patch.defaultAgent = draft.agent;
    if (draft.model && draft.model !== (modalAgentStatus.selectedModel || '')) {
      patch.agent = draft.agent;
      patch.model = draft.model;
    }
    if (draft.effort && draft.effort !== (modalAgentStatus.selectedEffort || '')) {
      patch.agent = draft.agent;
      patch.effort = draft.effort;
    }
    if (Object.keys(patch).length === 0) {
      setDefaultsModalOpen(false);
      return;
    }
    const result = await updateRuntime(patch);
    if (!result) return;
    toast(copy.defaultsSaved);
    setDefaultsModalOpen(false);
  }, [copy.defaultsSaved, defaultAgent, draft.agent, draft.effort, draft.model, modalAgentStatus, toast, updateRuntime]);

  const handleInstall = useCallback(async (agent: AgentRuntimeStatus) => {
    if (installingAgent) return;
    setInstallingAgent(agent.agent);
    try {
      const result = await api.installAgent(agent.agent);
      if (!result.ok) throw new Error(result.error || t('config.agentInstallFailed'));
      applySnapshot(setSnapshot, result);
      toast(t('config.agentInstalled'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('config.agentInstallFailed');
      toast(message, false);
      void refresh();
    } finally {
      setInstallingAgent(current => (current === agent.agent ? null : current));
    }
  }, [installingAgent, refresh, t, toast]);
  const initialLoading = loading && !snapshot;

  const defaultAgentValue = initialLoading
    ? t('status.loading')
    : defaultAgentStatus
      ? getAgentMeta(defaultAgentStatus.agent).label
      : copy.notInstalled;
  const defaultAgentHint = initialLoading
    ? t('status.loading')
    : defaultAgentStatus?.installed
      ? copy.installed
      : copy.notInstalled;
  const defaultModelValue = initialLoading
    ? t('status.loading')
    : defaultAgentStatus
      ? currentModelLabel(defaultAgentStatus, copy)
      : copy.noModel;
  const defaultEffortValue = initialLoading
    ? t('status.loading')
    : defaultAgentStatus?.selectedEffort || copy.noEffort;

  return (
    <div className="animate-in space-y-4">
      <section className="space-y-3">
        <SectionCard className="space-y-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-base font-semibold tracking-tight text-fg">{copy.defaultsTitle}</div>
              <div className="mt-0.5 text-[13px] leading-relaxed text-fg-4">{copy.defaultsHint}</div>
            </div>
            <div className="flex justify-end">
              <Button
                variant="secondary"
                onClick={() => setDefaultsModalOpen(true)}
                disabled={updating || !canEditDefaults}
              >
                {copy.editDefaults}
              </Button>
            </div>
          </div>

          <div className="grid gap-2.5 lg:grid-cols-3">
              <SummaryField label={copy.defaultAgent} value={defaultAgentValue} hint={defaultAgentHint} loading={initialLoading} />
              <SummaryField label={copy.defaultModel} value={defaultModelValue} loading={initialLoading} />
              <SummaryField label={copy.defaultEffort} value={defaultEffortValue} loading={initialLoading} />
          </div>
        </SectionCard>
      </section>

      <section className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-5">{copy.agentsTitle}</div>
        <div className="space-y-3">
          {agents.map(agent => (
            <AgentRow
              key={agent.agent}
              agent={agent}
              copy={copy}
              t={t}
              installing={installingAgent === agent.agent}
              loading={initialLoading}
              onInstall={handleInstall}
            />
          ))}
        </div>
      </section>

      {error && (
        <SectionCard className="border-amber-500/20 bg-amber-500/5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13px] text-fg-2">{error}</div>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              {t('sessions.retry')}
            </Button>
          </div>
        </SectionCard>
      )}

      <Modal open={defaultsModalOpen} onClose={() => setDefaultsModalOpen(false)}>
        <ModalHeader
          title={copy.defaultsEditTitle}
          description={copy.defaultsEditHint}
          onClose={() => setDefaultsModalOpen(false)}
        />
        <div className="space-y-4">
          <div>
            <Label>{copy.defaultAgent}</Label>
            <Select
              value={draft.agent}
              options={agentOptions}
              onChange={handleDraftAgentChange}
              disabled={updating || !canEditDefaults}
              placeholder={copy.notInstalled}
            />
          </div>

          <div>
            <Label>{copy.defaultModel}</Label>
            <Select
              value={draft.model}
              options={modalModelOptions}
              onChange={model => setDraft(current => ({ ...current, model }))}
              disabled={updating || !modalAgentStatus?.installed || modalModelOptions.length === 0}
              placeholder={copy.noModel}
            />
          </div>

          <div>
            <Label>{copy.defaultEffort}</Label>
            <Select
              value={draft.effort}
              options={modalEffortOptions}
              onChange={effort => setDraft(current => ({ ...current, effort }))}
              disabled={updating || !modalAgentStatus?.installed || modalEffortOptions.length === 0}
              placeholder={copy.noEffort}
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDefaultsModalOpen(false)}>
            {t('modal.cancel')}
          </Button>
          <Button variant="primary" disabled={updating || !modalAgentStatus?.installed} onClick={() => void handleSaveDefaults()}>
            {updating ? t('config.validating') : t('modal.save')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export default AgentTab;
