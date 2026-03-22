import { useMemo } from 'react';
import { isChannelValidationPending } from '../../channel-status';
import { type Locale } from '../../i18n';
import { useStore } from '../../store';
import { BrandIcon } from '../BrandIcon';
import type { ChannelSetupState, UserConfig } from '../../types';
import { Badge, Button, Spinner } from '../ui';
import { SettingRowAction, SettingRowCard, SettingRowField, SettingRowLead } from './shared';

type IMAccessTabProps = {
  onOpenWeixin: () => void;
  onOpenTelegram: () => void;
  onOpenFeishu: () => void;
};

type ChannelKey = 'weixin' | 'telegram' | 'feishu';

type ChannelRowMeta = {
  key: ChannelKey;
  title: string;
  subtitle: string;
  channel: ChannelSetupState | null;
  loading?: boolean;
  statusLabel: string;
  statusVariant: 'ok' | 'warn' | 'muted' | 'accent';
  statusDescription: string;
  summary: string;
  summaryLabel: string;
  actionLabel: string;
  onAction: () => void;
  actionDisabled?: boolean;
};

type CopyPack = {
  status: string;
  summary: string;
  loading: string;
  chats: string;
  notConnected: string;
  configuring: string;
  connected: string;
  failed: string;
  configure: string;
  continueSetup: string;
  viewSettings: string;
  noWeixin: string;
  noTelegram: string;
  noFeishu: string;
  pendingValidation: string;
  connectedReady: string;
  validationFailed: string;
  accountLinked: string;
  tokenSaved: string;
  appCredentialsSaved: string;
  allowedChats: string;
  notConnectedDetail: string;
};

function getCopy(locale: Locale): CopyPack {
  if (locale === 'zh-CN') {
    return {
      status: '状态',
      summary: '接入摘要',
      loading: '加载中',
      chats: '个 chat',
      notConnected: '未接入',
      configuring: '配置中',
      connected: '已接入',
      failed: '配置异常',
      configure: '去配置',
      continueSetup: '继续配置',
      viewSettings: '查看设置',
      noWeixin: '尚未登录微信账号',
      noTelegram: '未配置 Bot Token',
      noFeishu: '未配置 App ID 与应用凭证',
      pendingValidation: '凭证已保存，等待验证。',
      connectedReady: '机器人已可正常接收消息。',
      validationFailed: '校验失败，请检查凭证或网络。',
      accountLinked: '已绑定账号',
      tokenSaved: 'Token 已保存',
      appCredentialsSaved: '应用凭证已保存',
      allowedChats: '允许',
      notConnectedDetail: '尚未配置账号与接入凭证。',
    };
  }

  return {
    status: 'Status',
    summary: 'Summary',
    loading: 'Loading',
    chats: 'chats',
    notConnected: 'Not connected',
    configuring: 'Configuring',
    connected: 'Connected',
    failed: 'Needs attention',
    configure: 'Configure',
    continueSetup: 'Continue setup',
    viewSettings: 'View settings',
    noWeixin: 'Weixin account not connected yet',
    noTelegram: 'Bot token not configured',
    noFeishu: 'App ID and credentials not configured',
    pendingValidation: 'Credentials are saved and waiting for validation.',
    connectedReady: 'This channel can receive messages.',
    validationFailed: 'Validation failed. Check credentials or network.',
    accountLinked: 'Account linked',
    tokenSaved: 'Token saved',
    appCredentialsSaved: 'Credentials saved',
    allowedChats: 'Allows',
    notConnectedDetail: 'Account and access credentials have not been configured yet.',
  };
}

function maskValue(value: string, keepStart = 4, keepEnd = 4): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= keepStart + keepEnd + 3) return trimmed;
  return `${trimmed.slice(0, keepStart)}...${trimmed.slice(-keepEnd)}`;
}

function countList(raw: string | undefined | null): number {
  return String(raw || '')
    .split(/[\n,;]/)
    .map(item => item.trim())
    .filter(Boolean).length;
}

