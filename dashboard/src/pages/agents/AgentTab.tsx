/**
 * Agent configuration tab.
 *
 * Two independent concerns sit on each agent card:
 *
 *   1. Install state (CLI binary present on PATH) — purely a status check.
 *      When not installed, the only available action is "Install"; we do NOT
 *      surface configuration controls because they would be moot.
 *
 *   2. Provider / Model / Effort — editable inline once installed. Provider is
 *      the primary single-pick (Native CLI auth or any connected BYOK
 *      provider); Model and Effort follow the chosen provider.
 *
 * The top "新会话默认值" section only picks which agent is the default for new
 * sessions. Each agent's own model/effort/provider lives on its own card and
 * is editable any time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { createT, type Locale } from '../../i18n';
import { useStore } from '../../store';
import type { Agent, AgentRuntimeStatus, AgentStatusResponse, ModelInfo } from '../../types';
import { cn, EFFORT_OPTIONS, getAgentMeta } from '../../utils';
import { BrandIcon } from '../../components/BrandIcon';
import { Badge, Button, Input, Label, Modal, ModalHeader, ModelSelect, Select, Spinner } from '../../components/ui';
import { SectionCard } from '../shared';
import ModelsSection, { useModelLayer, type ModelLayerSnapshot } from '../models/ModelsTab';
import LocalModelsSection from '../local-models/LocalModelsSection';

const NATIVE_PROVIDER_VALUE = '__native__';
const AGENT_ORDER: Agent[] = ['claude', 'codex', 'gemini', 'hermes'];

// Mirrors the backend type in src/model/validation.ts. Pricing fields are USD
// per 1M tokens; `created` is unix epoch (seconds).
interface ProviderModelInfo {
  id: string;
  name?: string;
  created?: number;
  contextLength?: number;
  pricePromptUsd?: number;
  priceCompletionUsd?: number;
}

function formatUsdPerMillion(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(1)}`;
}

function formatContextLength(n: number | undefined): string | null {
  if (!n || !Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M ctx`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K ctx`;
  return `${n} ctx`;
}

function formatCreatedDate(epochSeconds: number | undefined): string | null {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return null;
  // OpenRouter / OpenAI use seconds; Anthropic sometimes returns ms. Detect by
  // magnitude: anything older than year 3000 in seconds is almost certainly
  // already in milliseconds.
  const ms = epochSeconds > 32_000_000_000 ? epochSeconds : epochSeconds * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

/**
 * Two-line option for a provider model. Line 1 is the raw model id (e.g.
 * `openai/gpt-5.4-mini`) so users can always see exactly what they are
 * binding — friendly names like "OpenAI: GPT-5.4 Mini" hide the
 * provider/slash structure that matters when picking between near-duplicates.
 * Line 2 is the friendly name (when it adds info) followed by pricing →
 * context → release date, monospace and muted.
 */
function buildModelOption(info: ProviderModelInfo): { label: string; description?: string } {
  const label = info.id;
  const parts: string[] = [];
  const friendly = info.name?.trim();
  if (friendly && friendly.toLowerCase() !== info.id.toLowerCase()) parts.push(friendly);
  const prompt = formatUsdPerMillion(info.pricePromptUsd);
  const completion = formatUsdPerMillion(info.priceCompletionUsd);
  if (prompt && completion) parts.push(`${prompt} / ${completion} per 1M`);
  else if (prompt) parts.push(`${prompt} prompt / 1M`);
  const ctx = formatContextLength(info.contextLength);
  if (ctx) parts.push(ctx);
  const released = formatCreatedDate(info.created);
  if (released) parts.push(released);
  return { label, description: parts.length ? parts.join(' · ') : undefined };
}

/**
 * When true the agent's native CLI config is *external* to pikiclaw — we
 * read it but cannot write to it (e.g. Hermes' ~/.hermes/config.yaml is
 * managed via `hermes config`). The unified config modal keeps native fields
 * read-only for these.
 */
function isNativeConfigExternal(agent: Agent): boolean {
  return agent === 'hermes';
}

/**
 * Map a native provider slug returned by the driver (e.g. 'openrouter') to a
 * BrandIcon id. Falls back to 'custom' when unknown.
 */
function brandIdForNativeSlug(slug: string | undefined | null): string {
  const s = (slug || '').toLowerCase().trim();
  if (s === 'openrouter') return 'openrouter';
  if (s === 'anthropic') return 'anthropic';
  if (s === 'openai') return 'openai';
  if (s === 'google' || s === 'gemini') return 'google';
  if (s === 'deepseek') return 'deepseek';
  if (s === 'qwen' || s === 'dashscope') return 'qwen';
  if (s === 'doubao' || s === 'volces' || s === 'volcengine') return 'doubao';
  if (s === 'glm' || s === 'zhipu' || s === 'bigmodel') return 'glm';
  if (s === 'minimax') return 'minimax';
  return 'custom';
}

// ---------------------------------------------------------------------------
// Bound profile info — what an agent's currently-active Profile resolves to.
// ---------------------------------------------------------------------------

