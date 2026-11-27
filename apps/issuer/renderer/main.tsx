import React from 'react';
import { createRoot } from 'react-dom/client';
import { MetaExamProvider } from '@metaexam/ui';
import { IssuerApp } from '@metaexam/ui/issuer';
import type { IssuerBridge } from '@metaexam/contracts';
declare global {
  interface Window {
    issuer: IssuerBridge;
  }
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MetaExamProvider>
      <IssuerApp bridge={window.issuer} />
    </MetaExamProvider>
  </React.StrictMode>,
);
