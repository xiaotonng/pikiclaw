import type { ChannelSetupState } from './types';

type Translate = (key: string) => string;

export function isChannelValidationPending(channel: ChannelSetupState | null | undefined): boolean {
  return !!channel?.configured && (!channel.validated || channel.status === 'checking');
}

export function hasPendingChannelValidation(channels: ChannelSetupState[] | null | undefined): boolean {
  return Array.isArray(channels) && channels.some(channel => isChannelValidationPending(channel));
}

export function channelSummaryText(channel: ChannelSetupState | null | undefined, t: Translate): string {
  if (!channel || !channel.configured) return t('status.needsConfig');
  if (channel.detail) return channel.detail;
  if (isChannelValidationPending(channel)) return t('config.validating');
  return channel.ready ? t('config.configured') : t('config.validationFailed');
}

export function channelBadgeState(
  channel: ChannelSetupState | null | undefined,
  t: Translate,
): { label: string; variant: 'ok' | 'warn' | 'muted' | 'accent' } {
  if (!channel || !channel.configured) return { label: t('status.needsConfig'), variant: 'muted' };
  if (channel.ready) return { label: t('config.configured'), variant: 'ok' };
  if (isChannelValidationPending(channel)) return { label: t('config.validating'), variant: 'accent' };
  return { label: t('config.validationFailed'), variant: 'warn' };
}
