import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { createT } from '../../i18n';
import { useStore } from '../../store';
import { Badge, Button } from '../ui';
import { SettingRowAction, SettingRowCard, SettingRowField, SettingRowLead } from './shared';

type PermissionKey = 'accessibility' | 'screenRecording' | 'fullDiskAccess';

type PermissionMeta = {
  key: PermissionKey;
  labelKey: string;
  reasonZh: string;
  reasonEn: string;
  guidePathKey: string;
  icon: ReactNode;
};

type CopyPack = {
  introWithHost: string;
  intro: string;
  status: string;
  summary: string;
  loading: string;
  needsGrant: string;
  granted: string;
  authorize: string;
  openSettings: string;
  refreshState: string;
  checking: string;
  hostGranted: string;
  hostGrantedFallback: string;
  needsGrantDetail: string;
  needsSettingsDetail: string;
};

const PERMISSIONS: PermissionMeta[] = [
  {
    key: 'accessibility',
    labelKey: 'perm.accessibility',
    reasonZh: '允许控制桌面应用、点击和输入。',
    reasonEn: 'Allows controlling desktop apps with clicks and typing.',
    guidePathKey: 'perm.pathAccessibility',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="5" r="1.8" />
        <path d="M12 7.7v10.2" />
        <path d="M8.4 10h7.2" />
        <path d="M9.6 19.2 12 15.1l2.4 4.1" />
      </svg>
    ),
  },
  {
    key: 'screenRecording',
    labelKey: 'perm.screenRecording',
    reasonZh: '允许读取屏幕内容，用于截图和界面分析。',
    reasonEn: 'Allows reading the screen for screenshots and UI inspection.',
    guidePathKey: 'perm.pathScreenRecording',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="5.5" width="11.5" height="10" rx="2.4" />
        <path d="m17.5 8.4 2.7-1.5v7.2l-2.7-1.5" />
        <circle cx="9.75" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    key: 'fullDiskAccess',
    labelKey: 'perm.fullDiskAccess',
    reasonZh: '允许访问桌面、下载等受保护目录。',
    reasonEn: 'Allows access to protected folders like Desktop and Downloads.',
    guidePathKey: 'perm.pathFullDiskAccess',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="6.2" y="10.1" width="11.6" height="8.6" rx="2.6" />
        <path d="M9 10V7.8a3 3 0 1 1 6 0V10" />
        <circle cx="12" cy="13.5" r="0.9" fill="currentColor" stroke="none" />
        <path d="M12 14.6v1.8" />
      </svg>
    ),
  },
];

function getCopy(locale: 'zh-CN' | 'en'): CopyPack {
  if (locale === 'zh-CN') {
    return {
      introWithHost: '请在 macOS 中为 {hostApp} 开启以下权限。',
      intro: '请在 macOS 中开启以下权限。',
      status: '状态',
      summary: '系统位置',
      loading: '检查中',
      needsGrant: '需要授权',
      granted: '已授权',
      authorize: '授权',
      openSettings: '前往设置',
      refreshState: '刷新状态',
      checking: '检查中...',
      hostGranted: '{hostApp} 已可直接使用此权限。',
      hostGrantedFallback: '当前宿主应用已可直接使用此权限。',
      needsGrantDetail: '尚未授权，可通过右侧按钮发起系统授权。',
      needsSettingsDetail: '需要在系统设置中手动开启此权限。',
    };
  }

  return {
    introWithHost: 'Grant the following permissions to {hostApp} in macOS.',
    intro: 'Grant the following permissions in macOS.',
    status: 'Status',
    summary: 'System path',
    loading: 'Checking',
    needsGrant: 'Needs access',
    granted: 'Granted',
    authorize: 'Authorize',
    openSettings: 'Open settings',
    refreshState: 'Refresh status',
    checking: 'Checking...',
    hostGranted: '{hostApp} can use this permission now.',
    hostGrantedFallback: 'The current host app can use this permission now.',
    needsGrantDetail: 'Access has not been granted yet. Use the button on the right to trigger the macOS prompt.',
    needsSettingsDetail: 'This permission needs to be enabled manually in System Settings.',
  };
}

export function PermissionsTab() {
  const { state, locale, reload, toast } = useStore();
  const t = createT(locale);
  const copy = getCopy(locale);
  const permissions = state?.permissions || {};
  const hostApp = state?.hostApp || null;
  const loading = !state;
  const [requesting, setRequesting] = useState<PermissionKey | null>(null);

  const rows = useMemo(() => PERMISSIONS.map(item => ({
    ...item,
    permission: permissions[item.key],
  })), [permissions]);

  const handleRequest = useCallback(async (permission: PermissionKey) => {
    if (requesting) return;
    setRequesting(permission);
    try {
      const result = await api.requestPermission(permission);
      if (!result.ok) {
        toast(result.error || t('perm.requestFailed'), false);
        return;
      }

      if (result.action === 'already_granted') {
        toast(t('perm.alreadyGranted'));
      } else if (result.action === 'prompted') {
        toast(t('perm.promptOpened'));
      } else {
        toast(t('perm.settingsOpened'));
      }

      await reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('perm.requestFailed'), false);
    } finally {
      setRequesting(current => (current === permission ? null : current));
    }
  }, [reload, requesting, t, toast]);

  const handleRefresh = useCallback(async () => {
    await reload();
  }, [reload]);

  return (
    <div className="animate-in space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-relaxed text-fg-4">
            {hostApp ? copy.introWithHost.replace('{hostApp}', hostApp) : copy.intro}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void handleRefresh()}>
          {copy.refreshState}
        </Button>
      </div>

      {rows.map(row => {
        const permission = row.permission;
        const granted = !!permission?.granted;
        const checkable = !!permission && permission.checkable;
        const statusLabel = loading
          ? copy.loading
          : !permission
            ? copy.needsGrant
            : granted
              ? copy.granted
              : copy.needsGrant;
        const statusVariant: 'ok' | 'warn' | 'accent' | 'muted' = loading
          ? 'muted'
          : granted
            ? 'ok'
            : 'warn';
        const statusDescription = loading
          ? copy.loading
          : granted
            ? (hostApp ? copy.hostGranted.replace('{hostApp}', hostApp) : copy.hostGrantedFallback)
            : checkable
              ? copy.needsGrantDetail
              : copy.needsSettingsDetail;
        const actionLabel = loading
          ? copy.checking
          : granted
            ? copy.refreshState
            : checkable
              ? copy.authorize
              : copy.openSettings;
        const onAction = granted
          ? handleRefresh
          : () => void handleRequest(row.key);

        return (
          <SettingRowCard key={row.key}>
            <SettingRowLead
              icon={row.icon}
              title={t(row.labelKey)}
              subtitle={locale === 'zh-CN' ? row.reasonZh : row.reasonEn}
            />

            <SettingRowField label={copy.status}>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={statusVariant}>{statusLabel}</Badge>
              </div>
              <div className="mt-1 text-[13px] leading-relaxed text-fg-3">
                {statusDescription}
              </div>
            </SettingRowField>

            <SettingRowField label={copy.summary}>
              <div className="break-words text-[13px] leading-relaxed text-fg-3">
                {t(row.guidePathKey)}
              </div>
            </SettingRowField>

            <SettingRowAction>
              <Button
                variant={granted ? 'outline' : 'primary'}
                size="sm"
                disabled={loading || !!requesting}
                onClick={onAction}
              >
                {requesting === row.key ? copy.checking : actionLabel}
              </Button>
            </SettingRowAction>
          </SettingRowCard>
        );
      })}
    </div>
  );
}
