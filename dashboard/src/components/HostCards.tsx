import { useStore } from '../store';
import { createT } from '../i18n';
import { buildHostMetricItems, SystemInfoGrid } from './SystemInfoPanel';

export function HostCards() {
  const { host, locale } = useStore();
  const t = createT(locale);
  return <SystemInfoGrid items={buildHostMetricItems(host, t)} loading={!host} />;
}
