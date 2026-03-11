import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { createT } from '../i18n';
import { api } from '../api';
import { Badge, Button, Card, Dot, SectionLabel, Select, Skeleton } from './ui';
import type { AgentRuntimeStatus, AgentStatusResponse, ChannelSetupState, PermissionStatus, UsageResult } from '../types';
import { HostCards } from './HostCards';

const agentMeta: Record<string, {
  label: string;
  color: string;
  bg: string;
  letter: string;
  glow: string;
  advantageKey: string;
}> = {
  claude: {
    label: 'Claude Code',
    color: '#818cf8',
    bg: 'rgba(129,140,248,0.08)',
    letter: 'C',
    glow: 'rgba(129,140,248,0.15)',
    advantageKey: 'config.agentAdvantageClaude',
  },
  codex: {
    label: 'Codex',
    color: '#34d399',
    bg: 'rgba(52,211,153,0.08)',
    letter: 'O',
    glow: 'rgba(52,211,153,0.15)',
    advantageKey: 'config.agentAdvantageCodex',
  },
  gemini: {
    label: 'Gemini CLI',
    color: '#a78bfa',
    bg: 'rgba(167,139,250,0.08)',
    letter: 'G',
    glow: 'rgba(167,139,250,0.15)',
    advantageKey: 'config.agentAdvantageGemini',
  },
};

const effortOptions: Record<string, { value: string; labelKey: string }[]> = {
  claude: [
    { value: 'low', labelKey: 'effort.low' },
    { value: 'medium', labelKey: 'effort.medium' },
    { value: 'high', labelKey: 'effort.high' },
  ],
  codex: [
    { value: 'minimal', labelKey: 'effort.minimal' },
    { value: 'low', labelKey: 'effort.low' },
    { value: 'medium', labelKey: 'effort.medium' },
    { value: 'high', labelKey: 'effort.high' },
    { value: 'xhigh', labelKey: 'effort.xhigh' },
  ],
};

