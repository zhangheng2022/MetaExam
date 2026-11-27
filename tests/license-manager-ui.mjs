import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/api/dist/app.js';
import { BootstrapRepository, digestToken, licenseStatus } from '../packages/db/dist/index.js';
import { licenseManagerFixture } from './license-manager-fixture.mts';
const t = await licenseManagerFixture(),
  output = path.resolve('artifacts/license-manager');
mkdirSync(output, { recursive: true });
let api, desktop;
try {
  const token = randomBytes(32).toString('hex'),
    bootstrap = new BootstrapRepository(t.db);
  await bootstrap.issue(digestToken(token), new Date(Date.now() + 60000), {
    requestId: 'license-manager-ui',
  });
  await bootstrap.create(
    { username: 'license_admin', displayName: '测试管理员', password: 'unused' },
    token,
    'test-only-hash',
    { requestId: 'license-manager-ui' },
  );
  api = await createApp(t.config);
  await api.listen(0, '127.0.0.1');
  const port = api.getHttpServer().address().port;
  const configFile = path.join(t.config.home, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...t.config, api: { ...t.config.api, port } }));
  desktop = await electron.launch({
    executablePath: path.resolve('apps/desktop/node_modules/electron/dist/electron.exe'),
    args: ['apps/desktop', '--user-data-dir=' + path.join(t.config.home, 'profile')],
    env: { ...process.env, METAEXAM_CONFIG: configFile, METAEXAM_DESKTOP_SMOKE: '' },
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '授权维护', exact: true }).click();
  await page.getByRole('button', { name: '导入授权文件', exact: true }).waitFor();
  await page.getByRole('button', { name: '导出授权申请', exact: true }).click();
  await page
    .getByText('请从系统托盘退出管理器，再右键选择“以管理员身份运行”后重试。', { exact: true })
    .waitFor();
  // Exercise the production origin guard for every new IPC before replacing test adapters.
  assert.deepEqual(
    await desktop.evaluate(async ({ BrowserWindow }, preload) => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      try {
        await other.loadURL('data:text/html,<p>Untrusted</p>');
        return await other.webContents.executeJavaScript(`Promise.all([
        window.metaexam.exportLicenseRequest(), window.metaexam.previewLicenseImport(),
        window.metaexam.confirmLicenseImport('untrusted'), window.metaexam.cancelLicenseImport('untrusted')
      ].map(p => p.then(() => 'allowed', () => 'denied')))`);
      } finally {
        other.destroy();
      }
    }, path.resolve('apps/desktop/dist/preload.js')),
    ['denied', 'denied', 'denied', 'denied'],
  );

  const source = path.join(t.config.home, 'selected.mlic'),
    requestFile = path.join(t.config.home, '申请.mreq');
  // Replace only the privileged adapter in this test process. Real DB/local verifier,
  // file IO, preview lifecycle and renderer remain unchanged. Never elevate this machine.
  await desktop.evaluate(
    async ({ ipcMain }, input) => {
      const { createRequire } = process.getBuiltinModule('node:module');
      const taskRequire = createRequire(input.root + '/package.json');
      const { LicenseOperations } = taskRequire(
        input.root + '/apps/desktop/dist/license-operations.js',
      );
      const { createDatabase } = taskRequire(input.root + '/packages/db/dist/index.js');
      const { runLicenseMaintenance } = taskRequire(
        input.root + '/apps/worker/dist/license-maintenance.js',
      );
      const db = createDatabase(input.config);
      globalThis.licenseUi = { open: input.source, save: input.requestFile, db };
      const manager = new LicenseOperations({
        authorize: async () => {},
        chooseSave: async () => globalThis.licenseUi.save,
        chooseOpen: async () => globalThis.licenseUi.open,
        request: () => runLicenseMaintenance(db, { operation: 'request' }),
        preview: (raw) => runLicenseMaintenance(db, { operation: 'preview', raw }),
        import: (raw, expectedDigest) =>
          runLicenseMaintenance(db, { operation: 'import', raw, expectedDigest }),
      });
      for (const name of [
        'license:request',
        'license:preview',
        'license:confirm',
        'license:cancel',
      ])
        ipcMain.removeHandler(name);
      ipcMain.handle('license:request', () => manager.exportRequest());
      ipcMain.handle('license:preview', () => manager.preview());
      ipcMain.handle('license:confirm', (_event, id) => manager.confirm(id));
      ipcMain.handle('license:cancel', (_event, id) => manager.cancel(id));
      globalThis.licenseUi.manager = manager;
    },
    { root: path.resolve('.'), config: t.config, source, requestFile },
  );
  await page.getByRole('button', { name: '导出授权申请', exact: true }).click();
  await page.getByText('授权申请已导出：申请.mreq', { exact: true }).waitFor();
  assert.equal(
    JSON.parse(readFileSync(requestFile, 'utf8')).installationId,
    t.request.installationId,
  );
  await desktop.evaluate(() => {
    globalThis.licenseUi.open = null;
  });
  await page.getByRole('button', { name: '导入授权文件', exact: true }).click();
  await page.locator('.license-actions button:not([disabled])').first().waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await desktop.evaluate((_electron, source) => {
    globalThis.licenseUi.open = source;
  }, source);
  writeFileSync(source, 'invalid file');
  await page.getByRole('button', { name: '导入授权文件', exact: true }).click();
  await page.getByText('授权文件格式不正确，请重新选择。', { exact: true }).waitFor();
  writeFileSync(source, t.issue(1));
  await page.getByRole('button', { name: '导入授权文件', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.waitFor();
  await modal.getByText('— → 100 人', { exact: true }).waitFor();
  const exposed = await modal.innerText();
  assert.ok(!exposed.includes(t.request.deviceHash) && !exposed.includes(t.request.installationId));
  assert.equal((await licenseStatus(t.db)).state, 'unactivated');
  await page.screenshot({ path: path.join(output, 'preview.png'), fullPage: true });
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  assert.equal((await licenseStatus(t.db)).state, 'unactivated');
  const oldStatus = await (await fetch(`http://127.0.0.1:${port}/api/v1/system/status`)).json();
  await desktop.evaluate(
    ({ ipcMain, net }, input) => {
      let first = true;
      ipcMain.removeHandler('system:status');
      ipcMain.handle('system:status', async () => {
        if (first) {
          first = false;
          return new Promise((resolve) => {
            globalThis.licenseUi.releaseStatus = () => resolve(input.oldStatus);
          });
        }
        return (await net.fetch(input.url)).json();
      });
    },
    { oldStatus, url: `http://127.0.0.1:${port}/api/v1/system/status` },
  );
  await page.getByRole('button', { name: '检查状态', exact: true }).click();
  await page.getByRole('button', { name: '导入授权文件', exact: true }).click();
  await modal.waitFor();
  await modal.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.getByText('授权已导入。', { exact: true }).waitFor();
  await desktop.evaluate(() => globalThis.licenseUi.releaseStatus());
  await modal.waitFor({ state: 'hidden' });
  await page.getByText('100 人', { exact: true }).waitFor({ timeout: 5000 });
  await page.screenshot({ path: path.join(output, 'imported.png'), fullPage: true });
  assert.equal((await licenseStatus(t.db)).state, 'valid');
  await page.reload();
  await page.getByRole('button', { name: '授权维护', exact: true }).click();
  await page.getByText('100 人', { exact: true }).waitFor();
  writeFileSync(source, t.issue(2, { deviceHash: 'a'.repeat(64) }));
  await page.getByRole('button', { name: '导入授权文件', exact: true }).click();
  await page.getByText('授权文件不属于当前设备。', { exact: true }).waitFor();
  assert.equal((await licenseStatus(t.db)).maxConcurrentAttempts, 100);
  writeFileSync(source, t.issue(2, { maxConcurrentAttempts: 50 }));
  await page.getByRole('button', { name: '导入授权文件', exact: true }).click();
  await modal.getByText('100 → 50 人', { exact: true }).waitFor();
  // Concurrent maintenance invalidates the comparison before confirmation.
  const { importLicense } = await import('../packages/db/dist/index.js');
  await importLicense(t.db, t.issue(3, { maxConcurrentAttempts: 200 }));
  await modal.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.getByText('当前授权已更新，请重新选择文件并核对变更。', { exact: true }).waitFor();
  await modal.waitFor({ state: 'hidden' });
  await page.getByText('200 人', { exact: true }).waitFor();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(380, 600));
  await page.waitForFunction(() => innerWidth < 400);
  writeFileSync(source, t.issue(4, { maxConcurrentAttempts: 300 }));
  await page.getByRole('button', { name: '导入授权文件', exact: true }).click();
  await modal.waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'preview-narrow.png'), fullPage: true });
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  await desktop.evaluate(async () => {
    await globalThis.licenseUi.db.pool.end();
  });
  await desktop.close();
  desktop = undefined;
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
  writeFileSync(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        passed: true,
        realElectron: true,
        realDatabase: true,
        simulatedElevationAndDialogs: true,
        checks: [
          'ordinary permission denial',
          'all new IPC reject foreign renderers',
          'request export',
          'native dialog cancellation',
          'invalid file',
          'preview and cancel without mutation',
          'confirm and refresh',
          'reload preserves license',
          'wrong device preserves old license',
          'concurrent update invalidates preview',
          'narrow modal',
          'no renderer errors',
          'API survives exit',
        ],
      },
      null,
      2,
    ),
  );
  console.log('PASS real Electron license UI with isolated DB and simulated privileged adapter');
} catch (error) {
  if (desktop)
    await (
      await desktop.firstWindow()
    ).screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await desktop?.close();
  await api?.close();
  await t.close();
}
