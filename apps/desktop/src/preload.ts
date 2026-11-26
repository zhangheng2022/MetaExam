import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld(
  'metaexam',
  Object.freeze({
    status: () => ipcRenderer.invoke('system:status'),
    setupStatus: () => ipcRenderer.invoke('setup:status'),
    createAdministrator: (input: unknown) => ipcRenderer.invoke('setup:create', input),
    openBusiness: () => ipcRenderer.invoke('business:open'),
    copyBusinessAddress: () => ipcRenderer.invoke('business:copy-address'),
    exportLicenseRequest: () => ipcRenderer.invoke('license:request'),
    previewLicenseImport: () => ipcRenderer.invoke('license:preview'),
    confirmLicenseImport: (id: string) => ipcRenderer.invoke('license:confirm', id),
    cancelLicenseImport: (id: string) => ipcRenderer.invoke('license:cancel', id),
    createBackup: () => ipcRenderer.invoke('backup:create'),
    previewRestore: () => ipcRenderer.invoke('backup:preview'),
    confirmRestore: (id: string) => ipcRenderer.invoke('backup:confirm', id),
    cancelRestore: (id: string) => ipcRenderer.invoke('backup:cancel', id),
    recoverRestore: () => ipcRenderer.invoke('backup:recover'),
  }),
);