function IMCards({ onOpenTelegram, onOpenFeishu }: { onOpenTelegram: () => void; onOpenFeishu: () => void }) {
  const { state, locale } = useStore();
  const t = createT(locale);
  if (!state) return <div className="grid grid-cols-1 md:grid-cols-3 gap-3">{[0, 1, 2].map(i => <Card key={i}><Skeleton className="w-16 mb-2" /><Skeleton className="w-10" /></Card>)}</div>;

  const channels = state.setupState?.channels || [];
  const tgState = channels.find(channel => channel.channel === 'telegram');
  const fsState = channels.find(channel => channel.channel === 'feishu');

  const channelSubtitle = (channel: ChannelSetupState | undefined) => {
    if (!channel || !channel.configured) return t('config.clickConfig');
    return channel.detail || (channel.ready ? t('config.configured') : t('config.validationFailed'));
  };

  const channelDot = (channel: ChannelSetupState | undefined): 'ok' | 'warn' | 'err' => {
    if (!channel || !channel.configured) return 'err';
    if (channel.ready) return 'ok';
    return channel.status === 'error' ? 'warn' : 'err';
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <Card interactive onClick={onOpenTelegram}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center bg-blue-500/10 shadow-[0_0_12px_rgba(59,130,246,0.1)]">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="#60a5fa"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.07-.2c-.08-.06-.19-.04-.27-.02-.12.02-1.96 1.25-5.54 3.67-.52.36-1 .53-1.42.52-.47-.01-1.37-.26-2.03-.48-.82-.27-1.47-.42-1.42-.88.03-.24.37-.49 1.02-.75 3.98-1.73 6.64-2.88 7.97-3.44 3.8-1.58 4.59-1.86 5.1-1.87.11 0 .37.03.54.17.14.12.18.28.2.45 0 .06.01.24 0 .38z" /></svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-fg-2">Telegram</div>
            <div className="text-[11px] text-fg-4 truncate" title={channelSubtitle(tgState)}>{channelSubtitle(tgState)}</div>
          </div>
          <Dot variant={channelDot(tgState)} />
        </div>
      </Card>

      <Card interactive onClick={onOpenFeishu}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center bg-violet-500/10 shadow-[0_0_12px_rgba(139,92,246,0.1)]">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="#a78bfa"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h3v6H8z" fill="var(--th-surface)" /><path d="M13 9h3v6h-3z" fill="var(--th-surface)" /></svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-fg-2">Feishu</div>
            <div className="text-[11px] text-fg-4 truncate" title={channelSubtitle(fsState)}>{channelSubtitle(fsState)}</div>
          </div>
          <Dot variant={channelDot(fsState)} />
        </div>
      </Card>

      <Card className="opacity-30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center bg-emerald-500/10">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-fg-3">WhatsApp</div>
            <div className="text-[11px] text-fg-5">{t('config.comingSoon')}</div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function usageTone(usage: UsageResult | null): 'ok' | 'warn' | 'err' {
  if (!usage?.ok) return 'err';
  if (usage.windows.some(window => window.remainingPercent != null && window.remainingPercent <= 20)) return 'warn';
  if (usage.status === 'limit_reached') return 'err';
  return 'ok';
}

function formatUsageWindow(window: NonNullable<UsageResult['windows']>[number], t: (key: string) => string): string {
  if (window.remainingPercent != null) return `${window.label} ${window.remainingPercent.toFixed(0)}%`;
  if (window.status === 'limit_reached') return `${window.label} ${t('config.limitReached')}`;
  if (window.status === 'warning') return `${window.label} ${t('config.balanceTight')}`;
  if (window.status === 'allowed') return `${window.label} ${t('config.balanceHealthy')}`;
  return window.label;
}

function formatUsageSummary(usage: UsageResult | null, t: (key: string) => string): string {
  if (!usage?.ok) return usage?.error || t('config.balanceUnavailable');
  if (!usage.windows.length) return usage.error || t('config.balanceUnavailable');
  return usage.windows.slice(0, 2).map(window => formatUsageWindow(window, t)).join(' · ');
}

function AgentCards({ agents, loading }: { agents: AgentRuntimeStatus[]; loading: boolean }) {
  const { locale } = useStore();
  const t = createT(locale);
  if (loading) return <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">{[0, 1, 2].map(i => <Card key={i}><Skeleton className="w-20 mb-3" /><Skeleton className="w-24 mb-2" /><Skeleton className="w-full mb-2" /><Skeleton className="w-3/4" /></Card>)}</div>;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
      {agents.map(agent => {
        const meta = agentMeta[agent.agent] || { label: agent.agent, color: '#888', bg: 'rgba(128,128,128,0.08)', letter: '?', glow: 'rgba(128,128,128,0.1)', advantageKey: 'config.balanceUnavailable' };
        const ok = agent.installed && agent.authStatus === 'ready';
        const warn = agent.installed && agent.authStatus !== 'ready';
        return (
          <Card key={agent.agent} glow className="!p-4">
            <div className="flex items-start gap-3 mb-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-[12px] font-bold shrink-0" style={{ background: meta.bg, color: meta.color, boxShadow: `0 0 12px ${meta.glow}` }}>{meta.letter}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <div className="text-[13px] font-medium text-fg-2 truncate">{meta.label}</div>
                  <Dot variant={ok ? 'ok' : agent.installed ? 'warn' : 'err'} />
                  {agent.isDefault && <Badge variant="accent" className="!text-[10px]">{t('config.defaultBadge')}</Badge>}
                </div>
                <div className="text-[11px] text-fg-4 mt-1 truncate">{agent.version || t('config.notInstalled')}</div>
              </div>
            </div>

            <div className="space-y-3 text-[11px]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-fg-5">{t('config.authStatus')}</span>
                <span style={{ color: ok ? 'var(--th-ok)' : warn ? 'var(--th-warn)' : 'var(--th-fg-5)' }}>
                  {ok ? t('config.authenticated') : warn ? t('config.needsLogin') : '—'}
                </span>
              </div>
              {agent.installed && agent.authDetail && (
                <div className="text-[10px] text-fg-5 leading-relaxed" title={agent.authDetail}>{agent.authDetail}</div>
              )}

              <div>
                <div className="text-fg-5 mb-1">{t('config.balance')}</div>
                <div className={`leading-relaxed ${usageTone(agent.usage) === 'err' ? 'text-fg-4' : 'text-fg-2'}`}>{formatUsageSummary(agent.usage, t)}</div>
              </div>

              <div>
                <div className="text-fg-5 mb-1">{t('config.advantage')}</div>
                <div className="text-fg-3 leading-relaxed">{t(meta.advantageKey)}</div>
              </div>

              {agent.selectedModel && (
                <div className="pt-1 border-t border-edge">
                  <div className="text-fg-5 mb-1">{t('config.model')}</div>
                  <div className="font-mono text-[10px] text-fg-3 truncate">{agent.selectedModel}</div>
                </div>
              )}

              {!agent.installed && agent.installCommand && (
                <div className="font-mono text-[10px] text-fg-6">{agent.installCommand}</div>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function PermissionCards() {
  const { state, locale } = useStore();
  const t = createT(locale);
  const permissions = state?.permissions || {};
  if (!state) return <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">{[0, 1, 2].map(i => <Card key={i}><Skeleton className="w-20 mb-2" /><Skeleton className="w-full mb-1" /><Skeleton className="w-24" /></Card>)}</div>;

  const info: Record<string, { labelKey: string; reasonKey: string; pref: string }> = {
    accessibility: { labelKey: 'perm.accessibility', reasonKey: 'perm.accessibilityReason', pref: 'accessibility' },
    screenRecording: { labelKey: 'perm.screenRecording', reasonKey: 'perm.screenRecordingReason', pref: 'screenRecording' },
    fullDiskAccess: { labelKey: 'perm.fullDiskAccess', reasonKey: 'perm.fullDiskAccessReason', pref: 'fullDiskAccess' },
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
      {Object.entries(permissions).map(([key, value]: [string, PermissionStatus]) => {
        const item = info[key] || { labelKey: key, reasonKey: 'config.balanceUnavailable', pref: key };
        return (
          <Card key={key} className="!p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="text-[12px] font-medium text-fg-2">{t(item.labelKey)}</div>
                  <Dot variant={value.granted ? 'ok' : 'err'} />
                </div>
                <div className="text-[11px] text-fg-5 leading-relaxed">{t(item.reasonKey)}</div>
              </div>
              {value.checkable && !value.granted && (
                <Button variant="ghost" size="sm" className="shrink-0 !text-[10px]" onClick={() => api.openPreferences(item.pref)}>
                  {t('perm.settings')}
                </Button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function applyAgentSnapshot(snapshot: AgentStatusResponse, setAgents: (value: AgentRuntimeStatus[]) => void, setSelectedAgent: (value: string | ((prev: string) => string)) => void, setWorkdir: (value: string) => void, preserveSelection: boolean) {
  setAgents(snapshot.agents);
  setWorkdir(snapshot.workdir);
  setSelectedAgent(prev => {
    if (preserveSelection && prev && snapshot.agents.some(agent => agent.agent === prev && agent.installed)) return prev;
    return snapshot.defaultAgent;
  });
}

export function ConfigTab({ onOpenTelegram, onOpenFeishu }: { onOpenTelegram: () => void; onOpenFeishu: () => void }) {
  const { state, toast, locale } = useStore();
  const t = createT(locale);
  const [agents, setAgents] = useState<AgentRuntimeStatus[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [runtimeWorkdir, setRuntimeWorkdir] = useState('');
  const [loadingAgents, setLoadingAgents] = useState(true);

  const loadAgentStatus = useCallback(async (preserveSelection = true) => {
    if (!agents.length) setLoadingAgents(true);
    try {
      const snapshot = await api.getAgentStatus();
      applyAgentSnapshot(snapshot, setAgents, setSelectedAgent, setRuntimeWorkdir, preserveSelection);
    } catch (err) {
      if (!agents.length) toast(err instanceof Error ? err.message : t('config.loadAgentFailed'), false);
    } finally {
      setLoadingAgents(false);
    }
  }, [agents.length, t, toast]);

  useEffect(() => {
    void loadAgentStatus(false);
    const timer = setInterval(() => { void loadAgentStatus(true); }, 30000);
    return () => clearInterval(timer);
  }, [loadAgentStatus]);

  const installedAgents = useMemo(
    () => agents.filter(agent => agent.installed).map(agent => ({ value: agent.agent, label: agentMeta[agent.agent]?.label || agent.agent })),
    [agents]
  );

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
    () => (activeAgent ? (effortOptions[activeAgent.agent] || []).map(option => ({ value: option.value, label: t(option.labelKey) })) : []),
    [activeAgent, t]
  );

  const updateRuntime = useCallback(async (patch: Record<string, unknown>) => {
    try {
      const snapshot = await api.updateRuntimeAgent(patch);
      if (!snapshot.ok) throw new Error(snapshot.error || t('config.applyFailed'));
      applyAgentSnapshot(snapshot, setAgents, setSelectedAgent, setRuntimeWorkdir, true);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('config.applyFailed'), false);
      void loadAgentStatus(true);
    }
  }, [loadAgentStatus, t, toast]);

  const handleAgentChange = (next: string) => {
    if (!next || next === selectedAgent) return;
    setSelectedAgent(next);
    setAgents(prev => prev.map(agent => ({ ...agent, isDefault: agent.agent === next })));
    void updateRuntime({ defaultAgent: next });
  };

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

  const currentWorkdir = runtimeWorkdir || state?.bot?.workdir || state?.runtimeWorkdir || '';

  return (
    <div className="animate-in space-y-8">
      <section>
        <SectionLabel>{t('config.imAccess')}</SectionLabel>
        <IMCards onOpenTelegram={onOpenTelegram} onOpenFeishu={onOpenFeishu} />
      </section>

      <section>
        <SectionLabel>{t('config.aiAgent')}</SectionLabel>
        <AgentCards agents={agents} loading={loadingAgents} />
      </section>

      <section>
        <SectionLabel>{t('config.sysPerms')}</SectionLabel>
        <div className="text-[12px] text-fg-5 mb-3 leading-relaxed">{t('config.permissionHint')}</div>
        <PermissionCards />
      </section>

      <section>
        <SectionLabel>{t('config.hostStatus')}</SectionLabel>
        <HostCards />
      </section>

      <section>
        <SectionLabel>{t('config.general')}</SectionLabel>
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-3">
          <Card className="!p-4">
            <div className="text-[12px] font-medium text-fg-2 mb-1">{t('config.defaultAgent')}</div>
            <div className="text-[11px] text-fg-5 mb-3 leading-relaxed">{t('config.instantApply')}</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <div className="text-[11px] font-medium text-fg-4 mb-2">{t('config.defaultAgent')}</div>
                <Select value={activeAgent?.agent || selectedAgent} options={installedAgents} onChange={handleAgentChange} />
              </div>
              <div>
                <div className="text-[11px] font-medium text-fg-4 mb-2">{t('config.model')}</div>
                <Select value={activeAgent?.selectedModel || ''} options={modelOptions} onChange={handleModelChange} />
              </div>
              <div>
                <div className="text-[11px] font-medium text-fg-4 mb-2">{t('config.thinkingMode')}</div>
                {reasoningOptions.length > 0
                  ? <Select value={activeAgent?.selectedEffort || reasoningOptions[0]?.value || ''} options={reasoningOptions} onChange={handleEffortChange} />
                  : (
                    <div className="h-[38px] px-3.5 rounded-[10px] border border-edge bg-inset flex items-center text-[12px] text-fg-5">
                      {t('config.noReasoningMode')}
                    </div>
                  )
                }
              </div>
            </div>
          </Card>

          <Card className="!p-4">
            <div className="text-[12px] font-medium text-fg-2 mb-2">{t('config.workdir')}</div>
            <div className="font-mono text-[11px] text-fg-3 break-all leading-relaxed min-h-[54px]">{currentWorkdir || '—'}</div>
            <div className="text-[11px] text-fg-5 mt-3 leading-relaxed">{t('config.switchDirHint')}</div>
          </Card>
        </div>
      </section>
    </div>
  );
}