interface BoundProfileInfo {
  profileId: string;
  providerId: string;
  providerName: string;
  providerBrand: string;
  modelId: string;
  effort: string | null;
}

function brandIdForProvider(p: { kind: string; baseURL: string }): string {
  const host = (() => { try { return new URL(p.baseURL).host.toLowerCase(); } catch { return ''; } })();
  if (host.includes('openrouter')) return 'openrouter';
  if (host.includes('anthropic')) return 'anthropic';
  if (host.includes('deepseek')) return 'deepseek';
  if (host.includes('googleapis') || host.includes('vertex')) return 'google';
  if (host.includes('openai.com')) return 'openai';
  if (host.includes('dashscope') || host.includes('qwen') || host.includes('aliyun')) return 'qwen';
  if (host.includes('volces') || host.includes('volcengine') || host.includes('doubao')) return 'doubao';
  if (host.includes('bigmodel') || host.includes('zhipu') || host.includes('z.ai')) return 'glm';
  if (host.includes('minimax')) return 'minimax';
  if (p.kind === 'anthropic') return 'anthropic';
  if (p.kind === 'google') return 'google';
  if (p.kind === 'openai') return 'openai';
  return 'custom';
}

function buildBoundInfo(layer: ModelLayerSnapshot, agentId: string): BoundProfileInfo | null {
  const profileId = layer.bindings[agentId];
  if (!profileId) return null;
  const profile = layer.profiles.find(p => p.id === profileId);
  if (!profile) return null;
  const provider = layer.providers.find(p => p.id === profile.providerId);
  if (!provider) return null;
  return {
    profileId: profile.id,
    providerId: provider.id,
    providerName: provider.name,
    providerBrand: brandIdForProvider(provider),
    modelId: profile.modelId,
    effort: profile.effort || null,
  };
}

type SnapshotState = {
  defaultAgent: Agent;
  agents: AgentRuntimeStatus[];
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
  installLabel: string;
  versionLabel: string;
  defaultBadge: string;
  installed: string;
  notInstalled: string;
  notInstalledHint: string;
  noModel: string;
  noVersion: string;
  loadFailed: string;
  updateAvailable: string;
  updateSkipped: string;
  updateFailed: string;
  update: string;
  updating: string;
  checkUpdate: string;
  checking: string;
  upToDate: string;
  install: string;
  installing: string;
  modelsTitle: string;
  modelsHint: string;
  localTitle: string;
  localHint: string;
  // Inline editor labels
  rowProvider: string;
  rowModel: string;
  rowEffort: string;
  providerNative: string;
  providerNativeFromAgent: string;
  effortDefault: string;
  modelLoading: string;
  modelEmpty: string;
  modelCustomToggle: string;
  modelListToggle: string;
  modelCustomPlaceholder: string;
  modelSearchPlaceholder: string;
  modelSearchEmpty: string;
  modelCurrentLabel: string;
  saveChanges: string;
  saving: string;
  cancel: string;
  saved: string;
  configError: string;
  // Read-only banner for external native (Hermes)
  externalNativeNote: (path: string) => string;
};

