import { app, BrowserWindow, ipcMain, net } from 'electron';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
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
    width: 1160,
    height: 850,
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
  ipcMain.handle('system:status', async (event) => {
    if (
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== pathToFileURL(file).href
    )
      throw new Error('INVALID_IPC_ORIGIN');
    const r = await net.fetch(endpoint() + '/api/v1/system/status', {
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('SERVICE_UNAVAILABLE');
    return r.json();
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
    console.log('DESKTOP_STATUS_READY');
    app.quit();
  }
}
app.on('window-all-closed', () => app.quit());
main().catch(() => {
  console.error('DESKTOP_START_FAILED');
  app.exit(1);
});
