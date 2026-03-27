import { useMemo } from 'react';
import { useStore } from '../store';
import { createT } from '../i18n';
import { buildHostMetricItems, SystemInfoGrid } from './SystemInfoPanel';

export function HostCards() {
  const host = useStore(s => s.host);
  const locale = useStore(s => s.locale);
  const t = useMemo(() => createT(locale), [locale]);
  return <SystemInfoGrid items={buildHostMetricItems(host, t)} loading={!host} />;
}