function getConfigValue(config: Partial<UserConfig> | undefined, key: keyof UserConfig): string {
  return String(config?.[key] || '').trim();
}

function getHostLabel(rawUrl: string, fallback: string): string {
  if (!rawUrl) return fallback;
  try {
    return new URL(rawUrl).host || rawUrl;
  } catch {
    return rawUrl;
  }
}

function buildChannelSummary(key: ChannelKey, config: Partial<UserConfig>, copy: CopyPack): string {
  if (key === 'weixin') {
    const accountId = getConfigValue(config, 'weixinAccountId');
    const baseUrl = getConfigValue(config, 'weixinBaseUrl');
    if (!accountId) return copy.noWeixin;
    return baseUrl
      ? `${maskValue(accountId)} · ${getHostLabel(baseUrl, baseUrl)}`
      : `${copy.accountLinked} ${maskValue(accountId)}`;
  }

  if (key === 'telegram') {
    const token = getConfigValue(config, 'telegramBotToken');
    const chatCount = countList(getConfigValue(config, 'telegramAllowedChatIds'));
    if (!token) return copy.noTelegram;
    return chatCount > 0
      ? `${copy.tokenSaved} · ${copy.allowedChats} ${chatCount} ${copy.chats}`
      : copy.tokenSaved;
  }

  const appId = getConfigValue(config, 'feishuAppId');
  const appSecret = getConfigValue(config, 'feishuAppSecret');
  if (!appId || !appSecret) return copy.noFeishu;
  return `App ID ${maskValue(appId)} · ${copy.appCredentialsSaved}`;
}

function getStatusPresentation(
  channel: ChannelSetupState | null,
  copy: CopyPack,
): Pick<ChannelRowMeta, 'statusLabel' | 'statusVariant' | 'statusDescription' | 'actionLabel'> {
  if (!channel || !channel.configured) {
    return {
      statusLabel: copy.notConnected,
      statusVariant: 'muted',
      statusDescription: channel?.detail || copy.notConnectedDetail,
      actionLabel: copy.configure,
    };
  }

  if (channel.ready) {
    return {
      statusLabel: copy.connected,
      statusVariant: 'ok',
      statusDescription: channel.detail || copy.connectedReady,
      actionLabel: copy.viewSettings,
    };
  }

  if (isChannelValidationPending(channel)) {
    return {
      statusLabel: copy.configuring,
      statusVariant: 'accent',
      statusDescription: channel.detail || copy.pendingValidation,
      actionLabel: copy.continueSetup,
    };
  }

  return {
    statusLabel: copy.failed,
    statusVariant: 'warn',
    statusDescription: channel.detail || copy.validationFailed,
    actionLabel: copy.continueSetup,
  };
}

function ChannelRow({
  meta,
  locale,
}: {
  meta: ChannelRowMeta;
  locale: Locale;
}) {
  const copy = getCopy(locale);

  return (
    <SettingRowCard>
      <SettingRowLead
        icon={<BrandIcon brand={meta.key} size={22} />}
        title={meta.title}
        subtitle={meta.subtitle}
      />

      <SettingRowField label={copy.status}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={meta.statusVariant}>
            {meta.loading && <Spinner className="h-3 w-3" />}
            {meta.statusLabel}
          </Badge>
        </div>
        <div className="mt-1 text-[13px] leading-relaxed text-fg-3 xl:truncate xl:whitespace-nowrap" title={meta.statusDescription}>
          {meta.statusDescription}
        </div>
      </SettingRowField>

      <SettingRowField label={meta.summaryLabel}>
        <div className="break-words text-[13px] leading-relaxed text-fg-3">{meta.summary}</div>
      </SettingRowField>

      <SettingRowAction>
        <Button variant={meta.channel?.ready ? 'outline' : 'primary'} size="sm" onClick={meta.onAction} disabled={meta.actionDisabled}>
          {meta.loading && <Spinner className="h-3 w-3" />}
          {meta.actionLabel}
        </Button>
      </SettingRowAction>
    </SettingRowCard>
  );
}

