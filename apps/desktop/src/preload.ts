import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld(
  'metaexam',
  Object.freeze({
    status: () => ipcRenderer.invoke('system:status'),
    setupStatus: () => ipcRenderer.invoke('setup:status'),
    createAdministrator: (input: unknown) => ipcRenderer.invoke('setup:create', input),
    openBusiness: () => ipcRenderer.invoke('business:open'),
  }),
);