function getCopy(locale: Locale): CopyPack {
  if (locale === 'zh-CN') {
    return {
      defaultsTitle: '新会话默认值',
      defaultsHint: '决定新建对话默认走哪个智能体。具体模型与推理强度由该智能体卡片下的「供应商 / 模型 / 推理强度」决定。',
      defaultsEditTitle: '修改默认智能体',
      defaultsEditHint: '选择新建对话默认走哪个智能体。',
      defaultsSaved: '默认智能体已更新',
      editDefaults: '修改默认',
      agentsTitle: '可用智能体',
      defaultAgent: '默认智能体',
      installLabel: '安装状态',
      versionLabel: '版本',
      defaultBadge: '默认',
      installed: '已安装',
      notInstalled: '未安装',
      notInstalledHint: '安装该智能体的本地 CLI 后即可在此配置供应商与模型。',
      noModel: '未设置',
      noVersion: '版本未知',
      loadFailed: '无法加载智能体状态',
      updateAvailable: '有新版本',
      updateSkipped: '自动更新已跳过',
      updateFailed: '自动更新失败',
      update: '升级',
      updating: '升级中…',
      checkUpdate: '检查更新',
      checking: '检查中…',
      upToDate: '已是最新',
      install: '安装',
      installing: '安装中…',
      modelsTitle: '模型供应商',
      modelsHint: '接入 BYOK 供应商；接入后可在上方任一智能体卡片的「供应商」下拉中选用。',
      localTitle: '本地模型',
      localHint: '在本机检测 Ollama / LM Studio 并按内存推荐合适的开源模型；接入后会作为一个供应商出现在智能体卡片中。',
      rowProvider: '供应商',
      rowModel: '模型',
      rowEffort: '推理强度',
      providerNative: '官方（CLI 内置认证）',
      providerNativeFromAgent: '智能体自身配置',
      effortDefault: '默认',
      modelLoading: '正在拉取模型列表…',
      modelEmpty: '该供应商未返回模型列表，请使用自定义输入。',
      modelCustomToggle: '改为自定义输入',
      modelListToggle: '从列表选择',
      modelCustomPlaceholder: 'anthropic/claude-sonnet-4',
      modelSearchPlaceholder: '搜索模型',
      modelSearchEmpty: '没有匹配的模型',
      modelCurrentLabel: '当前',
      saveChanges: '保存',
      saving: '保存中…',
      cancel: '撤销',
      saved: '已保存',
      configError: '保存失败',
      externalNativeNote: path => `Hermes 当前从 ${path || '~/.hermes/config.yaml'} 读取这些值；切换为某个 BYOK 供应商可由 pikiclaw 接管。`,
    };
  }
  return {
    defaultsTitle: 'New Session Defaults',
    defaultsHint: 'Pick which agent new sessions use by default. Provider / Model / Effort live on each agent card below.',
    defaultsEditTitle: 'Change Default Agent',
    defaultsEditHint: 'Which agent should new sessions use by default?',
    defaultsSaved: 'Default agent updated',
    editDefaults: 'Change default',
    agentsTitle: 'Available Agents',
    defaultAgent: 'Default Agent',
    installLabel: 'Install',
    versionLabel: 'Version',
    defaultBadge: 'Default',
    installed: 'Installed',
    notInstalled: 'Not installed',
    notInstalledHint: 'Install the local CLI for this agent to configure its provider and model.',
    noModel: 'Not set',
    noVersion: 'Version unavailable',
    loadFailed: 'Failed to load agent status',
    updateAvailable: 'Update available',
    updateSkipped: 'Auto-update skipped',
    updateFailed: 'Auto-update failed',
    update: 'Update',
    updating: 'Updating…',
    checkUpdate: 'Check update',
    checking: 'Checking…',
    upToDate: 'Up to date',
    install: 'Install',
    installing: 'Installing…',
    modelsTitle: 'Model Providers',
    modelsHint: 'Connect BYOK providers; pick one in any agent card above.',
    localTitle: 'Local Models',
    localHint: 'Detect Ollama / LM Studio on this machine and surface coding models that fit your RAM. Connected backends show up as a provider on the agent cards.',
    rowProvider: 'Provider',
    rowModel: 'Model',
    rowEffort: 'Effort',
    providerNative: 'Native (CLI auth)',
    providerNativeFromAgent: "agent's own config",
    effortDefault: 'default',
    modelLoading: 'Loading model list…',
    modelEmpty: 'Provider returned no model list — use custom input.',
    modelCustomToggle: 'Use custom input',
    modelListToggle: 'Pick from list',
    modelCustomPlaceholder: 'anthropic/claude-sonnet-4',
    modelSearchPlaceholder: 'Search models',
    modelSearchEmpty: 'No matching models',
    modelCurrentLabel: 'Current',
    saveChanges: 'Save',
    saving: 'Saving…',
    cancel: 'Reset',
    saved: 'Saved',
    configError: 'Save failed',
    externalNativeNote: path => `Hermes reads these values from ${path || '~/.hermes/config.yaml'}; pick a BYOK provider to let pikiclaw take over.`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAgentOptions(agents: AgentRuntimeStatus[], copy: CopyPack) {
  const installedAgents = agents.filter(agent => agent.installed);
  const source = installedAgents.length ? installedAgents : agents;
  return source.map(agent => ({
    value: agent.agent,
    label: `${getAgentMeta(agent.agent).label} · ${agent.installed ? (agent.version || copy.installed) : copy.notInstalled}`,
  }));
}

function modelLabel(model: ModelInfo | null | undefined): string {
  if (!model) return '—';
  return model.alias || model.id;
}

function defaultNativeModel(agent: AgentRuntimeStatus): string {
  // Prefer the agent's *native* model surface — `selectedModel` is now
  // BYOK-overridden when a Profile is bound, so falling through to it would
  // seed the native editor with a BYOK model id that the CLI can't run.
  if (agent.nativeSelectedModel) return agent.nativeSelectedModel;
  if (agent.nativeConfig?.model) return agent.nativeConfig.model;
  if (agent.models.length) return agent.models[0].id;
  return '';
}

function applySnapshot(setter: (value: SnapshotState) => void, next: AgentStatusResponse) {
  setter({ defaultAgent: next.defaultAgent, agents: next.agents });
}

// ---------------------------------------------------------------------------
// Inline editor — Provider / Model / Effort
// ---------------------------------------------------------------------------

interface ConfigDraft {
  providerId: string;       // NATIVE_PROVIDER_VALUE or a Provider id
  modelId: string;
  effort: string;
  modelMode: 'list' | 'custom';
}

function makeInitialDraft(
  agentId: Agent,
  agentStatus: AgentRuntimeStatus | null,
  boundInfo: BoundProfileInfo | null,
): ConfigDraft {
  if (boundInfo) {
    return {
      providerId: boundInfo.providerId,
      modelId: boundInfo.modelId,
      effort: boundInfo.effort || '',
      modelMode: 'list',
    };
  }
  const native = agentStatus?.nativeConfig || null;
  return {
    providerId: NATIVE_PROVIDER_VALUE,
    modelId: native?.model || agentStatus?.selectedModel || '',
    effort: native?.effort || agentStatus?.selectedEffort || '',
    modelMode: 'list',
  };
}

function draftEqual(a: ConfigDraft, b: ConfigDraft): boolean {
  return a.providerId === b.providerId
    && a.modelId.trim() === b.modelId.trim()
    && (a.effort || '') === (b.effort || '');
}

function AgentInlineConfig({
  agentId,
  agentStatus,
  boundInfo,
  copy,
  layer,
  toast,
  onSaved,
}: {
  agentId: Agent;
  agentStatus: AgentRuntimeStatus;
  boundInfo: BoundProfileInfo | null;
  copy: CopyPack;
  layer: ModelLayerSnapshot;
  toast: (msg: string, ok?: boolean) => void;
  onSaved: () => void | Promise<void>;
}) {
  const externalNative = isNativeConfigExternal(agentId);
  const native = agentStatus.nativeConfig || null;

  const baseline = useMemo(
    () => makeInitialDraft(agentId, agentStatus, boundInfo),
    [agentId, agentStatus, boundInfo],
  );
  const [draft, setDraft] = useState<ConfigDraft>(baseline);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset draft whenever the saved state changes (e.g. after a successful save
  // refreshes the snapshot, or when the user opts into a different binding).
  useEffect(() => { setDraft(baseline); setError(null); }, [baseline]);

  const isNative = draft.providerId === NATIVE_PROVIDER_VALUE;
  const nativeReadOnly = isNative && externalNative;

  // Provider model list (for BYOK) — fetched lazily. We store the rich
  // ProviderModelInfo array so the dropdown can render pricing / context info
  // for providers that surface it (notably OpenRouter).
  const [providerModelInfos, setProviderModelInfos] = useState<ProviderModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    if (isNative) {
      setProviderModelInfos([]);
      setModelsError(null);
      setModelsLoading(false);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    fetch(`/api/models/providers/${draft.providerId}/models`)
      .then(r => r.json())
      .then((j: { ok: boolean; models?: string[]; modelInfos?: ProviderModelInfo[]; error?: string }) => {
        if (cancelled) return;
        if (!j.ok) {
          setModelsError(j.error || 'Failed to load models');
          setProviderModelInfos([]);
        } else if (j.modelInfos && j.modelInfos.length) {
          setProviderModelInfos(j.modelInfos);
        } else {
          // Fallback when the cache pre-dates the rich-info upgrade — synth a
          // minimal info list so the dropdown still works (no pricing / dates).
          setProviderModelInfos((j.models || []).map(id => ({ id })));
        }
      })
      .catch(e => {
        if (cancelled) return;
        setModelsError(e?.message || String(e));
        setProviderModelInfos([]);
      })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [draft.providerId, isNative]);

  const providerModels = useMemo(() => providerModelInfos.map(m => m.id), [providerModelInfos]);

  // Native model list comes from the agent's CLI-detected models.
  const nativeModels = useMemo(() => agentStatus.models.map(m => m.id), [agentStatus]);
  const availableModels = isNative ? nativeModels : providerModels;

  // Auto-flip to custom when no list is available (BYOK only — for native we
  // always use the CLI-detected list as the source of truth and don't expose a
  // custom-input toggle).
  useEffect(() => {
    if (modelsLoading) return;
    if (isNative) {
      if (draft.modelMode === 'custom') setDraft(d => ({ ...d, modelMode: 'list' }));
      return;
    }
    if (availableModels.length === 0 && draft.modelMode === 'list') {
      setDraft(d => ({ ...d, modelMode: 'custom' }));
    }
  }, [availableModels, modelsLoading, draft.modelMode, isNative]);

  const providerOptions = useMemo(() => {
    const nativeLabel = externalNative
      ? `${copy.providerNativeFromAgent}${native?.provider ? ` · ${native.provider}` : ''}`
      : copy.providerNative;
    const opts: { value: string; label: string }[] = [
      { value: NATIVE_PROVIDER_VALUE, label: nativeLabel },
    ];
    for (const p of layer.providers) opts.push({ value: p.id, label: p.name });
    return opts;
  }, [externalNative, native, layer.providers, copy.providerNative, copy.providerNativeFromAgent]);

  const effortOptions = useMemo(() => {
    const levels = EFFORT_OPTIONS[agentId] || EFFORT_OPTIONS['claude'];
    return [
      { value: '', label: copy.effortDefault },
      ...levels.map(v => ({ value: v, label: v })),
    ];
  }, [agentId, copy.effortDefault]);

  const modelOptions = useMemo(() => {
    type RichOpt = { value: string; label: string; description?: string; meta?: string };
    let opts: RichOpt[];
    if (isNative) {
      // Native CLI-detected list. Surface the alias as a description ONLY when
      // it carries information beyond the id — `sonnet` vs `claude-sonnet-4-6`
      // is useful, but `GPT-5.4-Mini` next to `gpt-5.4-mini` is just noise.
      opts = agentStatus.models.map(m => {
        const aliasNormalized = m.alias?.toLowerCase().replace(/[\s_-]/g, '');
        const idNormalized = m.id.toLowerCase().replace(/[\s_-]/g, '');
        const showAlias = m.alias && aliasNormalized !== idNormalized;
        return {
          value: m.id,
          label: m.id,
          description: showAlias ? m.alias! : undefined,
        };
      });
    } else {
      opts = providerModelInfos.map(info => ({
        value: info.id,
        ...buildModelOption(info),
      }));
    }
    if (draft.modelMode === 'list' && draft.modelId && !opts.some(o => o.value === draft.modelId)) {
      opts.unshift({ value: draft.modelId, label: draft.modelId });
    }
    return opts;
  }, [isNative, agentStatus.models, providerModelInfos, draft.modelMode, draft.modelId]);

  const dirty = !draftEqual(draft, baseline);
  const canSave = !submitting && dirty && (nativeReadOnly || !!draft.modelId.trim());

  const submit = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const targetEffort = draft.effort || null;
      const targetModel = draft.modelId.trim();

      if (isNative) {
        // Clear any active Profile + delete the owned Profile so we fall back
        // to native auth. For pikiclaw-managed native agents, persist the
        // model/effort overrides via the runtime config.
        const currentProfileId = layer.bindings[agentId];
        const currentProfile = currentProfileId ? layer.profiles.find(p => p.id === currentProfileId) : null;
        if (currentProfileId) await layer.setActiveProfile(agentId, null);
        if (currentProfile) {
          await fetch(`/api/models/profiles/${currentProfile.id}`, { method: 'DELETE' });
        }
        if (!externalNative) {
          const patch: Record<string, unknown> = { agent: agentId };
          if (targetModel && targetModel !== (agentStatus.selectedModel || '')) patch.model = targetModel;
          if (targetEffort !== (agentStatus.selectedEffort || null)) patch.effort = targetEffort;
          if (Object.keys(patch).length > 1) {
            const res = await api.updateRuntimeAgent(patch);
            if (!res.ok) throw new Error(res.error || 'Failed to update agent');
          }
        }
      } else {
        const provider = layer.providers.find(p => p.id === draft.providerId);
        if (!provider) throw new Error('Provider not found');
        const meta = getAgentMeta(agentId);
        const currentProfileId = layer.bindings[agentId];
        const currentProfile = currentProfileId ? layer.profiles.find(p => p.id === currentProfileId) : null;
        const profileBody = {
          providerId: provider.id,
          modelId: targetModel,
          effort: targetEffort,
          name: `${meta.label} · ${provider.name}`,
        };
        let profileId: string | undefined = currentProfile?.id;
        if (currentProfile) {
          const r = await fetch(`/api/models/profiles/${currentProfile.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profileBody),
          }).then(x => x.json());
          if (!r.ok) throw new Error(r.error || 'Failed to update profile');
        } else {
          const r = await fetch('/api/models/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profileBody),
          }).then(x => x.json());
          if (!r.ok) throw new Error(r.error || 'Failed to create profile');
          profileId = r.profile?.id;
        }
        if (profileId) await layer.setActiveProfile(agentId, profileId);
      }

      await Promise.resolve(onSaved());
      toast(copy.saved);
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(msg);
      toast(`${copy.configError}: ${msg}`, false);
    } finally {
      setSubmitting(false);
    }
  }, [agentId, agentStatus, copy, draft, externalNative, isNative, layer, onSaved, toast]);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {/* Provider */}
        <div>
          <Label className="!mb-1 text-[11px]">{copy.rowProvider}</Label>
          <Select
            value={draft.providerId}
            options={providerOptions}
            onChange={v => setDraft(d => {
              if (v === d.providerId) return d;
              // Switching providers resets the model so the user picks one
              // that exists for the new provider rather than carrying over a
              // stale id (which the new provider may not honour).
              const next: ConfigDraft = { ...d, providerId: v, modelId: '', modelMode: 'list' };
              if (v === NATIVE_PROVIDER_VALUE) {
                next.modelId = defaultNativeModel(agentStatus);
                // Same reasoning as defaultNativeModel: don't carry the BYOK
                // profile's effort into native mode.
                next.effort = agentStatus.nativeSelectedEffort
                  || agentStatus.nativeConfig?.effort
                  || '';
              }
              return next;
            })}
          />
        </div>

        {/* Model */}
        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <Label className="!mb-0 text-[11px]">{copy.rowModel}</Label>
            {/* Custom-input toggle is BYOK-only. Native mode trusts the CLI's
                detected model list so we never expose an unbounded text field
                that would let the user enter an id the CLI cannot run. */}
            {!nativeReadOnly && !isNative && (
              <button
                type="button"
                onClick={() => setDraft(d => ({ ...d, modelMode: d.modelMode === 'list' ? 'custom' : 'list' }))}
                className="text-[10px] text-fg-5 underline-offset-2 transition hover:text-fg-3 hover:underline"
              >
                {draft.modelMode === 'list' ? copy.modelCustomToggle : copy.modelListToggle}
              </button>
            )}
          </div>
          {nativeReadOnly ? (
            <div className="flex h-9 items-center rounded-md border border-control-border bg-control px-3 text-[13px] text-fg-3">
              <span className="truncate font-mono">{native?.model || copy.noModel}</span>
            </div>
          ) : draft.modelMode === 'list' ? (
            modelsLoading && !isNative ? (
              <div className="flex h-9 items-center gap-2 rounded-md border border-control-border bg-control px-3 text-[13px] text-fg-5">
                <Spinner className="h-3.5 w-3.5" />
                {copy.modelLoading}
              </div>
            ) : (
              <ModelSelect
                value={draft.modelId}
                options={modelOptions}
                onChange={v => setDraft(d => ({ ...d, modelId: v }))}
                placeholder={availableModels.length ? '—' : copy.modelEmpty}
                searchPlaceholder={copy.modelSearchPlaceholder}
                noMatchesText={copy.modelSearchEmpty}
                currentLabel={copy.modelCurrentLabel}
              />
            )
          ) : (
            <Input
              value={draft.modelId}
              onChange={e => setDraft(d => ({ ...d, modelId: e.target.value }))}
              placeholder={copy.modelCustomPlaceholder}
            />
          )}
        </div>

        {/* Effort */}
        <div>
          <Label className="!mb-1 text-[11px]">{copy.rowEffort}</Label>
          {nativeReadOnly ? (
            <div className="flex h-9 items-center rounded-md border border-control-border bg-control px-3 text-[13px] text-fg-3">
              <span className="font-mono">{native?.effort || copy.effortDefault}</span>
            </div>
          ) : (
            <Select
              value={draft.effort}
              options={effortOptions}
              onChange={v => setDraft(d => ({ ...d, effort: v }))}
            />
          )}
        </div>
      </div>

      {/* External-native (Hermes) hint when native is selected. */}
      {nativeReadOnly && (
        <div className="text-[11px] leading-relaxed text-fg-5">
          {copy.externalNativeNote(native?.configPath || '')}
        </div>
      )}

      {/* Error / models error */}
      {(error || modelsError) && (
        <div className="rounded-md border border-rose-700/40 bg-rose-900/20 px-3 py-2 text-xs text-rose-200">
          {error || modelsError}
        </div>
      )}

      {/* Save / Reset row — only appears when the draft diverges from saved. */}
      {dirty && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setDraft(baseline)} disabled={submitting}>
            {copy.cancel}
          </Button>
          <Button variant="primary" size="sm" disabled={!canSave} onClick={() => void submit()}>
            {submitting ? copy.saving : copy.saveChanges}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentRow — single agent card
// ---------------------------------------------------------------------------

function AgentRow({
  agent,
  copy,
  t,
  installing,
  onInstall,
  updatingAgent,
  checkingAgent,
  onUpdate,
  onCheckUpdate,
  loading = false,
  layer,
  boundInfo,
  toast,
  onConfigSaved,
}: {
  agent: AgentRuntimeStatus;
  copy: CopyPack;
  t: (key: string) => string;
  installing: boolean;
  onInstall: (agent: AgentRuntimeStatus) => void;
  updatingAgent: boolean;
  checkingAgent: boolean;
  onUpdate: (agent: AgentRuntimeStatus) => void;
  onCheckUpdate: (agent: AgentRuntimeStatus) => void;
  loading?: boolean;
  layer: ModelLayerSnapshot;
  boundInfo: BoundProfileInfo | null;
  toast: (msg: string, ok?: boolean) => void;
  onConfigSaved: () => void | Promise<void>;
}) {
  const meta = getAgentMeta(agent.agent);
  const versionText = agent.version || copy.noVersion;
  const tagline = meta.advantageKey ? t(meta.advantageKey) : '';

  return (
    <div className="glass rounded-md border border-edge px-4 py-3 shadow-[0_1px_0_rgba(255,255,255,0.02),0_4px_12px_rgba(15,23,42,0.05)]">
      {/* Header row — identity + install status + top-right actions. This row
          is stable regardless of install state so the card never reflows. */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-edge bg-panel-alt">
            <BrandIcon brand={agent.agent} size={22} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[15px] font-semibold text-fg">{meta.label}</div>
              {agent.isDefault && <Badge variant="accent">{copy.defaultBadge}</Badge>}
              {loading
                ? <Badge variant="muted"><Spinner className="h-3 w-3" /> {t('status.loading')}</Badge>
                : agent.installed
                  ? <Badge variant="ok">{copy.installed}</Badge>
                  : <Badge variant="warn">{copy.notInstalled}</Badge>}
              {agent.installed && agent.updateAvailable && (
                <Badge variant="warn">{copy.updateAvailable}</Badge>
              )}
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-fg-5">
              {copy.versionLabel}: {versionText}
              {agent.latestVersion && agent.updateAvailable && (
                <span className="ml-1.5 text-amber-400">→ {agent.latestVersion}</span>
              )}
              {agent.latestVersion && !agent.updateAvailable && agent.installed && (
                <span className="ml-1.5 text-emerald-400">✓</span>
              )}
            </div>
          </div>
        </div>

        {/* Top-right actions: install (if missing) or update / check-update (if installed). */}
        <div className={cn('flex shrink-0 flex-col items-end gap-1.5')}>
          {loading && (
            <div className="inline-flex h-7 items-center gap-2 rounded-md border border-edge bg-transparent px-2.5 text-[11px] text-fg-5">
              <Spinner className="h-3 w-3" />
              {t('status.loading')}
            </div>
          )}
          {!loading && !agent.installed && (
            <Button variant="primary" size="sm" disabled={installing} onClick={() => onInstall(agent)}>
              {installing ? copy.installing : copy.install}
            </Button>
          )}
          {!loading && agent.installed && agent.updateAvailable && (
            <Button variant="outline" size="sm" disabled={updatingAgent} onClick={() => onUpdate(agent)}>
              {updatingAgent ? copy.updating : copy.update}
            </Button>
          )}
          {!loading && agent.installed && !agent.updateAvailable && (
            <Button
              variant="ghost"
              size="sm"
              disabled={checkingAgent}
              onClick={() => onCheckUpdate(agent)}
              className="gap-1.5 text-[11px]"
            >
              {checkingAgent
                ? <><Spinner className="h-3 w-3" /> {copy.checking}</>
                : <><span aria-hidden="true">↻</span> {copy.checkUpdate}</>}
            </Button>
          )}
        </div>
      </div>

      {/* Tagline — short factual description of the agent's origin / niche. */}
      {tagline && (
        <div className="mt-2 text-[12px] leading-relaxed text-fg-4">
          {tagline}
        </div>
      )}

      {/* Body row. The contents flip based on install state — config controls
          only appear once the CLI is present. */}
      {!loading && !agent.installed && (
        <div className="mt-3 rounded-md border border-dashed border-edge bg-panel-alt px-3 py-2.5 text-[12px] leading-relaxed text-fg-4">
          {copy.notInstalledHint}
        </div>
      )}
      {!loading && agent.installed && (
        <div className="mt-3 border-t border-edge pt-3">
          <AgentInlineConfig
            agentId={agent.agent}
            agentStatus={agent}
            boundInfo={boundInfo}
            copy={copy}
            layer={layer}
            toast={toast}
            onSaved={onConfigSaved}
          />
        </div>
      )}

      {/* Update status detail (errors / skipped reasons). */}
      {!loading && agent.installed && agent.updateAvailable && agent.updateStatus === 'skipped' && agent.updateDetail && (
        <div className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--th-badge-warn-text)' }}>
          {copy.updateSkipped}: {agent.updateDetail}
        </div>
      )}
      {!loading && agent.installed && agent.updateStatus === 'failed' && agent.updateDetail && (
        <div className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--th-badge-err-text)' }}>
          {copy.updateFailed}: {agent.updateDetail}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Defaults summary (single SummaryField — kept tight)
// ---------------------------------------------------------------------------

function SummaryField({ label, value, hint, loading = false }: {
  label: string; value: string; hint?: string; loading?: boolean;
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

// ---------------------------------------------------------------------------
// Top-level — defaults summary + agent list + Models section + modal
// ---------------------------------------------------------------------------

export function AgentTab() {
  const locale = useStore(s => s.locale);
  const toast = useStore(s => s.toast);
  const storeAgentStatus = useStore(s => s.agentStatus);
  const setStoreAgentStatus = useStore(s => s.setAgentStatus);
  const refreshStoreAgentStatus = useStore(s => s.refreshAgentStatus);
  const t = useMemo(() => createT(locale), [locale]);
  const copy = useMemo(() => getCopy(locale), [locale]);
  const modelLayer = useModelLayer();

  const [snapshot, setSnapshot] = useState<SnapshotState | null>(
    storeAgentStatus ? { defaultAgent: storeAgentStatus.defaultAgent, agents: storeAgentStatus.agents } : null,
  );
  const [loading, setLoading] = useState(!storeAgentStatus);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [installingAgent, setInstallingAgent] = useState<Agent | null>(null);
  const [defaultsModalOpen, setDefaultsModalOpen] = useState(false);
  const [defaultsDraft, setDefaultsDraft] = useState<Agent>('codex');
  const [updatingAgent, setUpdatingAgent] = useState<Agent | null>(null);
  const [checkingAgent, setCheckingAgent] = useState<Agent | null>(null);
  const hasLoaded = useRef(!!storeAgentStatus);

  useEffect(() => {
    if (storeAgentStatus) {
      applySnapshot(setSnapshot, storeAgentStatus);
      if (!hasLoaded.current) { hasLoaded.current = true; setLoading(false); }
    }
  }, [storeAgentStatus]);

  const applyAndSync = useCallback((status: AgentStatusResponse) => {
    applySnapshot(setSnapshot, status);
    setStoreAgentStatus(status);
  }, [setStoreAgentStatus]);

  const refresh = useCallback(async () => {
    if (!hasLoaded.current) setLoading(true);
    try {
      const status = await api.getAgentStatus();
      applyAndSync(status);
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
  }, [applyAndSync, copy.loadFailed, toast]);

  useEffect(() => {
    if (!storeAgentStatus) void refresh();
    else void refreshStoreAgentStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const updateRuntime = useCallback(async (patch: Record<string, unknown>) => {
    setUpdating(true);
    try {
      const result = await api.updateRuntimeAgent(patch);
      if (!result.ok) throw new Error(result.error || t('config.applyFailed'));
      applyAndSync(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : t('config.applyFailed');
      toast(message, false);
      void refresh();
      return null;
    } finally {
      setUpdating(false);
    }
  }, [applyAndSync, refresh, t, toast]);

  useEffect(() => {
    if (!defaultsModalOpen) return;
    setDefaultsDraft(defaultAgent);
  }, [defaultAgent, defaultsModalOpen]);

  const handleSaveDefaults = useCallback(async () => {
    if (defaultsDraft === defaultAgent) {
      setDefaultsModalOpen(false);
      return;
    }
    const result = await updateRuntime({ defaultAgent: defaultsDraft });
    if (!result) return;
    toast(copy.defaultsSaved);
    setDefaultsModalOpen(false);
  }, [copy.defaultsSaved, defaultAgent, defaultsDraft, toast, updateRuntime]);

  const handleInstall = useCallback(async (agent: AgentRuntimeStatus) => {
    if (installingAgent) return;
    setInstallingAgent(agent.agent);
    try {
      const result = await api.installAgent(agent.agent);
      if (!result.ok) throw new Error(result.error || t('config.agentInstallFailed'));
      applyAndSync(result);
      toast(t('config.agentInstalled'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('config.agentInstallFailed');
      toast(message, false);
      void refresh();
    } finally {
      setInstallingAgent(current => (current === agent.agent ? null : current));
    }
  }, [applyAndSync, installingAgent, refresh, t, toast]);

  const handleUpdate = useCallback(async (agent: AgentRuntimeStatus) => {
    if (updatingAgent) return;
    setUpdatingAgent(agent.agent);
    try {
      const result = await api.updateAgent(agent.agent);
      if (!result.ok) throw new Error(result.error || t('config.agentInstallFailed'));
      applyAndSync(result);
      toast(copy.upToDate);
    } catch (err) {
      const message = err instanceof Error ? err.message : copy.updateFailed;
      toast(message, false);
      void refresh();
    } finally {
      setUpdatingAgent(current => (current === agent.agent ? null : current));
    }
  }, [applyAndSync, copy.updateFailed, copy.upToDate, refresh, t, toast, updatingAgent]);

  const handleCheckUpdate = useCallback(async (agent: AgentRuntimeStatus) => {
    if (checkingAgent) return;
    setCheckingAgent(agent.agent);
    try {
      const result = await api.checkAgentUpdate(agent.agent);
      if (!result.ok) throw new Error(result.error || copy.loadFailed);
      applyAndSync(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : copy.loadFailed;
      toast(message, false);
      void refresh();
    } finally {
      setCheckingAgent(current => (current === agent.agent ? null : current));
    }
  }, [applyAndSync, checkingAgent, copy.loadFailed, refresh, toast]);

  const initialLoading = loading && !snapshot;
  const defaultAgentValue = initialLoading
    ? t('status.loading')
    : defaultAgentStatus
      ? getAgentMeta(defaultAgentStatus.agent).label
      : copy.notInstalled;
  const defaultAgentHint = initialLoading
    ? t('status.loading')
    : defaultAgentStatus?.installed ? copy.installed : copy.notInstalled;

  const handleConfigSaved = useCallback(async () => {
    await modelLayer.reload();
    await refresh();
  }, [modelLayer, refresh]);

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

          <SummaryField
            label={copy.defaultAgent}
            value={defaultAgentValue}
            hint={defaultAgentHint}
            loading={initialLoading}
          />
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
              updatingAgent={updatingAgent === agent.agent}
              checkingAgent={checkingAgent === agent.agent}
              onUpdate={handleUpdate}
              onCheckUpdate={handleCheckUpdate}
              layer={modelLayer}
              boundInfo={buildBoundInfo(modelLayer, agent.agent)}
              toast={toast}
              onConfigSaved={handleConfigSaved}
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

      <section className="space-y-3 pt-4">
        <div className="flex items-baseline justify-between border-t border-edge pt-4">
          <div>
            <div className="text-base font-semibold tracking-tight text-fg">{copy.modelsTitle}</div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-fg-4">{copy.modelsHint}</div>
          </div>
        </div>
        <ModelsSection snapshot={modelLayer} />
      </section>

      <section className="space-y-3 pt-4">
        <div className="flex items-baseline justify-between border-t border-edge pt-4">
          <div>
            <div className="text-base font-semibold tracking-tight text-fg">{copy.localTitle}</div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-fg-4">{copy.localHint}</div>
          </div>
        </div>
        <LocalModelsSection onConnected={handleConfigSaved} />
      </section>

      {/* Defaults modal — agent only */}
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
              value={defaultsDraft}
              options={agentOptions}
              onChange={v => setDefaultsDraft(v as Agent)}
              disabled={updating || !canEditDefaults}
              placeholder={copy.notInstalled}
            />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDefaultsModalOpen(false)}>
            {t('modal.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={updating || defaultsDraft === defaultAgent}
            onClick={() => void handleSaveDefaults()}
          >
            {updating ? t('config.validating') : t('modal.save')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export default AgentTab;
