import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import { createT } from '../i18n';
import { api } from '../api';
import { channelBadgeState, channelSummaryText, isChannelValidationPending } from '../channel-status';
import { Badge, Button, Card, Dot, Label, Modal, ModalHeader, SectionLabel, Select, Skeleton, Spinner } from './ui';
import { BrandBadge, BrandIcon } from './BrandIcon';
import { cn, getAgentMeta } from '../utils';
import { formatUsageSummary, usageBadgeText, usageTone } from '../usage';
import type { AgentRuntimeStatus, AgentStatusResponse, BrowserStatusResponse, PermissionStatus } from '../types';

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
  titleHref,
  description,
  status,
  statusVariant,
  loading,
  actionLabel,
  actionDisabled,
  onAction,
  descriptionMono,
  meta,
}: {
  icon: ReactNode;
  title: string;
  titleHref?: string;
  description: ReactNode;
  status?: string;
  statusVariant?: 'ok' | 'warn' | 'err' | 'muted' | 'accent';
  loading?: boolean;
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
          {titleHref ? (
            <a href={titleHref} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-fg-2 hover:text-primary transition-colors">
              {title}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-1 inline-block -mt-0.5 opacity-40"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          ) : (
            <div className="text-sm font-medium text-fg-2">{title}</div>
          )}
          {status && <Badge variant={statusVariant || 'muted'}>{loading && <Spinner />}{status}</Badge>}
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

  const items = loading && agents.length === 0
    ? (['claude', 'codex', 'gemini'] as const).map(id => ({ agent: id, loading: true }))
    : agents.map(agent => ({ agent: agent.agent, loading: false }));

  return (
    <div className="space-y-2">
      {items.map(item => {
        const agent = agents.find(a => a.agent === item.agent);
        const meta = getAgentMeta(item.agent);
        const selected = item.agent === activeAgent;

        return (
          <button
            key={item.agent}
            type="button"
            disabled={item.loading}
            onClick={() => onSelect(item.agent)}
            className={cn(
              'w-full rounded-lg border p-4 text-left transition-[border-color,background,box-shadow,transform] duration-200',
              'focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--th-glow-a)]',
              selected
                ? 'border-edge-h bg-panel-h shadow-[0_12px_28px_rgba(2,6,23,0.12)]'
                : 'border-edge bg-panel-alt hover:border-edge-h hover:bg-panel',
              !item.loading && !agent?.installed && 'border-dashed'
            )}
          >
            <div className="flex items-start gap-3">
              <BrandBadge brand={item.agent} size={40} iconSize={19} className="rounded-lg bg-panel-alt shadow-[0_0_16px_var(--th-glow-a)]" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-medium text-fg-2">{meta.label}</div>
                  {item.loading
                    ? <Spinner className="text-fg-5" />
                    : <Dot variant={agent?.installed ? 'ok' : 'err'} />}
                  {agent?.isDefault && <Badge variant="accent">{t('config.defaultBadge')}</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-5">
                  <span className="font-mono text-fg-4">
                    {item.loading ? t('status.loading') : agent?.version || t('config.notInstalled')}
                  </span>
                  {agent?.installed && <span>{formatUsageSummary(agent.usage, t)}</span>}
                </div>
                <div className="mt-2 text-sm leading-relaxed text-fg-4">{t(meta.advantageKey)}</div>
                {!item.loading && !agent?.installed && agent?.installCommand && (
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
            const loading = !state;
            const badge = loading
              ? { label: t('status.loading'), variant: 'muted' as const }
              : channelBadgeState(row.channel, t);
            const pending = loading || isChannelValidationPending(row.channel);
            const summary = loading ? '' : channelSummaryText(row.channel, t);
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
                    <Badge variant={badge.variant}>
                      {pending && <Spinner />}
                      {badge.label}
                    </Badge>
                  </div>
                  {summary && <div className="truncate text-xs text-fg-5">{summary}</div>}
                </div>
                <Button variant="outline" size="sm" onClick={row.action} disabled={loading}>
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
  const hostApp = state?.hostApp;
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

      <div className="divide-y divide-edge">
        {Object.entries(info).map(([key, item]) => {
          const loading = !state;
          const value = permissions[key] as PermissionStatus | undefined;
          const granted = !!value?.granted;
          const permissionKey = key as PermissionKey;
          const hostHint = !granted && !loading && hostApp
            ? t('perm.hostAppHint').replace('{hostApp}', hostApp)
            : !granted && !loading
              ? t('perm.hostAppHintFallback')
              : undefined;
          const metaParts = [hostHint, !granted && !loading && item.manualHintKey ? t(item.manualHintKey) : undefined].filter(Boolean);
          return (
            <SettingRow
              key={key}
              icon={item.icon}
              title={t(item.labelKey)}
              description={t(item.reasonKey)}
              meta={metaParts.length > 0 ? metaParts.join(' · ') : undefined}
              status={loading ? t('status.loading') : granted ? t('config.authorized') : t('config.pendingAuth')}
              statusVariant={loading ? 'muted' : granted ? 'ok' : 'warn'}
              loading={loading}
              actionLabel={!loading && value?.checkable && !granted
                ? pendingPermission === permissionKey
                  ? t('perm.waiting')
                  : t(item.actionLabelKey)
                : undefined}
              actionDisabled={loading || pendingPermission != null}
              onAction={value?.checkable && !granted ? () => handlePermissionAction(permissionKey) : undefined}
            />
          );
        })}
      </div>
      <PermissionGuideModal
        guide={guide}
        hostApp={state?.hostApp}
        onClose={() => setGuide(null)}
        onRefresh={handleRefreshPermissionState}
      />
    </Card>
  );
}

function BrowserGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="14.5" rx="3" />
      <path d="M3.5 8.5h17" />
      <circle cx="7" cy="6.3" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="9.8" cy="6.3" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12.6" cy="6.3" r="0.8" fill="currentColor" stroke="none" />
      <path d="M8 12.5h8" />
      <path d="M8 15h5.5" />
    </svg>
  );
}

export function Automation({ onOpenBrowserSetup, onOpenDesktopSetup }: { onOpenBrowserSetup: () => void; onOpenDesktopSetup: () => void }) {
  const { state, toast, locale } = useStore();
  const t = createT(locale);
  const [status, setStatus] = useState<BrowserStatusResponse | null>(null);
  const [disabling, setDisabling] = useState(false);

  const refreshBrowser = useCallback(() => {
    api.getBrowser().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => { refreshBrowser(); }, [refreshBrowser, state]);

  const browser = status?.browser;
  const desktopEnabled = status?.desktop.enabled ?? false;
  const desktopRunning = status?.desktop.running ?? false;
  const browserEnabled = browser?.enabled ?? false;

  const desktopStatus = desktopRunning
    ? t('ext.running')
    : desktopEnabled
      ? t('ext.enabled')
      : status?.desktop.installed === false
        ? t('ext.notInstalled')
        : t('ext.disabled');

  const desktopStatusVariant = desktopRunning ? 'ok' as const : desktopEnabled ? 'accent' as const : 'muted' as const;
  const browserStatusLabel = !status
    ? t('status.loading')
    : !browserEnabled
      ? t('ext.disabled')
      : browser?.status === 'ready'
        ? t('ext.browserReady')
        : browser?.chromeInstalled
          ? t('ext.chromeInstalled')
          : t('ext.needsSetup');
  const browserStatusVariant = !status
    ? 'muted' as const
    : !browserEnabled
      ? 'muted' as const
      : browser?.status === 'ready'
        ? 'ok' as const
        : browser?.chromeInstalled
          ? 'warn' as const
          : 'err' as const;

  const handleDesktopDisable = async () => {
    setDisabling(true);
    try {
      const r = await api.desktopToggle(false);
      if (r.ok) {
        toast(t('ext.desktopStopped'));
        refreshBrowser();
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
          icon={<BrowserGlyph />}
          title={t('ext.browser')}
          description={browserEnabled ? t('ext.browserDescEnabled') : t('ext.browserDescDisabled')}
          meta={browser?.profileDir
            ? `${t('ext.profileDir')}: ${browser.profileDir}`
            : t('ext.browserProfileMode')}
          status={browserStatusLabel}
          statusVariant={browserStatusVariant}
          loading={!status}
          actionLabel={t('ext.setup')}
          actionDisabled={!status}
          onAction={onOpenBrowserSetup}
        />
        <SettingRow
          icon={<BrandIcon brand="appium" size={20} />}
          title={t('ext.desktop')}
          titleHref="https://appium.io/"
          description={t('ext.desktopDesc')}
          meta={desktopEnabled && status?.desktop.appiumUrl ? `Appium: ${status.desktop.appiumUrl}` : undefined}
          status={!status ? t('status.loading') : desktopStatus}
          statusVariant={!status ? 'muted' : desktopStatusVariant}
          loading={!status}
          actionLabel={desktopEnabled
            ? (disabling ? t('ext.disabling') : t('ext.disable'))
            : t('ext.setup')}
          actionDisabled={!status || disabling}
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
    if (preserveSelection && prev && snapshot.agents.some(agent => agent.agent === prev)) return prev;
    return snapshot.defaultAgent;
  });
}

function PermissionAlert() {
  const { state, locale } = useStore();
  const t = createT(locale);
  if (!state || state.platform !== 'darwin') return null;
  const perms = state.permissions || {};
  const missing = (['accessibility', 'screenRecording'] as const).filter(k => perms[k] && !perms[k].granted);
  if (missing.length === 0) return null;
  const labels = missing.map(k => t(k === 'accessibility' ? 'perm.accessibility' : 'perm.screenRecording'));
  const hostApp = state.hostApp;
  const scrollToPerms = () => {
    document.getElementById('sys-perms-section')?.scrollIntoView({ behavior: 'smooth' });
  };
  return (
    <button
      type="button"
      onClick={scrollToPerms}
      className="flex w-full items-center gap-3 rounded-lg border border-[color:var(--th-warn-edge,theme(colors.amber.400/0.3))] bg-[color:var(--th-warn-bg,theme(colors.amber.50/0.06))] px-4 py-3 text-left transition-colors hover:bg-[color:var(--th-warn-bg-h,theme(colors.amber.50/0.1))]"
    >
      <MacSymbol>
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </MacSymbol>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg-2">{labels.join('、')} {t('perm.alertMissing')}</div>
        <div className="mt-0.5 text-xs text-fg-4">
          {hostApp
            ? t('perm.alertHostApp').replace('{hostApp}', hostApp)
            : t('perm.alertHostAppFallback')}
        </div>
      </div>
      <span className="shrink-0 text-xs font-medium text-primary">{t('perm.alertAction')}</span>
    </button>
  );
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
  const [installingAgent, setInstallingAgent] = useState<string | null>(null);
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

  const handleInstallAgent = useCallback(async () => {
    if (!activeAgent || activeAgent.installed || installingAgent) return;
    setInstallingAgent(activeAgent.agent);
    try {
      const snapshot = await api.installAgent(activeAgent.agent);
      if (!snapshot.ok) throw new Error(snapshot.error || t('config.agentInstallFailed'));
      applyAgentSnapshot(snapshot, setAgents, setSelectedAgent, true);
      toast(t('config.agentInstalled'));
    } catch (error) {
      toast(error instanceof Error ? error.message : t('config.agentInstallFailed'), false);
      void loadAgentStatus(true);
    } finally {
      setInstallingAgent(current => (current === activeAgent.agent ? null : current));
    }
  }, [activeAgent, installingAgent, loadAgentStatus, t, toast]);

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
      <PermissionAlert />
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
                  {!loadingAgents && activeAgent && (
                    activeAgent.installed ? (
                      !activeAgent.isDefault && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={updatingDefault}
                          onClick={handleDefaultAgentChange}
                        >
                          {t(updatingDefault ? 'config.settingDefault' : 'config.setDefaultAction')}
                        </Button>
                      )
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={installingAgent != null}
                        onClick={handleInstallAgent}
                      >
                        {t(installingAgent === activeAgent.agent ? 'config.installingAgent' : 'config.installAction')}
                      </Button>
                    )
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <Field label={t('config.model')}>
                <Select
                  value={activeAgent?.selectedModel || ''}
                  options={modelOptions}
                  onChange={handleModelChange}
                  disabled={loadingAgents || !activeAgent?.installed || modelOptions.length === 0}
                  placeholder={loadingAgents ? t('status.loading') : t('config.noModel')}
                />
              </Field>

              <Field label={t('config.thinkingMode')}>
                {!loadingAgents && reasoningOptions.length === 0 ? (
                  <div className="flex h-9 items-center rounded-md border border-edge bg-inset px-3 text-sm text-fg-5">
                    {t('config.noReasoningMode')}
                  </div>
                ) : (
                  <Select
                    value={activeAgent?.selectedEffort || reasoningOptions[0]?.value || ''}
                    options={reasoningOptions}
                    onChange={handleEffortChange}
                    disabled={loadingAgents || !activeAgent?.installed}
                    placeholder={loadingAgents ? t('status.loading') : undefined}
                  />
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
              <div className="rounded-lg border border-dashed border-edge bg-panel-alt px-3 py-3">
                <div className="text-sm leading-relaxed text-fg-4">{t('config.installHint')}</div>
                <div className="mt-2 font-mono text-[11px] text-fg-5">{activeAgent.installCommand}</div>
              </div>
            )}
          </Card>
        </div>
      </section>

      <section id="sys-perms-section" className="space-y-4">
        <SectionLabel>{t('config.sysPerms')}</SectionLabel>
        <SystemPermissions />
      </section>
    </div>
  );
}
