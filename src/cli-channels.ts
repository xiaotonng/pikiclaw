import type { ChannelName, UserConfig } from './user-config.js';

export function hasConfiguredChannelToken(
  config: Partial<UserConfig>,
  channel: ChannelName,
  tokenOverride?: string | null,
): boolean {
  switch (channel) {
    case 'telegram':
      return !!(config.telegramBotToken || tokenOverride);
    case 'feishu':
      return !!((config.feishuAppId && config.feishuAppSecret) || tokenOverride);
    case 'weixin':
      return !!(
        config.channels?.includes('weixin')
        && config.weixinBaseUrl
        && config.weixinBotToken
        && config.weixinAccountId
      );
    case 'whatsapp':
      return !!tokenOverride;
  }
}

export function resolveConfiguredChannels(opts: {
  explicitChannels?: string | null;
  config: Partial<UserConfig>;
  tokenOverride?: string | null;
}): ChannelName[] {
  const rawChannels = String(opts.explicitChannels || '').trim();
  if (rawChannels) {
    return rawChannels.split(',').map(channel => channel.trim().toLowerCase()).filter(Boolean) as ChannelName[];
  }
  if (opts.config.channels?.length) {
    return opts.config.channels.filter(channel => hasConfiguredChannelToken(opts.config, channel, opts.tokenOverride));
  }

  const detected: ChannelName[] = [];
  if (hasConfiguredChannelToken(opts.config, 'weixin', opts.tokenOverride)) detected.push('weixin');
  if (hasConfiguredChannelToken(opts.config, 'feishu', opts.tokenOverride)) detected.push('feishu');
  if (hasConfiguredChannelToken(opts.config, 'telegram', opts.tokenOverride)) detected.push('telegram');
  return detected;
}
