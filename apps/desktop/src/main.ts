import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  net,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
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
  await app.whenReady();
  const file = path.resolve(__dirname, '../renderer-dist/index.html');
  const window = new BrowserWindow({
    icon: path.resolve(__dirname, '../renderer-dist/brand/icon.ico'),
    width: 1000,
    height: 720,
    minWidth: 380,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
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
  const licenses = createLicenseOperations(window);
  const backups = createBackupOperations(window);
  const diagnostics = createDiagnosticOperations(window, endpoint);
  ipcMain.handle('diagnostics:check', (event, ...args: unknown[]) => {
    validateSender(event);
    if (args.length) throw new Error('INVALID_IPC_ARGUMENTS');
    return diagnostics.check();
  });
  ipcMain.handle('diagnostics:export', (event, ...args: unknown[]) => {
    validateSender(event);
    if (args.length) throw new Error('INVALID_IPC_ARGUMENTS');
    return diagnostics.export();
  });
  window.webContents.on('did-start-navigation', () => backups.clear());
  window.on('closed', () => backups.clear());
  ipcMain.handle('backup:create', (event) => {
    validateSender(event);
    return backups.create();
  });
  ipcMain.handle('backup:preview', (event) => {
    validateSender(event);
    return backups.preview();
  });
  ipcMain.handle('backup:confirm', (event, id: unknown) => {
    validateSender(event);
    return backups.confirm(id);
  });
  ipcMain.handle('backup:cancel', (event, id: unknown) => {
    validateSender(event);
    backups.cancel(id);
  });
  ipcMain.handle('backup:recover', (event) => {
    validateSender(event);
    return backups.recover();
  });
  window.webContents.on('did-start-navigation', () => licenses.clear());
  window.on('closed', () => licenses.clear());
  ipcMain.handle('license:request', (event) => {
    validateSender(event);
    return licenses.exportRequest();
  });
  ipcMain.handle('license:preview', (event) => {
    validateSender(event);
    return licenses.preview();
  });
  ipcMain.handle('license:confirm', (event, id: unknown) => {
    validateSender(event);
    return licenses.confirm(id);
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
  const businessAddress = () => {
    const webPort = Number(process.env.METAEXAM_WEB_PORT);
    const business =
      !app.isPackaged && Number.isInteger(webPort) && webPort > 0 && webPort < 65536
        ? 'http://127.0.0.1:' + webPort
        : endpoint();
    return business + '/login';
  };
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
