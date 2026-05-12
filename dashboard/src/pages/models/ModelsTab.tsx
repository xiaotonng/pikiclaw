/**
 * Model Provider Configuration — commercial-grade UI.
 *
 *   Quick Templates (top)         — 5 logo cards: OpenRouter / Anthropic /
 *                                   DeepSeek / Google / Custom. Click → opens
 *                                   the Add modal with kind/baseURL/envVar
 *                                   pre-filled for that provider.
 *   Configured Providers (below)  — clean cards: brand mark, name, status,
 *                                   model + effort, bound-agent chips,
 *                                   inline validate/edit/delete.
 *
 * One row in the UI = one (Provider, Profile) pair under the hood. The user
 * never sees the split. Add modal asks for everything in one form; backend
 * creates Provider then Profile, or PATCHes both.
 *
 * Agent bindings live on the agent cards (see AgentTab.tsx) per option B —
 * here we just render a read-only "bound to" chip strip.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Input, Label, Modal, ModalHeader, Select, Spinner } from '../../components/ui';
import { ActionBar, SectionCard } from '../shared';
import { BrandIcon } from '../../components/BrandIcon';
import { useStore } from '../../store';
import { getAgentMeta } from '../../utils';
import type { Locale } from '../../i18n';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type ProviderKind = 'anthropic' | 'openai' | 'openai-compatible' | 'google';

interface ProviderRow {
  id: string;
  kind: ProviderKind;
  name: string;
  baseURL: string;
  credential: { source: string; summary: string };
  validation: ValidationStatus | null;
  createdAt: string;
  updatedAt: string;
}

interface ValidationStatus {
  state: 'unknown' | 'ready' | 'invalid' | 'error';
  detail: string;
  checkedAt: string;
  modelCount?: number;
}

interface ProfileRow {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  effort?: string | null;
  maxOutputTokens?: number | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

interface ProviderTemplate {
  id: string;             // brand id used by BrandIcon
  kind: ProviderKind;
  name: { zh: string; en: string };
  blurb: { zh: string; en: string };
  baseURL: string;
  envVar: string;
  defaultModel?: string;
}

/**
 * Quick-connect templates. Two rows × 5:
 *   Row 1 — providers that *expand* the user's reach beyond the native agents
 *           (OpenRouter aggregator + 4 leading Chinese model series). For the
 *           pikiclaw audience these are the highest-leverage BYOK paths.
 *   Row 2 — direct API alternatives for providers that already have a native
 *           agent CLI in pikiclaw (Anthropic via Claude Code, Google via
 *           Gemini CLI), plus DeepSeek / OpenAI / Custom.
 */
const TEMPLATES: ProviderTemplate[] = [
  // ── Row 1 ──────────────────────────────────────────────────────────────
  {
    id: 'openrouter',
    kind: 'openai-compatible',
    name: { zh: 'OpenRouter', en: 'OpenRouter' },
    blurb: { zh: '一个 key 通行 300+ 模型', en: 'One key, 300+ models' },
    baseURL: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-4',
  },
  {
    id: 'qwen',
    kind: 'openai-compatible',
    name: { zh: '通义千问 Qwen', en: 'Alibaba Qwen' },
    blurb: { zh: '阿里云 DashScope', en: 'Alibaba DashScope' },
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envVar: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen3-max',
  },
  {
    id: 'doubao',
    kind: 'openai-compatible',
    name: { zh: '豆包 Seed', en: 'Doubao Seed' },
    blurb: { zh: '字节跳动 · 火山方舟', en: 'ByteDance Volcengine Ark' },
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    envVar: 'ARK_API_KEY',
    defaultModel: 'doubao-seed-1-6-250615',
  },
  {
    id: 'glm',
    kind: 'openai-compatible',
    name: { zh: '智谱 GLM', en: 'Zhipu GLM' },
    blurb: { zh: 'GLM-4.6 / Z.AI', en: 'GLM-4.6 / Z.AI' },
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    envVar: 'ZAI_API_KEY',
    defaultModel: 'glm-4.6',
  },
  {
    id: 'minimax',
    kind: 'openai-compatible',
    name: { zh: 'MiniMax', en: 'MiniMax' },
    blurb: { zh: 'M2 / abab', en: 'M2 / abab' },
    baseURL: 'https://api.minimax.chat/v1',
    envVar: 'MINIMAX_API_KEY',
    defaultModel: 'MiniMax-M2',
  },
  // ── Row 2 ──────────────────────────────────────────────────────────────
  {
    id: 'deepseek',
    kind: 'openai-compatible',
    name: { zh: 'DeepSeek', en: 'DeepSeek' },
    blurb: { zh: '深度求索官方 API', en: 'DeepSeek official API' },
    baseURL: 'https://api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'anthropic',
    kind: 'anthropic',
    name: { zh: 'Anthropic 直连', en: 'Anthropic Direct' },
    blurb: { zh: 'Claude 官方 API', en: 'Official Claude API' },
    baseURL: 'https://api.anthropic.com',
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
  },
  {
    id: 'google',
    kind: 'google',
    name: { zh: 'Google AI Studio', en: 'Google AI Studio' },
    blurb: { zh: 'Gemini 官方 API', en: 'Official Gemini API' },
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    envVar: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-pro',
  },
  {
    id: 'openai',
    kind: 'openai',
    name: { zh: 'OpenAI 直连', en: 'OpenAI Direct' },
    blurb: { zh: 'gpt-5 / o-系列', en: 'gpt-5 / o-series' },
    baseURL: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5',
  },
  {
    id: 'custom',
    kind: 'openai-compatible',
    name: { zh: '自定义端点', en: 'Custom' },
    blurb: { zh: '其他 OpenAI 兼容端点', en: 'Other OpenAI-compatible endpoint' },
    baseURL: '',
    envVar: '',
  },
];

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

