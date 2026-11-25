import { createRoot } from 'react-dom/client';
import { Dashboard } from '@metaexam/ui';
import type { SystemStatus } from '@metaexam/contracts';
import '@metaexam/ui/styles.css';
const loadStatus = async (): Promise<SystemStatus> => {
  const r = await fetch('/api/v1/system/status', { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('SERVICE_UNAVAILABLE');
  return r.json() as Promise<SystemStatus>;
};
createRoot(document.getElementById('root')!).render(<Dashboard loadStatus={loadStatus} />);
