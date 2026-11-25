import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld(
  'metaexam',
  Object.freeze({ status: () => ipcRenderer.invoke('system:status') }),
);
