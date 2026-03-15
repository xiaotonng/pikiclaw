import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import { createT } from '../i18n';
import { api } from '../api';
import { channelBadgeState, channelSummaryText } from '../channel-status';
import { Badge, Button, Card, Dot, Label, Modal, ModalHeader, SectionLabel, Select, Skeleton } from './ui';
import { BrandBadge, BrandIcon } from './BrandIcon';
import { cn, getAgentMeta } from '../utils';
import { formatUsageSummary, usageBadgeText, usageTone } from '../usage';
import type { AgentRuntimeStatus, AgentStatusResponse, ExtensionStatus, PermissionStatus } from '../types';

const effortOptions: Record<string, string[]> = {
  claude: ['low', 'medium', 'high'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
};

type PermissionKey = 'accessibility' | 'screenRecording' | 'fullDiskAccess';
type PermissionGuideState = { permission: PermissionKey; action: 'prompted' | 'opened_settings' };

function AgentAvatar({ agent }: { agent: string }) {
  return <BrandBadge brand={agent} size={44} iconSize={22} className="rounded-lg bg-panel-alt shadow-[0_0_18px_var(--th-glow-a)]" />;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Label>{label}</Label>
      {hint && <div className="mb-2 text-xs text-fg-5">{hint}</div>}
      {children}
    </div>
  );
}

