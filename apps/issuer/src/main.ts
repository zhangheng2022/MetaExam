import { app, BrowserWindow, dialog, ipcMain, powerMonitor, session } from 'electron';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IssuerHost } from './host';

app.setName('MetaExam.Issuer');
app.setPath(
  'userData',
  app.commandLine.hasSwitch('user-data-dir')
    ? path.resolve(app.commandLine.getSwitchValue('user-data-dir'))
    : path.join(app.getPath('appData'), 'MetaExam.Issuer'),
);
if (!app.requestSingleInstanceLock()) app.quit();
else
  void app.whenReady().then(async () => {
    const root = app.isPackaged
      ? path.dirname(app.getPath('exe'))
      : path.resolve(__dirname, '../../..');
    const host = new IssuerHost(
      path.join(root, app.isPackaged ? 'runtime/node.exe' : '.tools/node/node.exe'),
      app.isPackaged ? path.join(root, 'service/worker.cjs') : path.join(__dirname, 'worker.js'),
      app.getPath('userData'),
    );
    const file = path.resolve(__dirname, '../renderer-dist/index.html'),
      url = pathToFileURL(file).href;
    const window = new BrowserWindow({
      icon: path.resolve(__dirname, '../renderer-dist/brand/icon.ico'),
      width: 1120,
      height: 800,
      minWidth: 380,
      minHeight: 600,
      title: '元考 / MetaExam · 授权签发器',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: !app.isPackaged,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel: !details.url.startsWith('file:') && !details.url.startsWith('devtools:'),
      }),
    );
    let busy = false;
    async function readFile(title: string, extensions: string[], limit = 65536) {
      const result = await dialog.showOpenDialog(window, {
        title,
        filters: [{ name: title, extensions }],
        properties: ['openFile', 'dontAddToRecent'],
      });
      if (result.canceled || !result.filePaths[0]) throw new Error('CANCELLED');
      const handle = await open(result.filePaths[0], 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('FILE_TOO_LARGE');
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) {
          const read = await handle.read(buffer, size, buffer.length - size, size);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size > limit) throw new Error('FILE_TOO_LARGE');
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
      } finally {
        await handle.close();
      }
    }
    async function saveFile(title: string, extension: string, content: string) {
      const result = await dialog.showSaveDialog(window, {
        title,
        defaultPath: `MetaExam-${Date.now()}.${extension}`,
        filters: [{ name: title, extensions: [extension] }],
        properties: ['dontAddToRecent'],
      });
      if (result.canceled || !result.filePath) throw new Error('CANCELLED');
      if (!host.unlocked) throw new Error('LOCKED');
      const target = path.join(
        await realpath(path.dirname(result.filePath)),
        path.basename(result.filePath),
      );
      for (const protectedPath of [app.getPath('userData'), root]) {
        const relative = path.relative(await realpath(protectedPath), target);
        if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)))
          throw new Error('OUTPUT_DIRECTORY_DENIED');
      }
      const handle = await open(target, 'wx', 0o600);
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const methods = [
      'status',
      'unlock',
      'lock',
      'snapshot',
      'saveCustomer',
      'importRequest',
      'createKey',
      'importTestKey',
      'disableKey',
      'exportTrust',
      'importTrust',
      'importLegacyTrust',
      'setFloor',
      'importHistory',
      'preview',
      'confirm',
      'cancelPreview',
      'exportLicense',
      'changePassword',
      'backup',
      'restore',
      'completeReview',
    ];
    for (const method of methods)
      ipcMain.handle(`issuer:${method}`, async (event, ...args: unknown[]) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== url
        )
          return { ok: false, code: 'IPC_DENIED' };
        if (method === 'lock') {
          host.lock();
          return { ok: true, value: null };
        }
        if (method === 'status') {
          try {
            return {
              ok: true,
              value: { ...((await host.call('status')) as object), unlocked: host.unlocked },
            };
          } catch {
            return { ok: false, code: 'SERVICE_UNAVAILABLE' };
          }
        }
        if (busy) return { ok: false, code: 'OPERATION_BUSY' };
        if (method !== 'unlock' && !host.unlocked) return { ok: false, code: 'LOCKED' };
        busy = true;
        try {
          let value: unknown;
          switch (method) {
            case 'unlock':
              await host.call('unlock', ...args);
              host.unlocked = true;
              break;
            case 'importRequest':
              value = await host.call(method, await readFile('选择授权申请', ['mreq']), ...args);
              break;
            case 'importTestKey':
              value = await host.call(
                method,
                await readFile('选择测试私钥', ['pem']),
                await readFile('选择匹配的测试公钥', ['json']),
              );
              break;
            case 'importTrust':
              value = await host.call(method, await readFile('选择客户包信任清单', ['json']));
              break;
            case 'importLegacyTrust':
              value = await host.call(
                method,
                await readFile('选择旧测试包 public-keys.json', ['json']),
                ...args,
              );
              break;
            case 'importHistory':
              value = await host.call(method, await readFile('选择历史授权', ['mlic']));
              break;
            case 'exportTrust': {
              const trust = await host.call<{ keys: { kid: string; publicKey: string }[] }>(
                method,
                ...args,
              );
              await saveFile('导出客户包信任清单', 'json', JSON.stringify(trust, null, 2));
              await saveFile(
                '导出可信公钥',
                'json',
                JSON.stringify(
                  Object.fromEntries(trust.keys.map((k) => [k.kid, k.publicKey])),
                  null,
                  2,
                ),
              );
              break;
            }
            case 'exportLicense':
              await saveFile('导出授权文件', 'mlic', await host.call<string>('license', ...args));
              await host.call('exported', ...args);
              break;
            case 'backup':
              await saveFile('导出加密备份', 'missuer', await host.call<string>('backup', ...args));
              break;
            case 'restore':
              value = await host.call(
                'restore',
                await readFile('选择加密备份', ['missuer'], 180_000_000),
                ...args,
              );
              break;
            default:
              value = await host.call(method, ...args);
          }
          return { ok: true, value: value ?? null };
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          const code =
            (error as NodeJS.ErrnoException).code === 'EEXIST'
              ? 'FILE_EXISTS'
              : /^[A-Z_]{3,64}$/.test(message)
                ? message
                : 'OPERATION_FAILED';
          return { ok: false, code };
        } finally {
          busy = false;
        }
      });
    const idle = setInterval(() => {
      if (host.unlocked && Date.now() - host.lastActivity >= 600000) host.lock();
    }, 1000);
    powerMonitor.on('lock-screen', () => host.lock());
    powerMonitor.on('suspend', () => host.lock());
    app.on('before-quit', () => {
      clearInterval(idle);
      host.lock();
    });
    app.on('second-instance', () => {
      window.show();
      window.focus();
    });
    await window.loadFile(file);
  });
app.on('window-all-closed', () => app.quit());
