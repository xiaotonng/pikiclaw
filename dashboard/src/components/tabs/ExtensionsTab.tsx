import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { createT } from '../../i18n';
import { useStore } from '../../store';
import type { BrowserStatusResponse } from '../../types';
import { BrandIcon } from '../BrandIcon';
import { Badge, Button } from '../ui';
import { SettingRowAction, SettingRowCard, SettingRowField, SettingRowLead } from './shared';

function localeText(locale: string, zh: string, en: string): string {
  return locale === 'zh-CN' ? zh : en;
}

function browserStatus(snapshot: BrowserStatusResponse | null, locale: string, t: (key: string) => string) {
  const browser = snapshot?.browser;
  if (!browser) return { label: t('status.loading'), variant: 'muted' as const };
  if (!browser.enabled) return { label: localeText(locale, '已关闭', 'Disabled'), variant: 'muted' as const };
  if (browser.status === 'chrome_missing') return { label: localeText(locale, 'Chrome 未安装', 'Chrome missing'), variant: 'err' as const };
  if (browser.status === 'needs_setup') return { label: localeText(locale, '需要配置', 'Needs setup'), variant: 'warn' as const };
  if (browser.running) return { label: localeText(locale, '浏览器已打开', 'Browser open'), variant: 'ok' as const };
  if (browser.status === 'ready') return { label: localeText(locale, '已就绪', 'Available'), variant: 'ok' as const };
  return { label: localeText(locale, '需要检查', 'Needs attention'), variant: 'warn' as const };
}

function desktopStatus(snapshot: BrowserStatusResponse | null, locale: string, t: (key: string) => string) {
  const desktop = snapshot?.desktop;
  if (!desktop) return { label: t('status.loading'), variant: 'muted' as const };
  if (!desktop.installed) return { label: localeText(locale, '未安装', 'Not installed'), variant: 'muted' as const };
  if (desktop.running) return { label: localeText(locale, '运行中', 'Running'), variant: 'ok' as const };
  if (desktop.enabled) return { label: localeText(locale, '已启用', 'Enabled'), variant: 'accent' as const };
  return { label: localeText(locale, '已关闭', 'Disabled'), variant: 'muted' as const };
}

function browserSummary(browser: BrowserStatusResponse['browser'] | undefined, locale: string): Array<{ label: string; value: string }> {
  const labelProfile = localeText(locale, '配置文件', 'Profile');
  const labelMode = localeText(locale, '运行方式', 'Mode');
  const labelChrome = localeText(locale, 'Chrome', 'Chrome');
  const profileValue = browser?.profileCreated
    ? localeText(locale, '已创建', 'Created')
    : localeText(locale, '待创建', 'Not created');
  const modeValue = browser?.enabled
    ? (browser.headlessMode === 'headed'
      ? localeText(locale, '可见窗口', 'Visible window')
      : localeText(locale, '后台运行', 'Headless'))
    : localeText(locale, '已关闭', 'Disabled');
  const chromeValue = browser?.chromeInstalled
    ? localeText(locale, '已安装', 'Installed')
    : localeText(locale, '未安装', 'Not installed');
  return [
    { label: labelProfile, value: profileValue },
    { label: labelMode, value: modeValue },
    { label: labelChrome, value: chromeValue },
  ];
}

function desktopSummary(desktop: BrowserStatusResponse['desktop'] | undefined, locale: string): Array<{ label: string; value: string }> {
  const labelAddress = localeText(locale, '连接地址', 'Address');
  const labelDriver = localeText(locale, '驱动', 'Driver');
  const labelState = localeText(locale, '服务状态', 'Service');
  const addressValue = desktop?.appiumUrl || 'http://127.0.0.1:4723';
  const driverValue = localeText(locale, 'Appium Mac2', 'Appium Mac2');
  const stateValue = !desktop
    ? localeText(locale, '加载中', 'Loading')
    : desktop.running
      ? localeText(locale, '运行中', 'Running')
      : desktop.enabled
        ? localeText(locale, '已启用', 'Enabled')
        : localeText(locale, '已关闭', 'Disabled');
  return [
    { label: labelAddress, value: addressValue },
    { label: labelDriver, value: driverValue },
    { label: labelState, value: stateValue },
  ];
}

function browserStatusDetail(browser: BrowserStatusResponse['browser'] | undefined, locale: string): string {
  if (!browser) return localeText(locale, '正在读取浏览器状态。', 'Loading browser status.');
  if (!browser.enabled) return localeText(locale, '当前不会向 Agent 会话注入 browser MCP。', 'Browser MCP will not be injected into agent sessions.');
  if (browser.running) return localeText(locale, '独立浏览器已打开，可继续补充登录态。', 'The managed browser is open and ready for login.');
  if (browser.status === 'ready') return localeText(locale, '已就绪，可在后续会话中直接使用。', 'Ready for upcoming sessions.');
  if (browser.status === 'chrome_missing') return localeText(locale, '本机未检测到 Chrome。', 'Chrome was not detected on this machine.');
  return browser.detail || localeText(locale, '需要先完成一次浏览器配置。', 'Setup is required before browser automation can be used.');
}