function MacSymbol({
  children,
  fill = 'none',
}: {
  children: ReactNode;
  fill?: 'none' | 'currentColor';
}) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function SettingRow({
  icon,
  title,
  description,
  status,
  statusVariant,
  actionLabel,
  actionDisabled,
  onAction,
  descriptionMono,
  meta,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  status?: string;
  statusVariant?: 'ok' | 'warn' | 'err' | 'muted' | 'accent';
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void | Promise<void>;
  descriptionMono?: boolean;
  meta?: string;
}) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 md:flex-row md:items-center">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border border-edge bg-[linear-gradient(180deg,var(--color-panel),var(--color-panel-alt))] text-fg-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_1px_2px_rgba(15,23,42,0.05)]">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-medium text-fg-2">{title}</div>
          {status && <Badge variant={statusVariant || 'muted'}>{status}</Badge>}
        </div>
        <div className={cn('mt-1 text-sm leading-relaxed text-fg-4 break-words', descriptionMono && 'font-mono text-[12px] text-fg-3')}>
          {description}
        </div>
        {meta && <div className="mt-2 text-xs text-fg-5">{meta}</div>}
      </div>
      {actionLabel && onAction && (
        <Button
          variant="outline"
          size="sm"
          className="self-start md:self-center"
          disabled={actionDisabled}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

function PermissionGuideModal({
  guide,
  hostApp,
  onClose,
  onRefresh,
}: {
  guide: PermissionGuideState | null;
  hostApp?: string | null;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
}) {
  const { locale } = useStore();
  const t = createT(locale);

  if (!guide) return null;

  const pathKey: Record<PermissionKey, string> = {
    accessibility: 'perm.pathAccessibility',
    screenRecording: 'perm.pathScreenRecording',
    fullDiskAccess: 'perm.pathFullDiskAccess',
  };

  const labelKey: Record<PermissionKey, string> = {
    accessibility: 'perm.accessibility',
    screenRecording: 'perm.screenRecording',
    fullDiskAccess: 'perm.fullDiskAccess',
  };

  const hostAppText = (key: string, fallbackKey: string) =>
    hostApp ? t(key).replace('{hostApp}', hostApp) : t(fallbackKey);

  const toggleOrGrant = guide.permission === 'fullDiskAccess'
    ? hostAppText('perm.guideToggleHostApp', 'perm.guideToggleHostAppFallback')
    : hostAppText('perm.guideGrantHostApp', 'perm.guideGrantHostAppFallback');

  const steps = [
    ...(guide.action === 'prompted' ? [t('perm.guideAllowPrompt')] : []),
    `${t('perm.guideOpenPathPrefix')}${t(pathKey[guide.permission])}`,
    toggleOrGrant,
    ...(guide.permission !== 'accessibility' ? [hostAppText('perm.guideMayNeedRestart', 'perm.guideMayNeedRestartFallback')] : []),
    t('perm.guideBackRefresh'),
  ];

  return (
    <Modal open={!!guide} onClose={onClose}>
      <ModalHeader
        title={`${t(labelKey[guide.permission])} · ${t('perm.guideTitle')}`}
        description={t(guide.action === 'prompted' ? 'perm.guidePromptIntro' : 'perm.guideSettingsIntro')}
        onClose={onClose}
      />
      <div className="space-y-3">
        <ol className="space-y-2 text-sm leading-relaxed text-fg-3">
          {steps.map(step => (
            <li key={step} className="rounded-lg border border-edge bg-panel-alt px-3 py-2">
              {step}
            </li>
          ))}
        </ol>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{t('perm.guideClose')}</Button>
        <Button variant="primary" onClick={onRefresh}>{t('perm.guideRefresh')}</Button>
      </div>
    </Modal>
  );
}

function AgentInventory({
  agents,
  loading,
  activeAgent,
  onSelect,
}: {
  agents: AgentRuntimeStatus[];
  loading: boolean;
  activeAgent: string;
  onSelect: (agent: string) => void;
}) {
  const { locale } = useStore();
  const t = createT(locale);

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map(index => (
          <div key={index} className="rounded-lg border border-edge bg-panel-alt p-4">
            <Skeleton className="mb-3 h-4 w-28" />
            <Skeleton className="mb-2 h-3 w-40" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {agents.map(agent => {
        const meta = getAgentMeta(agent.agent);
        const selected = agent.agent === activeAgent;
        const installState = agent.installed ? 'ok' : 'err';

        return (
          <button
            key={agent.agent}
            type="button"
            disabled={!agent.installed}
            onClick={() => agent.installed && onSelect(agent.agent)}
            className={cn(
              'w-full rounded-lg border p-4 text-left transition-[border-color,background,box-shadow,transform] duration-200',
              'focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--th-glow-a)]',
              selected
                ? 'border-edge-h bg-panel-h shadow-[0_12px_28px_rgba(2,6,23,0.12)]'
                : 'border-edge bg-panel-alt hover:border-edge-h hover:bg-panel',
              !agent.installed && 'cursor-not-allowed opacity-65'
            )}
          >
            <div className="flex items-start gap-3">
              <BrandBadge brand={agent.agent} size={40} iconSize={19} className="rounded-lg bg-panel-alt shadow-[0_0_16px_var(--th-glow-a)]" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-medium text-fg-2">{meta.label}</div>
                  <Dot variant={installState} />
                  {agent.isDefault && <Badge variant="accent">{t('config.defaultBadge')}</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-5">
                  <span className="font-mono text-fg-4">{agent.version || t('config.notInstalled')}</span>
                  {agent.installed && <span>{formatUsageSummary(agent.usage, t)}</span>}
                </div>
                <div className="mt-2 text-sm leading-relaxed text-fg-4">{t(meta.advantageKey)}</div>
                {!agent.installed && agent.installCommand && (
                  <div className="mt-2 font-mono text-[11px] text-fg-5">{agent.installCommand}</div>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function IMChannels({
  onOpenTelegram,
  onOpenFeishu,
}: {
  onOpenTelegram: () => void;
  onOpenFeishu: () => void;
}) {
  const { state, locale } = useStore();
  const t = createT(locale);

  const channels = state?.setupState?.channels || [];
  const tgState = channels.find(channel => channel.channel === 'telegram');
  const fsState = channels.find(channel => channel.channel === 'feishu');

  const rows = [
    {
      key: 'telegram',
      title: 'Telegram',
      icon: <BrandIcon brand="telegram" size={20} />,
      channel: tgState,
      action: onOpenTelegram,
    },
    {
      key: 'feishu',
      title: 'Feishu',
      icon: <BrandIcon brand="feishu" size={20} />,
      channel: fsState,
      action: onOpenFeishu,
    },
  ];

  return (
    <Card className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <Badge variant="muted">{t('config.imAccess')}</Badge>
          <div className="text-sm leading-relaxed text-fg-4">{t('config.channelHint')}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {rows.map(row => {
            const badge = channelBadgeState(row.channel, t);
            return (
              <div
                key={row.key}
                className="flex min-w-[260px] flex-1 items-center gap-3 rounded-lg border border-edge bg-panel-alt px-3 py-2.5"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge bg-panel">
                  {row.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-medium text-fg-2">{row.title}</div>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                  <div className="truncate text-xs text-fg-5">{channelSummaryText(row.channel, t)}</div>
                </div>
                <Button variant="outline" size="sm" onClick={row.action}>
                  {row.channel?.configured ? t('perm.settings') : t('config.configure')}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function SystemPermissions() {
  const { state, locale, reload, toast } = useStore();
  const t = createT(locale);
  const permissions = state?.permissions || {};
  const [pendingPermission, setPendingPermission] = useState<PermissionKey | null>(null);
  const [guide, setGuide] = useState<PermissionGuideState | null>(null);

  const info: Record<PermissionKey, { labelKey: string; reasonKey: string; actionLabelKey: string; manualHintKey?: string; icon: ReactNode }> = {
    accessibility: {
      labelKey: 'perm.accessibility',
      reasonKey: 'perm.accessibilityReason',
      actionLabelKey: 'perm.authorize',
      icon: (
        <MacSymbol>
          <circle cx="12" cy="5" r="1.8" />
          <path d="M12 7.7v10.2" />
          <path d="M8.4 10h7.2" />
          <path d="M9.6 19.2 12 15.1l2.4 4.1" />
        </MacSymbol>
      ),
    },
    screenRecording: {
      labelKey: 'perm.screenRecording',
      reasonKey: 'perm.screenRecordingReason',
      actionLabelKey: 'perm.authorize',
      icon: (
        <MacSymbol>
          <rect x="4" y="5.5" width="11.5" height="10" rx="2.4" />
          <path d="m17.5 8.4 2.7-1.5v7.2l-2.7-1.5" />
          <circle cx="9.75" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
        </MacSymbol>
      ),
    },
    fullDiskAccess: {
      labelKey: 'perm.fullDiskAccess',
      reasonKey: 'perm.fullDiskAccessReason',
      actionLabelKey: 'perm.settings',
      manualHintKey: 'perm.fullDiskAccessManualHint',
      icon: (
        <MacSymbol>
          <rect x="6.2" y="10.1" width="11.6" height="8.6" rx="2.6" />
          <path d="M9 10V7.8a3 3 0 1 1 6 0V10" />
          <circle cx="12" cy="13.5" r="0.9" fill="currentColor" stroke="none" />
          <path d="M12 14.6v1.8" />
        </MacSymbol>
      ),
    },
  };

  const handlePermissionAction = useCallback(async (permission: PermissionKey) => {
    if (pendingPermission) return;
    setPendingPermission(permission);
    try {
      const result = await api.requestPermission(permission);
      if (!result.ok) {
        toast(result.error || t('perm.requestFailed'), false);
        return;
      }

      if (result.action === 'already_granted') {
        toast(t('perm.alreadyGranted'));
        await reload();
        return;
      }

      toast(
        result.action === 'prompted'
          ? t('perm.promptOpened')
          : permission === 'fullDiskAccess'
            ? t('perm.settingsOpenedManual')
            : t('perm.settingsOpened')
      );
      setGuide({
        permission,
        action: result.action === 'prompted' ? 'prompted' : 'opened_settings',
      });
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : t('perm.requestFailed'), false);
    } finally {
      setPendingPermission(current => (current === permission ? null : current));
    }
  }, [pendingPermission, reload, t, toast]);

  const handleRefreshPermissionState = useCallback(async () => {
    if (!guide) return;
    const permission = guide.permission;
    const nextState = await reload();
    if (nextState?.permissions?.[permission]?.granted) toast(t('perm.grantedNow'));
    else toast(t('perm.stillPending'), false);
    setGuide(null);
  }, [guide, reload, t, toast]);

  return (
    <Card>
      <div className="mb-4 text-sm leading-relaxed text-fg-4">{t('config.permissionHint')}</div>

      {!state ? (
        <div className="space-y-2">
          {[0, 1, 2].map(index => <Skeleton key={index} className="h-16 rounded-lg" />)}
        </div>
      ) : (
        <div className="divide-y divide-edge">
          {Object.entries(info).map(([key, item]) => {
            const value = permissions[key] as PermissionStatus | undefined;
            const granted = !!value?.granted;
            const permissionKey = key as PermissionKey;
            return (
              <SettingRow
                key={key}
                icon={item.icon}
                title={t(item.labelKey)}
                description={t(item.reasonKey)}
                meta={!granted && item.manualHintKey ? t(item.manualHintKey) : undefined}
                status={granted ? t('config.authorized') : t('config.pendingAuth')}
                statusVariant={granted ? 'ok' : 'warn'}
                actionLabel={value?.checkable && !granted
                  ? pendingPermission === permissionKey
                    ? t('perm.waiting')
                    : t(item.actionLabelKey)
                  : undefined}
                actionDisabled={pendingPermission != null}
                onAction={value?.checkable && !granted ? () => handlePermissionAction(permissionKey) : undefined}
              />
            );
          })}
        </div>
      )}
      <PermissionGuideModal
        guide={guide}
        hostApp={state?.hostApp}
        onClose={() => setGuide(null)}
        onRefresh={handleRefreshPermissionState}
      />
    </Card>
  );
}

export function Extensions({ onOpenPlaywrightSetup, onOpenDesktopSetup }: { onOpenPlaywrightSetup: () => void; onOpenDesktopSetup: () => void }) {
  const { toast, locale } = useStore();
  const t = createT(locale);
  const [ext, setExt] = useState<ExtensionStatus | null>(null);
  const [disabling, setDisabling] = useState(false);

  const refreshExt = useCallback(() => {
    api.getExtensions().then(setExt).catch(() => {});
  }, []);

  useEffect(() => { refreshExt(); }, [refreshExt]);

  const browserIcon = (
    <MacSymbol>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </MacSymbol>
  );

  const desktopIcon = (
    <MacSymbol>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <path d="M7 9h3" />
      <path d="M7 12h5" />
    </MacSymbol>
  );

  const browserHasToken = ext?.browser.hasToken ?? false;
  const desktopEnabled = ext?.desktop.enabled ?? false;
  const desktopRunning = ext?.desktop.running ?? false;

  const desktopStatus = desktopRunning
    ? t('ext.running')
    : desktopEnabled
      ? t('ext.enabled')
      : ext?.desktop.installed === false
        ? t('ext.notInstalled')
        : t('ext.disabled');

  const desktopStatusVariant = desktopRunning ? 'ok' as const : desktopEnabled ? 'accent' as const : 'muted' as const;

  const handleDesktopDisable = async () => {
    setDisabling(true);
    try {
      const r = await api.desktopToggle(false);
      if (r.ok) {
        toast(t('ext.desktopStopped'));
        refreshExt();
      } else {
        toast(r.error || t('ext.desktopInstallFailed'), false);
      }
    } catch {
      toast(t('ext.desktopInstallFailed'), false);
    } finally {
      setDisabling(false);
    }
  };

  return (
    <Card>
      <div className="mb-4 text-sm leading-relaxed text-fg-4">{t('ext.hint')}</div>
      <div className="divide-y divide-edge">
        <SettingRow
          icon={browserIcon}
          title={t('ext.browser')}
          description={t('ext.browserDesc')}
          meta={t('ext.browserExtMode')}
          status={browserHasToken ? t('ext.tokenSet') : t('ext.tokenMissing')}
          statusVariant={browserHasToken ? 'ok' : 'warn'}
          actionLabel={t('ext.setup')}
          onAction={onOpenPlaywrightSetup}
        />
        <SettingRow
          icon={desktopIcon}
          title={t('ext.desktop')}
          description={t('ext.desktopDesc')}
          meta={desktopEnabled && ext?.desktop.appiumUrl ? `Appium: ${ext.desktop.appiumUrl}` : undefined}
          status={desktopStatus}
          statusVariant={desktopStatusVariant}
          actionLabel={desktopEnabled
            ? (disabling ? t('ext.disabling') : t('ext.disable'))
            : t('ext.setup')}
          actionDisabled={disabling}
          onAction={desktopEnabled ? handleDesktopDisable : onOpenDesktopSetup}
        />
      </div>
    </Card>
  );
}

function applyAgentSnapshot(
  snapshot: AgentStatusResponse,
  setAgents: (value: AgentRuntimeStatus[]) => void,
  setSelectedAgent: (value: string | ((prev: string) => string)) => void,
  preserveSelection: boolean,
) {
  setAgents(snapshot.agents);
  setSelectedAgent(prev => {
    if (preserveSelection && prev && snapshot.agents.some(agent => agent.agent === prev && agent.installed)) return prev;
    return snapshot.defaultAgent;
  });
}

export function ConfigTab({
  onOpenTelegram,
  onOpenFeishu,
}: {
  onOpenTelegram: () => void;
  onOpenFeishu: () => void;
}) {
  const { toast, locale } = useStore();
  const t = createT(locale);
  const [agents, setAgents] = useState<AgentRuntimeStatus[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [updatingDefault, setUpdatingDefault] = useState(false);
  const hasAgents = useRef(false);

  const loadAgentStatus = useCallback(async (preserveSelection = true) => {
    if (!hasAgents.current) setLoadingAgents(true);
    try {
      const snapshot = await api.getAgentStatus();
      applyAgentSnapshot(snapshot, setAgents, setSelectedAgent, preserveSelection);
      hasAgents.current = snapshot.agents.length > 0;
    } catch (error) {
      if (!hasAgents.current) toast(error instanceof Error ? error.message : t('config.loadAgentFailed'), false);
    } finally {
      setLoadingAgents(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void loadAgentStatus(false);
  }, [loadAgentStatus]);

  const activeAgent = useMemo(
    () => agents.find(agent => agent.agent === selectedAgent) || agents.find(agent => agent.isDefault) || agents.find(agent => agent.installed) || null,
    [agents, selectedAgent]
  );

  const modelOptions = useMemo(() => {
    if (!activeAgent) return [];
    const options = activeAgent.models.map(model => ({
      value: model.id,
      label: model.alias ? `${model.alias} · ${model.id}` : model.id,
    }));
    if (activeAgent.selectedModel && !options.some(option => option.value === activeAgent.selectedModel)) {
      options.unshift({ value: activeAgent.selectedModel, label: activeAgent.selectedModel });
    }
    return options;
  }, [activeAgent]);

  const reasoningOptions = useMemo(
    () => (activeAgent ? (effortOptions[activeAgent.agent] || []).map(value => ({ value, label: value })) : []),
    [activeAgent]
  );

  const updateRuntime = useCallback(async (patch: Record<string, unknown>) => {
    try {
      const snapshot = await api.updateRuntimeAgent(patch);
      if (!snapshot.ok) throw new Error(snapshot.error || t('config.applyFailed'));
      applyAgentSnapshot(snapshot, setAgents, setSelectedAgent, true);
    } catch (error) {
      toast(error instanceof Error ? error.message : t('config.applyFailed'), false);
      void loadAgentStatus(true);
    }
  }, [loadAgentStatus, t, toast]);

  const handleAgentChange = (next: string) => {
    if (!next || next === selectedAgent) return;
    setSelectedAgent(next);
  };

  const handleDefaultAgentChange = useCallback(async () => {
    if (!activeAgent || !activeAgent.installed || activeAgent.isDefault || updatingDefault) return;
    const nextDefault = activeAgent.agent;
    setUpdatingDefault(true);
    setAgents(prev => prev.map(agent => ({ ...agent, isDefault: agent.agent === nextDefault })));
    try {
      await updateRuntime({ defaultAgent: nextDefault });
    } finally {
      setUpdatingDefault(false);
    }
  }, [activeAgent, updateRuntime, updatingDefault]);

  const handleModelChange = (next: string) => {
    if (!activeAgent || !next || next === activeAgent.selectedModel) return;
    setAgents(prev => prev.map(agent => agent.agent === activeAgent.agent ? { ...agent, selectedModel: next } : agent));
    void updateRuntime({ agent: activeAgent.agent, model: next });
  };

  const handleEffortChange = (next: string) => {
    if (!activeAgent || !next || next === activeAgent.selectedEffort) return;
    setAgents(prev => prev.map(agent => agent.agent === activeAgent.agent ? { ...agent, selectedEffort: next } : agent));
    void updateRuntime({ agent: activeAgent.agent, effort: next });
  };

  const activeMeta = getAgentMeta(activeAgent?.agent || selectedAgent || 'claude');
  const usageVariant = activeAgent ? usageTone(activeAgent.usage) : 'muted';
  const usageBadge = activeAgent ? usageBadgeText(activeAgent.usage) : 'unavailable';

  return (
    <div className="animate-in space-y-8">
      <IMChannels onOpenTelegram={onOpenTelegram} onOpenFeishu={onOpenFeishu} />

      <section className="space-y-4">
        <SectionLabel>{t('config.aiAgent')}</SectionLabel>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.95fr)]">
          <Card className="space-y-4">
            <div>
              <div className="text-base font-semibold tracking-tight text-fg">{t('config.runtimeTitle')}</div>
              <div className="mt-1 text-sm leading-relaxed text-fg-4">{t('config.runtimeSubtitle')}</div>
            </div>

            <AgentInventory
              agents={agents}
              loading={loadingAgents}
              activeAgent={activeAgent?.agent || selectedAgent}
              onSelect={handleAgentChange}
            />
          </Card>

          <Card className="space-y-5">
            <div className="flex items-start gap-3">
              <AgentAvatar agent={activeAgent?.agent || selectedAgent || 'claude'} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-base font-semibold tracking-tight text-fg">
                        {activeAgent ? activeMeta.label : t('config.notInstalled')}
                      </div>
                      {activeAgent?.isDefault && <Badge variant="accent">{t('config.defaultBadge')}</Badge>}
                    </div>
                    <div className="mt-1 text-sm text-fg-4">
                      {activeAgent?.version || t('config.notInstalled')}
                    </div>
                  </div>
                  {!loadingAgents && activeAgent && activeAgent.installed && !activeAgent.isDefault && (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={updatingDefault}
                      onClick={handleDefaultAgentChange}
                    >
                      {t(updatingDefault ? 'config.settingDefault' : 'config.setDefaultAction')}
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <Field label={t('config.model')}>
                {loadingAgents ? (
                  <Skeleton className="h-9 rounded-md" />
                ) : (
                  <Select
                    value={activeAgent?.selectedModel || ''}
                    options={modelOptions}
                    onChange={handleModelChange}
                    disabled={!activeAgent?.installed || modelOptions.length === 0}
                    placeholder={t('config.noModel')}
                  />
                )}
              </Field>

              <Field label={t('config.thinkingMode')}>
                {loadingAgents ? (
                  <Skeleton className="h-9 rounded-md" />
                ) : reasoningOptions.length > 0 ? (
                  <Select
                    value={activeAgent?.selectedEffort || reasoningOptions[0]?.value || ''}
                    options={reasoningOptions}
                    onChange={handleEffortChange}
                    disabled={!activeAgent?.installed}
                  />
                ) : (
                  <div className="flex h-9 items-center rounded-md border border-edge bg-inset px-3 text-sm text-fg-5">
                    {t('config.noReasoningMode')}
                  </div>
                )}
              </Field>
            </div>

            <div className="rounded-lg border border-edge bg-inset p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-fg-5">{t('config.balance')}</div>
                <Badge variant={usageVariant === 'ok' ? 'ok' : usageVariant === 'warn' ? 'warn' : usageVariant === 'err' ? 'err' : 'muted'}>
                  {usageBadge}
                </Badge>
              </div>
              <div className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-fg-3">
                <Dot variant={usageVariant === 'ok' ? 'ok' : usageVariant === 'warn' ? 'warn' : usageVariant === 'err' ? 'err' : 'idle'} />
                <span>{formatUsageSummary(activeAgent?.usage || null, t)}</span>
              </div>
              <div className="mt-4 border-t border-edge pt-4 text-sm leading-relaxed text-fg-4">
                {t(activeMeta.advantageKey)}
              </div>
            </div>

            {!activeAgent?.installed && activeAgent?.installCommand && (
              <div className="rounded-lg border border-dashed border-edge bg-panel-alt px-3 py-2 font-mono text-[11px] text-fg-5">
                {activeAgent.installCommand}
              </div>
            )}
          </Card>
        </div>
      </section>

      <section className="space-y-4">
        <SectionLabel>{t('config.sysPerms')}</SectionLabel>
        <SystemPermissions />
      </section>
    </div>
  );
}