export function IMAccessTab({
  onOpenWeixin,
  onOpenTelegram,
  onOpenFeishu,
}: IMAccessTabProps) {
  const { state, locale } = useStore();
  const copy = getCopy(locale);
  const loading = !state;
  const channels = state?.setupState?.channels || [];
  const config = state?.config || {};

  const rows = useMemo<ChannelRowMeta[]>(() => {
    const weixin = channels.find(channel => channel.channel === 'weixin') || null;
    const telegram = channels.find(channel => channel.channel === 'telegram') || null;
    const feishu = channels.find(channel => channel.channel === 'feishu') || null;

    if (loading) {
      return [
        {
          key: 'weixin',
          title: 'Weixin',
          subtitle: locale === 'zh-CN' ? '二维码登录与账号接入' : 'QR login and account routing',
          channel: null,
          loading: true,
          summary: copy.loading,
          summaryLabel: copy.summary,
          statusLabel: copy.loading,
          statusVariant: 'muted',
          statusDescription: copy.loading,
          actionLabel: copy.loading,
          actionDisabled: true,
          onAction: onOpenWeixin,
        },
        {
          key: 'telegram',
          title: 'Telegram',
          subtitle: locale === 'zh-CN' ? 'Bot Token 与 chat allowlist' : 'Bot token and chat allowlist',
          channel: null,
          loading: true,
          summary: copy.loading,
          summaryLabel: copy.summary,
          statusLabel: copy.loading,
          statusVariant: 'muted',
          statusDescription: copy.loading,
          actionLabel: copy.loading,
          actionDisabled: true,
          onAction: onOpenTelegram,
        },
        {
          key: 'feishu',
          title: 'Feishu',
          subtitle: locale === 'zh-CN' ? '应用凭证与机器人身份' : 'App credentials and bot identity',
          channel: null,
          loading: true,
          summary: copy.loading,
          summaryLabel: copy.summary,
          statusLabel: copy.loading,
          statusVariant: 'muted',
          statusDescription: copy.loading,
          actionLabel: copy.loading,
          actionDisabled: true,
          onAction: onOpenFeishu,
        },
      ];
    }

    return [
      {
        key: 'weixin',
        title: 'Weixin',
        subtitle: locale === 'zh-CN' ? '二维码登录与账号接入' : 'QR login and account routing',
        channel: weixin,
        summary: buildChannelSummary('weixin', config, copy),
        summaryLabel: copy.summary,
        ...getStatusPresentation(weixin, copy),
        actionDisabled: false,
        onAction: onOpenWeixin,
      },
      {
        key: 'telegram',
        title: 'Telegram',
        subtitle: locale === 'zh-CN' ? 'Bot Token 与 chat allowlist' : 'Bot token and chat allowlist',
        channel: telegram,
        summary: buildChannelSummary('telegram', config, copy),
        summaryLabel: copy.summary,
        ...getStatusPresentation(telegram, copy),
        actionDisabled: false,
        onAction: onOpenTelegram,
      },
      {
        key: 'feishu',
        title: 'Feishu',
        subtitle: locale === 'zh-CN' ? '应用凭证与机器人身份' : 'App credentials and bot identity',
        channel: feishu,
        summary: buildChannelSummary('feishu', config, copy),
        summaryLabel: copy.summary,
        ...getStatusPresentation(feishu, copy),
        actionDisabled: false,
        onAction: onOpenFeishu,
      },
    ];
  }, [channels, config, copy, loading, locale, onOpenFeishu, onOpenTelegram, onOpenWeixin]);

  return (
    <div className="animate-in space-y-3">
      {rows.map(row => (
        <ChannelRow key={row.key} meta={row} locale={locale} />
      ))}
    </div>
  );
}