interface Copy {
  sectionTitle: string;
  sectionHint: string;
  addLabel: string;

  validate: string;
  validating: string;
  edit: string;
  remove: string;
  removeConfirm: string;
  unbound: string;
  modelsAvailable: (count: number) => string;

  modalAddTitle: string;
  modalAddHint: (template: string | null) => string;
  modalEditTitle: string;
  modalEditHint: string;

  fieldName: string;
  fieldNamePlaceholder: string;
  fieldKind: string;
  fieldBaseURL: string;
  fieldCredentialSource: string;
  fieldApiKey: string;
  fieldApiKeyHint: string;
  fieldEnvVar: string;
  fieldCommand: string;
  fieldModelId: string;
  fieldEffort: string;
  fieldEffortHelp: string;
  effortHermesNote: string;

  credPaste: string;
  credEnv: string;
  credCommand: string;
  effortDefault: string;
  cancel: string;
  save: string;
  saving: string;

  validationReady: string;
  validationInvalid: string;
  validationError: string;
  validationUnvalidated: string;
  providerOnlyHint: string;
  credentialLabel: string;
}

function getCopy(locale: Locale): Copy {
  if (locale === 'zh-CN') {
    return {
      sectionTitle: '模型供应商',
      sectionHint: '连接你自己的模型供应商，凭据加密存入系统 Keychain，可绑定到任意一个智能体。',
      addLabel: '接入新供应商',
      validate: '校验',
      validating: '校验中',
      edit: '编辑',
      remove: '删除',
      removeConfirm: '删除该供应商？已绑定的智能体会自动恢复为官方 Auth。',
      unbound: '尚未被任何智能体使用',
      modalAddTitle: '接入模型供应商',
      modalAddHint: tpl => tpl ? `已套用 ${tpl} 模板，仅需粘贴 API Key。` : '填入端点和凭据，保存后即可在智能体卡片上选用。',
      modalEditTitle: '编辑供应商配置',
      modalEditHint: '修改端点、凭据或模型参数。修改凭据会清空已校验状态。',
      fieldName: '配置名称',
      fieldNamePlaceholder: '例如：OpenRouter · 个人',
      fieldKind: 'API 类型',
      fieldBaseURL: 'Base URL',
      fieldCredentialSource: '凭据来源',
      fieldApiKey: 'API Key',
      fieldApiKeyHint: '通过 @napi-rs/keyring 写入系统 Keychain，setting.json 仅保存引用。',
      fieldEnvVar: '环境变量名',
      fieldCommand: '获取命令（执行结果作为 key）',
      fieldModelId: '模型 ID',
      fieldEffort: '推理强度',
      fieldEffortHelp: '可用范围由模型决定，留空表示沿用模型默认值。',
      effortHermesNote: 'Hermes 当前从 ~/.hermes/config.yaml 读取推理强度，Profile 上的 effort 暂仅做记录。',
      credPaste: '粘贴 API Key（推荐，写入系统 Keychain）',
      credEnv: '从环境变量读取',
      credCommand: '运行命令获取（1Password / pass / gh 等）',
      effortDefault: '（沿用默认）',
      cancel: '取消',
      save: '保存',
      saving: '保存中',
      validationReady: '已就绪',
      validationInvalid: '凭据无效',
      validationError: '网络/服务错误',
      validationUnvalidated: '未校验',
      providerOnlyHint: '保存后回到智能体卡片，点击「BYOK」选择具体的模型与推理强度。',
      credentialLabel: '凭据',
      modelsAvailable: count => `可用 ${count} 个模型`,
    };
  }
  return {
    sectionTitle: 'Model Providers',
    sectionHint: 'Connect your own model providers. Keys are encrypted in the OS keychain and can be bound to any agent.',
    addLabel: 'Add provider',
    validate: 'Validate',
    validating: 'Validating',
    edit: 'Edit',
    remove: 'Remove',
    removeConfirm: 'Remove this provider? Bound agents will fall back to native auth.',
    unbound: 'Not used by any agent yet',
    modalAddTitle: 'Connect Model Provider',
    modalAddHint: tpl => tpl ? `Pre-filled from the ${tpl} template — just paste your API key.` : 'Enter endpoint and credential. After saving, choose models on the agent cards above.',
    modalEditTitle: 'Edit Provider',
    modalEditHint: 'Update the endpoint, credential, or model. Changing the credential clears the validated state.',
    fieldName: 'Display name',
    fieldNamePlaceholder: 'e.g. OpenRouter · Personal',
    fieldKind: 'API kind',
    fieldBaseURL: 'Base URL',
    fieldCredentialSource: 'Credential source',
    fieldApiKey: 'API key',
    fieldApiKeyHint: 'Stored in the OS keychain via @napi-rs/keyring; setting.json keeps only a reference.',
    fieldEnvVar: 'Environment variable name',
    fieldCommand: 'Command (stdout becomes the key)',
    fieldModelId: 'Model ID',
    fieldEffort: 'Reasoning effort',
    fieldEffortHelp: 'Available values depend on the chosen model; leave blank to use the default.',
    effortHermesNote: 'Hermes currently reads reasoning_effort from ~/.hermes/config.yaml; Profile.effort is recorded only for now.',
    credPaste: 'Paste API key (recommended — stored in OS keychain)',
    credEnv: 'Read from environment variable',
    credCommand: 'Run a command (1Password / pass / gh, …)',
    effortDefault: '(default)',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving',
    validationReady: 'Ready',
    validationInvalid: 'Invalid',
    validationError: 'Error',
    validationUnvalidated: 'Not validated',
    providerOnlyHint: 'After saving, head back to an agent card and click "BYOK" to choose the model and effort.',
    credentialLabel: 'Credential',
    modelsAvailable: count => `${count} models available`,
  };
}

