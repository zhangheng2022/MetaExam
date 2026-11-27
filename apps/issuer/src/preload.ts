import { contextBridge, ipcRenderer } from 'electron';
import type { IssuerBridge } from '@metaexam/contracts';
const invoke = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`issuer:${method}`, ...args);
const bridge: IssuerBridge = {
  status: () => invoke('status'),
  unlock: (password) => invoke('unlock', password),
  lock: () => invoke('lock'),
  snapshot: () => invoke('snapshot'),
  saveCustomer: (value) => invoke('saveCustomer', value),
  importRequest: (id) => invoke('importRequest', id),
  createKey: (env) => invoke('createKey', env),
  importTestKey: () => invoke('importTestKey'),
  disableKey: (kid) => invoke('disableKey', kid),
  exportTrust: (kid, version) => invoke('exportTrust', kid, version),
  importTrust: () => invoke('importTrust'),
  importLegacyTrust: (version) => invoke('importLegacyTrust', version),
  setFloor: (id, floor, reason, never) => invoke('setFloor', id, floor, reason, never),
  importHistory: () => invoke('importHistory'),
  preview: (draft) => invoke('preview', draft),
  confirm: (id, operation) => invoke('confirm', id, operation),
  cancelPreview: () => invoke('cancelPreview'),
  exportLicense: (id) => invoke('exportLicense', id),
  changePassword: (password) => invoke('changePassword', password),
  backup: (password) => invoke('backup', password),
  restore: (password) => invoke('restore', password),
  completeReview: (note) => invoke('completeReview', note),
};
contextBridge.exposeInMainWorld('issuer', bridge);
