import { useMemo } from 'react';
import { isChannelValidationPending } from '../../channel-status';
import { type Locale } from '../../i18n';
import { useStore } from '../../store';
import { BrandIcon } from '../../components/BrandIcon';
import type { ChannelSetupState, UserConfig } from '../../types';
import { Badge, Button, Spinner } from '../../components/ui';
import { SettingRowAction, SettingRowCard, SettingRowField, SettingRowLead } from '../shared';

type IMAccessTabProps = {
  onOpenWeixin: () => void;
  onOpenTelegram: () => void;
  onOpenFeishu: () => void;
  onOpenSlack: () => void;
  onOpenDiscord: () => void;
  onOpenDingtalk: () => void;
  onOpenWeCom: () => void;
};

type ChannelKey = 'weixin' | 'telegram' | 'feishu' | 'slack' | 'discord' | 'dingtalk' | 'wecom';

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
  noSlack: string;
  noDiscord: string;
  noDingtalk: string;
  noWeCom: string;
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
      noSlack: '未配置 Bot Token 与 App-Level Token',
      noDiscord: '未配置 Bot Token',
      noDingtalk: '未配置 AppKey/AppSecret',
      noWeCom: '未配置智能机器人 Bot ID 与 Secret',
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
    noSlack: 'Bot Token and App-Level Token not configured',
    noDiscord: 'Bot Token not configured',
    noDingtalk: 'AppKey / AppSecret not configured',
    noWeCom: 'Smart Bot ID and Secret not configured',
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

  if (key === 'feishu') {
    const appId = getConfigValue(config, 'feishuAppId');
    const appSecret = getConfigValue(config, 'feishuAppSecret');
    if (!appId || !appSecret) return copy.noFeishu;
    return `App ID ${maskValue(appId)} · ${copy.appCredentialsSaved}`;
  }

  if (key === 'slack') {
    const bot = getConfigValue(config, 'slackBotToken');
    const app = getConfigValue(config, 'slackAppToken');
    if (!bot || !app) return copy.noSlack;
    return `Bot ${maskValue(bot, 6, 4)} · App ${maskValue(app, 6, 4)}`;
  }

  if (key === 'discord') {
    const token = getConfigValue(config, 'discordBotToken');
    if (!token) return copy.noDiscord;
    return `${copy.tokenSaved} · ${maskValue(token, 6, 4)}`;
  }

  if (key === 'dingtalk') {
    const id = getConfigValue(config, 'dingtalkClientId');
    const secret = getConfigValue(config, 'dingtalkClientSecret');
    if (!id || !secret) return copy.noDingtalk;
    return `AppKey ${maskValue(id, 4, 4)} · ${copy.appCredentialsSaved}`;
  }

  // wecom
  const botId = getConfigValue(config, 'wecomBotId');
  const botSecret = getConfigValue(config, 'wecomBotSecret');
  if (!botId || !botSecret) return copy.noWeCom;
  return `Bot ${maskValue(botId, 4, 4)} · ${copy.appCredentialsSaved}`;
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
        icon={<BrandIcon brand={meta.key} size={32} className="rounded-md" />}
        iconWrap={false}
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

const CHANNEL_DEFS: ReadonlyArray<{
  key: ChannelKey;
  titleZh: string;
  titleEn: string;
  subtitleZh: string;
  subtitleEn: string;
  actionProp: keyof Pick<IMAccessTabProps, 'onOpenWeixin' | 'onOpenTelegram' | 'onOpenFeishu' | 'onOpenSlack' | 'onOpenDiscord' | 'onOpenDingtalk' | 'onOpenWeCom'>;
}> = [
  { key: 'weixin', titleZh: '微信', titleEn: 'Weixin', subtitleZh: '二维码登录与账号接入', subtitleEn: 'QR login and account routing', actionProp: 'onOpenWeixin' },
  { key: 'telegram', titleZh: 'Telegram', titleEn: 'Telegram', subtitleZh: 'Bot Token 与 chat allowlist', subtitleEn: 'Bot token and chat allowlist', actionProp: 'onOpenTelegram' },
  { key: 'feishu', titleZh: '飞书', titleEn: 'Lark / Feishu', subtitleZh: '应用凭证与机器人身份', subtitleEn: 'App credentials and bot identity', actionProp: 'onOpenFeishu' },
  { key: 'slack', titleZh: 'Slack', titleEn: 'Slack', subtitleZh: 'Socket Mode (xoxb / xapp)', subtitleEn: 'Socket Mode (xoxb / xapp)', actionProp: 'onOpenSlack' },
  { key: 'discord', titleZh: 'Discord', titleEn: 'Discord', subtitleZh: 'Gateway 长连接 (需开启 Message Content Intent)', subtitleEn: 'Gateway WebSocket (requires Message Content Intent)', actionProp: 'onOpenDiscord' },
  { key: 'dingtalk', titleZh: '钉钉', titleEn: 'DingTalk', subtitleZh: 'Stream 长连接 (AppKey / AppSecret)', subtitleEn: 'Stream Mode (AppKey / AppSecret)', actionProp: 'onOpenDingtalk' },
  { key: 'wecom', titleZh: '企业微信', titleEn: 'WeCom', subtitleZh: '智能机器人 WebSocket (Bot ID / Secret)', subtitleEn: 'Smart Bot WebSocket (Bot ID / Secret)', actionProp: 'onOpenWeCom' },
];

export function IMAccessTab(props: IMAccessTabProps) {
  const state = useStore(s => s.state);
  const locale = useStore(s => s.locale);
  const copy = getCopy(locale);
  const loading = !state;
  const channels = state?.setupState?.channels || [];
  const config = state?.config || {};

  const rows = useMemo<ChannelRowMeta[]>(() => {
    return CHANNEL_DEFS.map(def => {
      const setup = channels.find(channel => channel.channel === def.key) || null;
      const title = locale === 'zh-CN' ? def.titleZh : def.titleEn;
      const subtitle = locale === 'zh-CN' ? def.subtitleZh : def.subtitleEn;
      const onAction = props[def.actionProp];

      if (loading) {
        return {
          key: def.key,
          title,
          subtitle,
          channel: null,
          loading: true,
          summary: copy.loading,
          summaryLabel: copy.summary,
          statusLabel: copy.loading,
          statusVariant: 'muted',
          statusDescription: copy.loading,
          actionLabel: copy.loading,
          actionDisabled: true,
          onAction,
        };
      }

      return {
        key: def.key,
        title,
        subtitle,
        channel: setup,
        summary: buildChannelSummary(def.key, config, copy),
        summaryLabel: copy.summary,
        ...getStatusPresentation(setup, copy),
        actionDisabled: false,
        onAction,
      };
    });
  }, [channels, config, copy, loading, locale, props]);

  return (
    <div className="animate-in space-y-3">
      {rows.map(row => (
        <ChannelRow key={row.key} meta={row} locale={locale} />
      ))}
    </div>
  );
}