const KIND_LABEL: Record<ProviderKind, { zh: string; en: string }> = {
  'anthropic': { zh: 'Anthropic 原生', en: 'Anthropic native' },
  'openai': { zh: 'OpenAI 原生', en: 'OpenAI native' },
  'openai-compatible': { zh: 'OpenAI 兼容', en: 'OpenAI-compatible' },
  'google': { zh: 'Google AI Studio', en: 'Google AI Studio' },
};

function kindLabel(kind: ProviderKind, locale: Locale): string {
  return locale === 'zh-CN' ? KIND_LABEL[kind].zh : KIND_LABEL[kind].en;
}

const EFFORT_CHOICES = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

// ---------------------------------------------------------------------------
// Tiny fetch helpers
// ---------------------------------------------------------------------------

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  return r.json() as Promise<T>;
}
async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json() as Promise<T>;
}

// Best-effort brand-id from baseURL host (used to pick a logo for configured cards).
function brandIdForProvider(p: { kind: ProviderKind; baseURL: string }): string {
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

// ---------------------------------------------------------------------------
// Validation status badge
// ---------------------------------------------------------------------------

function ValidationBadge({ v, copy }: { v: ValidationStatus | null; copy: Copy }) {
  if (!v || v.state === 'unknown') return <Badge variant="muted">{copy.validationUnvalidated}</Badge>;
  if (v.state === 'ready') {
    const suffix = v.modelCount ? ` · ${copy.modelsAvailable(v.modelCount)}` : '';
    return <Badge variant="ok">{copy.validationReady}{suffix}</Badge>;
  }
  if (v.state === 'invalid') return <Badge variant="err">{copy.validationInvalid}</Badge>;
  return <Badge variant="warn">{copy.validationError}</Badge>;
}

// ---------------------------------------------------------------------------
// Quick template card
// ---------------------------------------------------------------------------

function TemplateCard({ template, locale, onPick }: {
  template: ProviderTemplate;
  locale: Locale;
  onPick: (t: ProviderTemplate) => void;
}) {
  const name = locale === 'zh-CN' ? template.name.zh : template.name.en;
  const blurb = locale === 'zh-CN' ? template.blurb.zh : template.blurb.en;
  return (
    <button
      type="button"
      onClick={() => onPick(template)}
      className="group relative flex flex-col items-start gap-2 rounded-md border border-edge bg-panel-alt px-3.5 py-3 text-left transition hover:border-edge-strong hover:bg-panel"
    >
      <BrandIcon brand={template.id} size={28} />
      <div className="min-w-0">
        <div className="text-[13px] font-semibold tracking-tight text-fg group-hover:text-fg">{name}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-fg-5 line-clamp-2">{blurb}</div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit modal
// ---------------------------------------------------------------------------

interface ConfigDraft {
  name: string;
  kind: ProviderKind;
  baseURL: string;
  credMode: 'paste' | 'env' | 'command';
  apiKey: string;
  envVar: string;
  cmdLine: string;
}

function draftFromTemplate(tpl: ProviderTemplate, locale: Locale): ConfigDraft {
  return {
    name: locale === 'zh-CN' ? `${tpl.name.zh}` : `${tpl.name.en}`,
    kind: tpl.kind,
    baseURL: tpl.baseURL,
    credMode: 'paste',
    apiKey: '',
    envVar: tpl.envVar || 'API_KEY',
    cmdLine: 'op read op://Personal/Provider/key',
  };
}

function ConfigModal({
  open,
  copy,
  locale,
  initial,
  initialTemplateName,
  existingProvider,
  onClose,
  onSaved,
}: {
  open: boolean;
  copy: Copy;
  locale: Locale;
  initial: ConfigDraft | null;
  initialTemplateName?: string | null;
  existingProvider?: ProviderRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ConfigDraft>(() => initial || draftFromTemplate(TEMPLATES[0], locale));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(initial || draftFromTemplate(TEMPLATES[0], locale));
    setError(null);
  }, [open, initial, locale]);

  const isEdit = !!existingProvider;
  // Lock the API-kind selector when entering via a known template (kind is
  // determined by the template) or when editing (changing kind would
  // invalidate the existing credential). Only the "Custom" template path
  // surfaces a Kind picker, since that's where the user is genuinely
  // declaring a new endpoint shape.
  const kindLocked = !!initialTemplateName || isEdit;

  const submit = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const credentialRef = draft.credMode === 'env'
        ? { source: 'env', varName: draft.envVar.trim() }
        : draft.credMode === 'command'
          ? { source: 'command', argv: draft.cmdLine.trim().split(/\s+/).filter(Boolean) }
          : null;

      // 1) Persist the provider (create or update).
      let providerId: string;
      if (isEdit && existingProvider) {
        const providerPatch: any = {
          name: draft.name.trim() || existingProvider.name,
          baseURL: draft.baseURL.trim(),
        };
        if (draft.credMode === 'paste' && draft.apiKey) providerPatch.apiKey = draft.apiKey;
        else if (credentialRef) providerPatch.credentialRef = credentialRef;
        const provRes = await send<{ ok: boolean; error?: string }>('PATCH', `/api/models/providers/${existingProvider.id}`, providerPatch);
        if (!provRes.ok) { setError(provRes.error || 'Failed to update provider'); return; }
        providerId = existingProvider.id;
      } else {
        const providerBody: any = {
          kind: draft.kind,
          name: draft.name.trim() || `${kindLabel(draft.kind, locale)}`,
          baseURL: draft.baseURL.trim(),
        };
        if (draft.credMode === 'paste') providerBody.apiKey = draft.apiKey;
        else if (credentialRef) providerBody.credentialRef = credentialRef;
        const provRes = await send<{ ok: boolean; provider?: ProviderRow; error?: string }>('POST', '/api/models/providers', providerBody);
        if (!provRes.ok || !provRes.provider) { setError(provRes.error || 'Failed to create provider'); return; }
        providerId = provRes.provider.id;
      }

      // 2) Validate immediately. Only close the modal if the credential is healthy;
      //    otherwise keep the modal open with the provider's failure message inline.
      const valRes = await send<{ ok: boolean; validation?: ValidationStatus; error?: string }>(
        'POST', `/api/models/providers/${providerId}/validate`,
      );
      onSaved();
      if (valRes.validation && valRes.validation.state !== 'ready') {
        setError(`${copy.validationInvalid}: ${valRes.validation.detail}`);
        return;
      }
      onClose();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }, [draft, isEdit, existingProvider, locale, onSaved, onClose, copy.validationInvalid]);

  const canSave = !submitting
    && draft.name.trim().length > 0
    && draft.baseURL.trim().length > 0
    && (draft.credMode !== 'paste' || (isEdit ? true : draft.apiKey.length > 0))
    && (draft.credMode !== 'env' || draft.envVar.trim().length > 0)
    && (draft.credMode !== 'command' || draft.cmdLine.trim().length > 0);

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHeader
        title={isEdit ? copy.modalEditTitle : copy.modalAddTitle}
        description={isEdit ? copy.modalEditHint : copy.modalAddHint(initialTemplateName || null)}
        onClose={onClose}
      />
      <div className="space-y-4">
        <div>
          <Label>{copy.fieldName}</Label>
          <Input
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder={copy.fieldNamePlaceholder}
          />
        </div>
        {/* API kind is fixed for known templates and for edits — only the
            "Custom" template lets the user pick. Hide the select otherwise to
            avoid asking a question with one right answer. */}
        {kindLocked ? (
          <div>
            <Label>{copy.fieldBaseURL}</Label>
            <Input
              value={draft.baseURL}
              onChange={e => setDraft(d => ({ ...d, baseURL: e.target.value }))}
              placeholder="https://…"
            />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{copy.fieldKind}</Label>
              <Select
                value={draft.kind}
                options={(Object.keys(KIND_LABEL) as ProviderKind[]).map(k => ({ value: k, label: kindLabel(k, locale) }))}
                onChange={v => setDraft(d => ({ ...d, kind: v as ProviderKind }))}
              />
            </div>
            <div>
              <Label>{copy.fieldBaseURL}</Label>
              <Input
                value={draft.baseURL}
                onChange={e => setDraft(d => ({ ...d, baseURL: e.target.value }))}
                placeholder="https://…"
              />
            </div>
          </div>
        )}
        <div>
          <Label>{copy.fieldCredentialSource}</Label>
          <Select
            value={draft.credMode}
            options={[
              { value: 'paste', label: copy.credPaste },
              { value: 'env', label: copy.credEnv },
              { value: 'command', label: copy.credCommand },
            ]}
            onChange={v => setDraft(d => ({ ...d, credMode: v as ConfigDraft['credMode'] }))}
          />
        </div>
        {draft.credMode === 'paste' && (
          <div>
            <Label>{copy.fieldApiKey}</Label>
            <Input
              type="password"
              value={draft.apiKey}
              onChange={e => setDraft(d => ({ ...d, apiKey: e.target.value }))}
              placeholder={isEdit ? '••••••••' : 'sk-…'}
            />
            <div className="mt-1 text-[11px] leading-relaxed text-fg-5">{copy.fieldApiKeyHint}</div>
          </div>
        )}
        {draft.credMode === 'env' && (
          <div>
            <Label>{copy.fieldEnvVar}</Label>
            <Input
              value={draft.envVar}
              onChange={e => setDraft(d => ({ ...d, envVar: e.target.value }))}
              placeholder="OPENROUTER_API_KEY"
            />
          </div>
        )}
        {draft.credMode === 'command' && (
          <div>
            <Label>{copy.fieldCommand}</Label>
            <Input
              value={draft.cmdLine}
              onChange={e => setDraft(d => ({ ...d, cmdLine: e.target.value }))}
              placeholder="op read op://Personal/OpenRouter/key"
            />
          </div>
        )}
        {error && (
          <div className="rounded-md border border-rose-700/40 bg-rose-900/20 px-3 py-2 text-xs text-rose-200">{error}</div>
        )}
      </div>
      <div className="mt-6 border-t border-edge pt-4">
        <ActionBar
          primary={{ label: submitting ? copy.saving : copy.save, onClick: submit, disabled: !canSave }}
          secondary={{ label: copy.cancel, onClick: onClose }}
        />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Public hook (shared with AgentTab)
// ---------------------------------------------------------------------------

export interface ModelLayerSnapshot {
  providers: ProviderRow[];
  profiles: ProfileRow[];
  bindings: Record<string, string | null>;
  reload: () => Promise<void>;
  setActiveProfile: (agent: string, profileId: string | null) => Promise<void>;
}

export function useModelLayer(): ModelLayerSnapshot {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [bindings, setBindings] = useState<Record<string, string | null>>({});

  const reload = useCallback(async () => {
    const [p, prof, agents] = await Promise.all([
      get<{ providers: ProviderRow[] }>('/api/models/providers'),
      get<{ profiles: ProfileRow[] }>('/api/models/profiles'),
      get<{ bindings: Array<{ agent: string; activeProfileId: string | null }> }>('/api/models/agents'),
    ]);
    setProviders(p.providers || []);
    setProfiles(prof.profiles || []);
    const map: Record<string, string | null> = {};
    for (const b of agents.bindings || []) map[b.agent] = b.activeProfileId;
    setBindings(map);
  }, []);

  const setActiveProfile = useCallback(async (agent: string, profileId: string | null) => {
    await send('POST', `/api/models/agents/${agent}/active`, { profileId });
    await reload();
  }, [reload]);

  useEffect(() => { void reload(); }, [reload]);

  return { providers, profiles, bindings, reload, setActiveProfile };
}

// ---------------------------------------------------------------------------
// Provider card
// ---------------------------------------------------------------------------

function ProviderCard({
  provider,
  copy,
  boundAgents,
  onEdit,
  onRemove,
}: {
  provider: ProviderRow;
  copy: Copy;
  locale: Locale;
  boundAgents: string[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  const brand = brandIdForProvider(provider);
  return (
    <div className="glass rounded-md border border-edge px-4 py-3 shadow-[0_1px_0_rgba(255,255,255,0.02),0_4px_12px_rgba(15,23,42,0.05)]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-edge bg-panel-alt">
          <BrandIcon brand={brand} size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold tracking-tight text-fg">{provider.name}</span>
            <ValidationBadge v={provider.validation} copy={copy} />
          </div>
          <div className="mt-1 truncate text-[11px] font-mono text-fg-5" title={provider.baseURL}>
            {provider.baseURL}
          </div>
          {provider.validation?.detail && provider.validation.state !== 'ready' && (
            <div className="mt-1 text-[11px] leading-relaxed text-fg-4">{provider.validation.detail}</div>
          )}
          {/* Bound agents — chips when present, otherwise a single muted line. */}
          {boundAgents.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {boundAgents.map(a => {
                const meta = getAgentMeta(a);
                return (
                  <span
                    key={a}
                    className="inline-flex h-5 items-center gap-1 rounded-full border border-edge bg-panel-alt px-2 text-[11px] text-fg-3"
                  >
                    <BrandIcon brand={a} size={11} />
                    <span>{meta.shortLabel}</span>
                  </span>
                );
              })}
            </div>
          ) : (
            <div className="mt-2 text-[11px] text-fg-5">{copy.unbound}</div>
          )}
        </div>
        {/* Inline text-link actions, right-aligned. No standalone validate
            button — validation runs at save-time and the result is already
            communicated by the badge above. */}
        <div className="flex shrink-0 items-center gap-3 self-start text-[12px]">
          <button
            type="button"
            onClick={onEdit}
            className="text-fg-4 transition hover:text-fg-2"
          >
            {copy.edit}
          </button>
          <span className="text-fg-6" aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onRemove}
            className="text-fg-4 transition hover:text-[var(--th-err)]"
          >
            {copy.remove}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export default function ModelsSection({ snapshot }: { snapshot?: ModelLayerSnapshot } = {}) {
  const localState = useModelLayer();
  const layer = snapshot ?? localState;
  const { providers, profiles, bindings, reload } = layer;

  const locale = useStore(s => s.locale);
  const copy = useMemo(() => getCopy(locale), [locale]);
  const toast = useStore(s => s.toast);

  const [modal, setModal] = useState<
    | { kind: 'add'; template: ProviderTemplate }
    | { kind: 'edit'; provider: ProviderRow }
    | null
  >(null);

  // Map provider → list of agent ids that currently have a Profile pointing here.
  // (Profile is now an internal-only artifact: each agent has at most one,
  // owned by the agent's BYOK binding modal.)
  const boundAgentsByProviderId = useMemo(() => {
    const m = new Map<string, string[]>();
    const profById = new Map(profiles.map(p => [p.id, p]));
    for (const [agent, profileId] of Object.entries(bindings)) {
      if (!profileId) continue;
      const prof = profById.get(profileId);
      if (!prof) continue;
      if (!m.has(prof.providerId)) m.set(prof.providerId, []);
      m.get(prof.providerId)!.push(agent);
    }
    return m;
  }, [bindings, profiles]);

  const remove = useCallback(async (provider: ProviderRow) => {
    if (!confirm(copy.removeConfirm)) return;
    await send('DELETE', `/api/models/providers/${provider.id}`);
    await reload();
  }, [copy, reload]);

  const editDraft: ConfigDraft | null = useMemo(() => {
    if (!modal || modal.kind !== 'edit') return null;
    const { provider } = modal;
    return {
      name: provider.name,
      kind: provider.kind,
      baseURL: provider.baseURL,
      credMode: 'paste',
      apiKey: '',
      envVar: TEMPLATES.find(t => t.kind === provider.kind)?.envVar || 'API_KEY',
      cmdLine: 'op read op://Personal/Provider/key',
    };
  }, [modal]);

  const addDraft: ConfigDraft | null = useMemo(() => {
    if (!modal || modal.kind !== 'add') return null;
    return draftFromTemplate(modal.template, locale);
  }, [modal, locale]);

  const addTemplateName = modal && modal.kind === 'add' && modal.template.id !== 'custom'
    ? (locale === 'zh-CN' ? modal.template.name.zh : modal.template.name.en)
    : null;

  // Map each template id → an existing Provider (if any) so a second click on
  // the same template routes to edit instead of creating a duplicate.
  const providerByTemplateId = useMemo(() => {
    const m = new Map<string, ProviderRow>();
    for (const p of providers) {
      const brand = brandIdForProvider(p);
      if (!m.has(brand)) m.set(brand, p);
    }
    return m;
  }, [providers]);

  const pickTemplate = useCallback((tpl: ProviderTemplate) => {
    // "custom" always opens a fresh add — there is no canonical provider to edit.
    if (tpl.id !== 'custom') {
      const existing = providerByTemplateId.get(tpl.id);
      if (existing) {
        setModal({ kind: 'edit', provider: existing });
        return;
      }
    }
    setModal({ kind: 'add', template: tpl });
  }, [providerByTemplateId]);

  // A brand is "taken" when at least one configured Provider matches it; we
  // skip those templates so connected brands don't appear twice (once as a
  // configured card, once as a redundant template tile). "custom" is always
  // surfaced as an add-tile since multiple custom endpoints are common.
  const unconnectedTemplates = useMemo(
    () => TEMPLATES.filter(tpl => tpl.id === 'custom' || !providerByTemplateId.has(tpl.id)),
    [providerByTemplateId],
  );

  return (
    <div className="space-y-3">
      {/* Configured providers — full-width cards, top of the section so users
          see their own state first. */}
      {providers.length > 0 && (
        <div className="space-y-2">
          {providers.map(provider => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              copy={copy}
              locale={locale}
              boundAgents={boundAgentsByProviderId.get(provider.id) || []}
              onEdit={() => setModal({ kind: 'edit', provider })}
              onRemove={() => remove(provider)}
            />
          ))}
        </div>
      )}

      {/* Add-provider grid — only brands the user hasn't connected yet, plus
          the always-available Custom tile. When everything is connected this
          group collapses down to just the Custom tile. */}
      {unconnectedTemplates.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-5">{copy.addLabel}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {unconnectedTemplates.map(tpl => (
              <TemplateCard
                key={tpl.id}
                template={tpl}
                locale={locale}
                onPick={pickTemplate}
              />
            ))}
          </div>
        </div>
      )}

      {modal && (
        <ConfigModal
          open
          copy={copy}
          locale={locale}
          initial={modal.kind === 'edit' ? editDraft : addDraft}
          initialTemplateName={addTemplateName}
          existingProvider={modal.kind === 'edit' ? modal.provider : undefined}
          onClose={() => setModal(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
