import { app, dialog, Menu, Tray, type BrowserWindow } from 'electron';

// Owns only the manager window. Product services are independent processes.
export function attachWindowLifecycle(
  window: BrowserWindow,
  icon: string,
  openBusiness: () => Promise<void>,
  createTray: (icon: string) => Tray = (file) => new Tray(file),
) {
  let tray: Tray | undefined;
  let quitting = false;
  let sessionEnding = false;
  let operations = 0;
  let dialogs = 0;
  let noticePending = false;
  const restore = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const nativeDialog = async <T>(action: () => Promise<T>): Promise<T> => {
    restore();
    dialogs++;
    try {
      return await action();
    } finally {
      dialogs--;
    }
  };
  const notice = async (message: string) => {
    if (noticePending || window.isDestroyed()) return;
    noticePending = true;
    try {
      await nativeDialog(() =>
        dialog.showMessageBox(window, { type: 'info', title: '元考本地管理器', message }),
      );
    } catch {
      console.warn('MANAGER_NOTICE_FAILED');
    } finally {
      noticePending = false;
    }
  };
  const hide = () => {
    if (dialogs) return false;
    if (!tray || tray.isDestroyed()) {
      void notice('系统托盘不可用，请保持窗口打开；关闭窗口将退出管理器，后台服务继续运行。');
      return false;
    }
    window.hide();
    return true;
  };
  const beforeQuit = (event: Electron.Event) => {
    if (!sessionEnding && (operations || dialogs)) {
      event.preventDefault();
      quitting = false;
      void notice('操作正在进行，请等待完成后再退出管理器。后台运行不会中断当前任务。');
      return;
    }
    quitting = true;
  };
  app.on('before-quit', beforeQuit);
  window.on('session-end', () => {
    sessionEnding = true;
    quitting = true;
  });
  window.on('close', (event) => {
    if (quitting || sessionEnding) return;
    if (tray && !tray.isDestroyed()) {
      event.preventDefault();
      hide();
    } else if (operations || dialogs) {
      event.preventDefault();
      void notice('操作正在进行，请等待完成后再关闭管理器。');
    }
  });
  try {
    tray = createTray(icon);
    tray.setToolTip('元考 · 本地管理器');
    tray.on('double-click', restore);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开管理器', click: restore },
        {
          label: '打开考试系统',
          click: () => {
            void openBusiness().catch(() =>
              notice('无法打开浏览器，请在管理器中复制登录地址后手动访问。'),
            );
          },
        },
        { type: 'separator' },
        { label: '退出管理器', click: () => app.quit() },
      ]),
    );
  } catch {
    tray?.destroy();
    tray = undefined;
    // Keep a reachable window if Explorer/the notification area is unavailable.
    window.once(
      'ready-to-show',
      () => void notice('系统托盘不可用，关闭窗口将退出管理器。后台服务继续运行。'),
    );
  }
  window.on('closed', () => {
    tray?.destroy();
    app.removeListener('before-quit', beforeQuit);
  });
  return {
    restore,
    hide,
    notice,
    nativeDialog,
    async run<T>(action: () => Promise<T>): Promise<T> {
      operations++;
      try {
        return await action();
      } finally {
        operations--;
      }
    },
  };
}