function desktopStatusDetail(desktop: BrowserStatusResponse['desktop'] | undefined, locale: string): string {
  if (!desktop) return localeText(locale, '正在读取桌面自动化状态。', 'Loading desktop automation status.');
  if (!desktop.installed) return localeText(locale, '需要先安装 Appium Mac2 驱动。', 'Appium Mac2 must be installed first.');
  if (desktop.running) return localeText(locale, '桌面自动化服务已启动。', 'The desktop automation service is running.');
  if (desktop.enabled) return localeText(locale, '已启用，可在后续会话中直接调用。', 'Enabled and ready for upcoming sessions.');
  return localeText(locale, '当前不会向 Agent 会话注入桌面自动化能力。', 'Desktop automation will not be injected into agent sessions.');
}

export function ExtensionsTab({
  onOpenBrowserSetup,
  onOpenDesktopSetup,
}: {
  onOpenBrowserSetup: () => void;
  onOpenDesktopSetup: () => void;
}) {
  const { locale, toast, state } = useStore();
  const t = createT(locale);
  const [snapshot, setSnapshot] = useState<BrowserStatusResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setSnapshot(await api.getBrowser());
    } catch (error) {
      toast(error instanceof Error ? error.message : t('config.applyFailed'), false);
    } finally {
      setRefreshing(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh, state]);

  const browser = snapshot?.browser;
  const desktop = snapshot?.desktop;
  const browserBadge = browserStatus(snapshot, locale, t);
  const desktopBadge = desktopStatus(snapshot, locale, t);
  const browserLines = browserSummary(browser, locale);
  const desktopLines = desktopSummary(desktop, locale);

  return (
    <div className="animate-in space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-relaxed text-fg-4">{t('ext.hint')}</div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          {t('perm.guideRefresh')}
        </Button>
      </div>

      <SettingRowCard className="xl:grid-cols-[minmax(0,235px)_minmax(240px,0.95fr)_minmax(0,1.1fr)_auto]">
        <SettingRowLead
          icon={<BrandIcon brand="playwright" size={22} />}
          title={t('ext.browser')}
          subtitle={t('ext.browserDesc')}
        />

        <SettingRowField label={localeText(locale, '状态', 'Status')}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={browserBadge.variant}>{browserBadge.label}</Badge>
          </div>
          <div className="mt-1 text-[13px] leading-relaxed text-fg-3">
            {browserStatusDetail(browser, locale)}
          </div>
        </SettingRowField>

        <SettingRowField label={localeText(locale, '当前配置', 'Current config')}>
          <div className="space-y-1.5 text-[13px] leading-relaxed text-fg-3">
            {browserLines.map(line => (
              <div key={line.label} className="flex items-start gap-2">
                <span className="w-16 shrink-0 text-fg-5">{line.label}</span>
                <span className="min-w-0 break-words">{line.value}</span>
              </div>
            ))}
          </div>
        </SettingRowField>

        <SettingRowAction>
          <Button variant={browser?.enabled ? 'outline' : 'primary'} size="sm" onClick={onOpenBrowserSetup}>
            {browser?.enabled ? localeText(locale, '管理', 'Manage') : t('ext.setup')}
          </Button>
        </SettingRowAction>
      </SettingRowCard>

      <SettingRowCard className="xl:grid-cols-[minmax(0,235px)_minmax(240px,0.95fr)_minmax(0,1.1fr)_auto]">
        <SettingRowLead
          icon={<BrandIcon brand="appium" size={22} />}
          title={t('ext.desktop')}
          subtitle={t('ext.desktopDesc')}
        />

        <SettingRowField label={localeText(locale, '状态', 'Status')}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={desktopBadge.variant}>{desktopBadge.label}</Badge>
          </div>
          <div className="mt-1 text-[13px] leading-relaxed text-fg-3">
            {desktopStatusDetail(desktop, locale)}
          </div>
        </SettingRowField>

        <SettingRowField label={localeText(locale, '当前配置', 'Current config')}>
          <div className="space-y-1.5 text-[13px] leading-relaxed text-fg-3">
            {desktopLines.map(line => (
              <div key={line.label} className="flex items-start gap-2">
                <span className="w-16 shrink-0 text-fg-5">{line.label}</span>
                <span className={/^https?:\/\//.test(line.value) ? 'min-w-0 break-words font-mono text-[12px]' : 'min-w-0 break-words'}>
                  {line.value}
                </span>
              </div>
            ))}
          </div>
        </SettingRowField>

        <SettingRowAction>
          <Button variant={desktop?.enabled ? 'outline' : 'primary'} size="sm" onClick={onOpenDesktopSetup}>
            {desktop?.enabled ? localeText(locale, '管理', 'Manage') : t('ext.setup')}
          </Button>
        </SettingRowAction>
      </SettingRowCard>
    </div>
  );
}
