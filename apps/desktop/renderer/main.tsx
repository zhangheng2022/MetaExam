import { createRoot } from 'react-dom/client';
import { Dashboard } from '@metaexam/ui';
import '@metaexam/ui/styles.css';
import type { SystemStatus } from '@metaexam/contracts';
declare global {
  interface Window {
    metaexam: { status: () => Promise<SystemStatus> };
  }
}
const loadStatus = () => window.metaexam.status();
createRoot(document.getElementById('root')!).render(<Dashboard loadStatus={loadStatus} desktop />);
