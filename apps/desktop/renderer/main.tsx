import { createRoot } from 'react-dom/client';
import { LocalManager, MetaExamProvider, type LocalManagerBridge } from '@metaexam/ui';
import '@metaexam/ui/styles.css';

declare global {
  interface Window {
    metaexam: LocalManagerBridge;
  }
}

createRoot(document.getElementById('root')!).render(
  <MetaExamProvider>
    <LocalManager bridge={window.metaexam} />
  </MetaExamProvider>,
);
