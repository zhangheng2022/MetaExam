// Test-only adapter around the real main entry. Never included in either package.
import path from 'node:path';
import { createRequire } from 'node:module';
const loadCode = createRequire(import.meta.url);
import { Tray, dialog, ipcMain } from 'electron';
const lifecycle = loadCode('../../apps/desktop/dist/window-lifecycle.js');
const attach = lifecycle.attachWindowLifecycle;
lifecycle.attachWindowLifecycle = (...args) => {
  globalThis.managerLifecycle = attach(...args);
  return globalThis.managerLifecycle;
};
globalThis.managerNotices = [];
dialog.showMessageBox = async (_window, options) => {
  globalThis.managerNotices.push(options.message);
  return { response: 0, checkboxChecked: false };
};
const menu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (value) {
  globalThis.managerTray = this;
  globalThis.managerMenu = value;
  return menu.call(this, value);
};
if (process.argv.includes('--fixture-tray-failure')) {
  Tray.prototype.setToolTip = () => {
    throw new Error('TEST_TRAY_UNAVAILABLE');
  };
}
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => {
  if (channel === 'manager:hide') globalThis.managerHideHandler = callback;
  return handle(channel, callback);
};
loadCode(path.resolve(import.meta.dirname, '../../apps/desktop/dist/main.js'));
