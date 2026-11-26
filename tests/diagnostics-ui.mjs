import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = mkdtempSync(path.join(tmpdir(), 'MetaExam-diagnostic-ui-'));
const packaged = process.argv.includes('--packaged');
const version = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version;
const home = path.join(root, 'runtime');
mkdirSync(home);
const output = path.resolve(packaged ? 'artifacts/diagnostics-packaged' : 'artifacts/diagnostics');
mkdirSync(output, { recursive: true });
let mode = 'ready',
  desktop;
const secret = 'NEVER_EXPORT_SECRET';
const server = createServer((request, response) => {
  const live = request.url === '/health/live',
    ready = request.url === '/health/ready';
  const body = live
    ? { status: 'alive', version }
    : ready
      ? { status: mode, schemaVersion: mode === 'ready' ? 10 : 0 }
      : request.url === '/api/v1/setup/status'
        ? { database: mode, adminInitialized: true }
        : {
            product: 'MetaExam',
            version,
            initialized: true,
            adminInitialized: true,
            database: mode,
            schemaVersion: 10,
            worker: 'online',
            checkedAt: new Date().toISOString(),
            license: {
              state: 'unactivated',
              expiresAt: null,
              maxConcurrentAttempts: null,
              features: [],
              secret,
            },
            secret,
          };
  response.writeHead(ready && mode !== 'ready' ? 503 : 200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const config = path.join(home, 'config.json');
writeFileSync(
  config,
  JSON.stringify({ home, api: { port: server.address().port }, password: secret }),
);
const file = path.join(root, 'diagnostics.json');
async function cleanup() {
  if (
    path.dirname(root) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('MetaExam-diagnostic-ui-')
  )
    throw new Error('Unsafe cleanup');
  rmSync(root, { recursive: true, force: true });
}
try {
  desktop = await electron.launch({
    executablePath: path.resolve(
      packaged
        ? 'artifacts/payload/manager/MetaExam.Manager.exe'
        : 'apps/desktop/node_modules/electron/dist/electron.exe',
    ),
    args: [...(packaged ? [] : ['apps/desktop']), '--user-data-dir=' + path.join(root, 'profile')],
    env: { ...process.env, METAEXAM_CONFIG: config, METAEXAM_DESKTOP_SMOKE: '' },
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByText('故障诊断', { exact: true }).click();
  await page.getByRole('button', { name: '检查诊断', exact: true }).click();
  await page.getByText('检查快照：', { exact: false }).waitFor();
  assert.equal(await page.getByText('正常', { exact: true }).count(), 3);
  await desktop.evaluate(({ dialog }, file) => {
    globalThis.diagnosticTest = { cancel: true };
    dialog.showSaveDialog = async () => ({
      canceled: globalThis.diagnosticTest.cancel,
      filePath: file,
    });
  }, file);
  await page.getByRole('button', { name: '导出诊断报告', exact: true }).click();
  await page.getByRole('button', { name: '导出诊断报告', exact: true }).isEnabled();
  assert.equal(existsSync(file), false);
  await desktop.evaluate(() => {
    globalThis.diagnosticTest.cancel = false;
  });
  await page.getByRole('button', { name: '导出诊断报告', exact: true }).click();
  await page.getByText('诊断报告已导出。', { exact: true }).waitFor();
  const report = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(report.managerVersion, version);
  assert.equal(report.checks.live.state, 'ok');
  assert.equal(report.system.license, 'unactivated');
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(report).includes(root));
  await page.getByRole('button', { name: '导出诊断报告', exact: true }).click();
  await page.getByText('文件已存在，请使用新的文件名。', { exact: true }).waitFor();
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(report, null, 2) + '\n');
  mode = 'unavailable';
  await page.getByRole('button', { name: '检查诊断', exact: true }).click();
  await page.getByText('请求失败（503）', { exact: true }).waitFor();
  writeFileSync(path.join(root, 'upgrade-pending.json'), secret);
  await new Promise((resolve) => server.close(resolve));
  await page.getByRole('button', { name: '检查诊断', exact: true }).click();
  await page.getByText('无法连接', { exact: true }).first().waitFor();
  if (!packaged) await page.getByText('存在待处理记录', { exact: true }).waitFor();
  assert.equal(await page.getByText('无法连接', { exact: true }).count(), 3);
  const offline = await page.evaluate(() => window.metaexam.checkDiagnostics());
  assert.equal(offline.value.system.license, 'unknown');
  assert.equal(offline.value.system.adminInitialized, null);
  const offlineFile = path.join(root, 'offline.json');
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, offlineFile);
  await page.getByRole('button', { name: '导出诊断报告', exact: true }).click();
  await page.getByText('诊断报告已导出。', { exact: true }).waitFor();
  const savedOffline = JSON.parse(readFileSync(offlineFile, 'utf8'));
  assert.equal(savedOffline.checks.live.state, 'unreachable');
  assert.equal(savedOffline.system.license, 'unknown');
  if (!packaged) assert.equal(savedOffline.maintenance.upgrade, 'present');
  assert.ok(!JSON.stringify(savedOffline).includes(secret));
  const denied = await desktop.evaluate(
    async ({ BrowserWindow }, preload) => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      try {
        await other.loadURL('data:text/html,<p>Untrusted</p>');
        return await other.webContents.executeJavaScript(
          "Promise.all([window.metaexam.checkDiagnostics(),window.metaexam.exportDiagnostics()].map(p=>p.then(()=> 'allowed',()=> 'denied')))",
        );
      } finally {
        other.destroy();
      }
    },
    path.resolve(
      packaged
        ? 'artifacts/payload/manager/resources/app.asar/dist/preload.js'
        : 'apps/desktop/dist/preload.js',
    ),
  );
  assert.deepEqual(denied, ['denied', 'denied']);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(380, 720));
  await page.screenshot({ path: path.join(output, 'offline-narrow.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  console.log(
    `PASS ${packaged ? 'packaged' : 'development'} Electron diagnostic check/export/cancel/offline/503, redaction, overwrite refusal, foreign-frame denial and narrow layout`,
  );
} finally {
  await desktop?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await cleanup();
}
