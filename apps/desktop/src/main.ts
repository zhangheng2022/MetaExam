import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  net,
  shell,
  screen,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { attachWindowLifecycle } from './window-lifecycle';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createLicenseOperations } from './license-maintenance';
import { createBackupOperations } from './backup-maintenance';
import { createDiagnosticOperations } from './diagnostic-maintenance';
function endpoint() {
  const configPath =
    process.env.METAEXAM_CONFIG ??
    path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'MetaExam', 'public-config.json');
  if (existsSync(configPath)) {
    const c = JSON.parse(readFileSync(configPath, 'utf8')) as {
      api: { port: number; tlsCert?: string };
    };
    return (c.api.tlsCert ? 'https' : 'http') + '://127.0.0.1:' + c.api.port;
  }
  return 'http://127.0.0.1:3000';
}
async function main() {
  const run = promisify(execFile);
  const elevated = await run(
    path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ],
    { windowsHide: true, timeout: 10000 },
  ).then(
    (result) => result.stdout.trim() === 'True',
    () => null,
  );
  if (!app.requestSingleInstanceLock({ elevated })) {
    app.quit();
    return;
  }
  let showExisting = () => {};
  let repeated = false;
  let elevationConflict = false;
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    repeated = true;
    elevationConflict =
      (!data || typeof data !== 'object' || !('elevated' in data) || data.elevated !== false) &&
      elevated !== true;
    showExisting();
  });
  await app.whenReady();
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const icon = path.resolve(__dirname, '../renderer-dist/brand/icon.ico');
  const file = path.resolve(__dirname, '../renderer-dist/index.html');
  const window = new BrowserWindow({
    icon,
    width: Math.min(760, workArea.width),
    height: Math.min(560, workArea.height),
    minWidth: Math.min(380, workArea.width),
    minHeight: Math.min(480, workArea.height),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const businessAddress = () => {
    const webPort = Number(process.env.METAEXAM_WEB_PORT);
    const business =
      !app.isPackaged && Number.isInteger(webPort) && webPort > 0 && webPort < 65536
        ? 'http://127.0.0.1:' + webPort
        : endpoint();
    return business + '/login';
  };
  const lifecycle = attachWindowLifecycle(window, icon, () =>
    shell.openExternal(businessAddress()),
  );
  const publishVisibility = (visible: boolean) => {
    if (!window.isDestroyed()) window.webContents.send('manager:visibility', visible);
  };
  // Native visibility flags can still reflect the old state inside these events.
  window.on('show', () => publishVisibility(true));
  window.on('restore', () => publishVisibility(true));
  window.on('hide', () => publishVisibility(false));
  window.on('minimize', () => publishVisibility(false));
  window.webContents.on('did-finish-load', () =>
    publishVisibility(window.isVisible() && !window.isMinimized()),
  );
  showExisting = () => {
    lifecycle.restore();
    if (elevationConflict) {
      elevationConflict = false;
      void lifecycle.notice(
        '管理器已在运行。如需管理员权限，请先从系统托盘退出管理器，再右键选择“以管理员身份运行”。',
      );
    }
  };
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const validateSender = (event: IpcMainInvokeEvent) => {
    if (
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== pathToFileURL(file).href
    )
      throw new Error('INVALID_IPC_ORIGIN');
  };
  const request = async (route: string, options: RequestInit = {}) => {
    const r = await net.fetch(endpoint() + route, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const body = (await r.json()) as { code?: string };
      throw new Error(body.code ?? 'SERVICE_UNAVAILABLE');
    }
    return r.json();
  };
  const licenses = createLicenseOperations(window, lifecycle.nativeDialog);
  const backups = createBackupOperations(window, lifecycle.nativeDialog);
  const diagnostics = createDiagnosticOperations(window, endpoint, lifecycle.nativeDialog);
  ipcMain.handle('diagnostics:check', (event, ...args: unknown[]) => {
    validateSender(event);
    if (args.length) throw new Error('INVALID_IPC_ARGUMENTS');
    return diagnostics.check();
  });
  ipcMain.handle('diagnostics:export', (event, ...args: unknown[]) => {
    validateSender(event);
    if (args.length) throw new Error('INVALID_IPC_ARGUMENTS');
    return lifecycle.run(() => diagnostics.export());
  });
  window.webContents.on('did-start-navigation', () => backups.clear());
  window.on('closed', () => backups.clear());
  ipcMain.handle('backup:create', (event) => {
    validateSender(event);
    return lifecycle.run(() => backups.create());
  });
  ipcMain.handle('backup:preview', (event) => {
    validateSender(event);
    return lifecycle.run(() => backups.preview());
  });
  ipcMain.handle('backup:confirm', (event, id: unknown) => {
    validateSender(event);
    return lifecycle.run(() => backups.confirm(id));
  });
  ipcMain.handle('backup:cancel', (event, id: unknown) => {
    validateSender(event);
    backups.cancel(id);
  });
  ipcMain.handle('backup:recover', (event) => {
    validateSender(event);
    return lifecycle.run(() => backups.recover());
  });
  window.webContents.on('did-start-navigation', () => licenses.clear());
  window.on('closed', () => licenses.clear());
  ipcMain.handle('license:request', (event) => {
    validateSender(event);
    return lifecycle.run(() => licenses.exportRequest());
  });
  ipcMain.handle('license:preview', (event) => {
    validateSender(event);
    return lifecycle.run(() => licenses.preview());
  });
  ipcMain.handle('license:confirm', (event, id: unknown) => {
    validateSender(event);
    return lifecycle.run(() => licenses.confirm(id));
  });
  ipcMain.handle('license:cancel', (event, id: unknown) => {
    validateSender(event);
    licenses.cancel(id);
  });
  ipcMain.handle('system:status', async (event) => {
    validateSender(event);
    return request('/api/v1/system/status');
  });
  ipcMain.handle('setup:status', async (event) => {
    validateSender(event);
    return request('/api/v1/setup/status');
  });
  ipcMain.handle('setup:create', async (event, input: unknown) => {
    validateSender(event);
    return lifecycle.run(async () => {
      if (!input || typeof input !== 'object') return { ok: false, code: 'INVALID_REQUEST' };
      const data = input as Record<string, unknown>;
      if (
        Object.keys(data).sort().join(',') !== 'displayName,password,username' ||
        !['username', 'displayName', 'password'].every(
          (k) => typeof data[k] === 'string' && (data[k] as string).length <= 128,
        )
      )
        return { ok: false, code: 'INVALID_REQUEST' };
      try {
        const run = promisify(execFile);
        const elevated = await run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
          ],
          { windowsHide: true, timeout: 10000 },
        );
        if (elevated.stdout.trim() !== 'True') return { ok: false, code: 'ADMINISTRATOR_REQUIRED' };
        const root = app.isPackaged
          ? path.resolve(path.dirname(app.getPath('exe')), '..')
          : path.resolve(__dirname, '../../..');
        const configFile =
          process.env.METAEXAM_CONFIG ??
          path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'MetaExam', 'config.json');
        const config = JSON.parse(readFileSync(configFile, 'utf8')) as { home: string };
        const tokenFile = path.join(config.home, 'bootstrap/token.json');
        let credential: { token: string; expiresAt: string } | undefined;
        if (existsSync(tokenFile)) credential = JSON.parse(readFileSync(tokenFile, 'utf8'));
        if (!credential || Date.parse(credential.expiresAt) <= Date.now()) {
          await run(
            path.join(root, app.isPackaged ? 'runtime/node.exe' : '.tools/node/node.exe'),
            [
              path.join(root, app.isPackaged ? 'server/cli.cjs' : 'apps/worker/dist/cli.js'),
              'setup-token',
            ],
            {
              env: { ...process.env, METAEXAM_CONFIG: configFile },
              windowsHide: true,
              timeout: 20000,
            },
          );
          credential = JSON.parse(readFileSync(tokenFile, 'utf8'));
        }
        if (!credential || !/^[a-f0-9]{64}$/.test(credential.token))
          throw new Error('SETUP_TOKEN_INVALID');
        await request('/api/v1/setup/administrator', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            authorization: 'Bearer ' + credential.token,
          },
          body: JSON.stringify(data),
        });
        // Server consumption is authoritative even if local file cleanup fails.
        try {
          unlinkSync(tokenFile);
        } catch {
          console.warn('BOOTSTRAP_FILE_CLEANUP_PENDING');
        }
        return { ok: true };
      } catch (error) {
        const safe = [
          'ALREADY_INITIALIZED',
          'SETUP_TOKEN_INVALID',
          'INVALID_REQUEST',
          'DATABASE_UNAVAILABLE',
          'RATE_LIMITED',
        ];
        const code =
          error instanceof Error && safe.includes(error.message) ? error.message : 'SETUP_FAILED';
        return { ok: false, code };
      }
    });
  });
  ipcMain.handle('manager:hide', (event, ...args: unknown[]) => {
    validateSender(event);
    if (args.length) throw new Error('INVALID_IPC_ARGUMENTS');
    return lifecycle.hide();
  });
  ipcMain.handle('business:open', async (event) => {
    validateSender(event);
    await shell.openExternal(businessAddress());
  });
  ipcMain.handle('business:copy-address', (event) => {
    validateSender(event);
    clipboard.writeText(businessAddress());
  });
  await window.loadFile(file);
  window.show();
  if (repeated) showExisting();
  if (process.env.METAEXAM_DESKTOP_SMOKE === '1') {
    const status = (await window.webContents.executeJavaScript('window.metaexam.status()')) as {
      product?: string;
      database?: string;
    };
    if (status.product !== 'MetaExam' || status.database !== 'ready')
      throw new Error('DESKTOP_STATUS_FAILED');
    const primaryColor = await window.webContents.executeJavaScript(
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const check = () => {
          const button = document.querySelector('.ant-btn-primary');
          if (button) resolve(getComputedStyle(button).backgroundColor);
          else if (Date.now() >= deadline) reject(new Error('DESKTOP_RENDER_TIMEOUT'));
          else setTimeout(check, 50);
        };
        check();
      })`,
    );
    if (primaryColor !== 'rgb(22, 119, 255)') throw new Error('DESKTOP_THEME_FAILED');
    console.log('DESKTOP_STATUS_READY');
    app.quit();
  }
}
app.on('window-all-closed', () => app.quit());
main().catch(() => {
  console.error('DESKTOP_START_FAILED');
  app.exit(1);
});
