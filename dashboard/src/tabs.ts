export type DashboardTab = 'im' | 'agents' | 'permissions' | 'extensions' | 'sessions' | 'system';

export const DEFAULT_DASHBOARD_TAB: DashboardTab = 'im';

const DASHBOARD_TAB_ITEMS: ReadonlyArray<{
  key: DashboardTab;
  labelKey: string;
  descriptionKey: string;
}> = [
  { key: 'im', labelKey: 'tab.im', descriptionKey: 'tabDesc.im' },
  { key: 'agents', labelKey: 'tab.agent', descriptionKey: 'tabDesc.agent' },
  { key: 'permissions', labelKey: 'tab.permissions', descriptionKey: 'tabDesc.permissions' },
  { key: 'extensions', labelKey: 'tab.extensions', descriptionKey: 'tabDesc.extensions' },
  { key: 'sessions', labelKey: 'tab.sessions', descriptionKey: 'tabDesc.sessions' },
  { key: 'system', labelKey: 'tab.system', descriptionKey: 'tabDesc.system' },
];

export function getDashboardTabs(t: (key: string) => string) {
  return DASHBOARD_TAB_ITEMS.map(item => ({
    key: item.key,
    label: t(item.labelKey),
  }));
}

export function getDashboardTabMeta(tab: DashboardTab, t: (key: string) => string): { title: string; description: string } {
  const item = DASHBOARD_TAB_ITEMS.find(candidate => candidate.key === tab);
  return item
    ? { title: t(item.labelKey), description: t(item.descriptionKey) }
    : { title: tab, description: '' };
}
