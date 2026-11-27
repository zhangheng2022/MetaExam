import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright';

const home = mkdtempSync(path.join(tmpdir(), 'MetaExam-issuer-ui-'));
const packaged = process.argv.includes('--packaged');
const output = path.resolve(`artifacts/issuer-ui${packaged ? '-packaged' : ''}`);
mkdirSync(output, { recursive: true });
const password = 'UI test vault password 123456';
const request = {
  schemaVersion: 1,
  product: 'MetaExam',
  requestId: randomUUID(),
  installationId: randomUUID(),
  deviceHash: 'b'.repeat(64),
  fingerprintVersion: 1,
  fingerprintMode: 'smbios',
  appVersion: '0.1.2',
};
writeFileSync(path.join(home, 'request.mreq'), JSON.stringify(request));
let desktop;
function cleanup() {
  if (
    path.dirname(home) !== path.resolve(tmpdir()) ||
    !path.basename(home).startsWith('MetaExam-issuer-ui-')
  )
    throw new Error('Unsafe cleanup');
  rmSync(home, { recursive: true, force: true });
}
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({
    executablePath: path.resolve(
      packaged
        ? 'artifacts/issuer-payload/MetaExam.Issuer.exe'
        : 'apps/desktop/node_modules/electron/dist/electron.exe',
    ),
    args: [...(packaged ? [] : ['apps/issuer']), '--user-data-dir=' + path.join(home, 'profile')],
    env,
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await desktop.evaluate(({ dialog }, home) => {
    globalThis.issuerTest = {
      open: home + '/request.mreq',
      save: home + '/license.mlic',
      cancel: false,
    };
    dialog.showOpenDialog = async () => ({
      canceled: globalThis.issuerTest.cancel,
      filePaths: [globalThis.issuerTest.open],
    });
    dialog.showSaveDialog = async () => ({
      canceled: globalThis.issuerTest.cancel,
      filePath: globalThis.issuerTest.save,
    });
  }, home);
  await page.getByLabel('口令', { exact: true }).fill(password);
  await page.getByLabel('确认口令', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建密钥库', exact: true }).click();
  await page.getByRole('button', { name: '保存客户', exact: true }).waitFor();
  await page.getByLabel('客户编号', { exact: true }).fill('UI-CUSTOMER');
  await page.getByLabel('客户名称', { exact: true }).fill('测试学校');
  await page.getByRole('button', { name: '保存客户', exact: true }).click();
  await page.getByText('操作完成', { exact: true }).waitFor();
  async function call(method, ...args) {
    const result = await page.evaluate(async ({ method, args }) => window.issuer[method](...args), {
      method,
      args,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  }
  await call('importRequest', 'UI-CUSTOMER');
  await call('setFloor', request.installationId, 0, '确认首次签发', true);
  const key = await call('createKey', 'test');
  await desktop.evaluate((_electron, home) => {
    globalThis.issuerTest.save = home + '/trust.json';
  }, home);
  // Native chooser adapter generates distinct files for trust and public key.
  await desktop.evaluate(({ dialog }, home) => {
    let n = 0;
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: home + (n++ === 0 ? '/trust.json' : '/public.json'),
    });
  }, home);
  await call('exportTrust', key.kid, '0.1.2');
  await desktop.evaluate((_electron, home) => {
    globalThis.issuerTest.open = home + '/trust.json';
  }, home);
  const pkg = await call('importTrust');
  await call('lock');
  await page.getByRole('button', { name: /^解\s*锁$/ }).waitFor();
  await page.getByLabel('口令', { exact: true }).fill('incorrect password 1234');
  await page.getByRole('button', { name: /^解\s*锁$/ }).click();
  await page.getByText('口令错误或密钥库损坏', { exact: true }).waitFor();
  await page.getByLabel('口令', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^解\s*锁$/ }).click();
  await page.getByRole('tab', { name: '新建授权', exact: true }).click();
  async function select(label, text) {
    await page.getByLabel(label, { exact: true }).click();
    await page.getByTitle(text, { exact: true }).last().click();
  }
  await select('客户申请', `UI-CUSTOMER · ${request.installationId} · 0.1.2`);
  await select('签名密钥', key.kid);
  await select('目标客户包信任清单', `0.1.2 · ${key.kid}`);
  await page.getByLabel('同时作答人数', { exact: true }).fill('30');
  await page.getByText('签发永久授权，并确认无到期时间', { exact: true }).click();
  await page.getByRole('button', { name: '预览授权', exact: true }).click();
  await page.getByText('本次签发为永久授权', { exact: true }).waitFor();
  await page.getByRole('button', { name: '确认签发', exact: true }).click();
  await page.getByText('授权已签发', { exact: true }).waitFor();
  const snapshot = await call('snapshot');
  assert.equal(snapshot.licenses.length, 1);
  await desktop.evaluate(({ dialog }, home) => {
    globalThis.issuerTest.save = home + '/license.mlic';
    dialog.showSaveDialog = async () => ({
      canceled: globalThis.issuerTest.cancel,
      filePath: globalThis.issuerTest.save,
    });
  }, home);
  await desktop.evaluate(() => {
    globalThis.issuerTest.cancel = true;
  });
  await page.getByRole('button', { name: '导出授权文件', exact: true }).click();
  assert.equal(existsSync(path.join(home, 'license.mlic')), false);
  await desktop.evaluate(() => {
    globalThis.issuerTest.cancel = false;
  });
  await page.getByRole('button', { name: '导出授权文件', exact: true }).click();
  await page.getByText('操作完成', { exact: true }).waitFor();
  assert.equal(
    JSON.parse(
      Buffer.from(
        JSON.parse(readFileSync(path.join(home, 'license.mlic'), 'utf8')).payload,
        'base64url',
      ),
    ).maxConcurrentAttempts,
    30,
  );
  await page.getByRole('button', { name: '导出授权文件', exact: true }).click();
  await page.getByText('文件已存在，请另选文件名', { exact: true }).waitFor();
  const security = await desktop.evaluate(
    async ({ BrowserWindow }, preload) => {
      const current = BrowserWindow.getAllWindows()[0];
      const prefs = current.webContents.getLastWebPreferences();
      const other = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      await other.loadURL(current.webContents.getURL());
      const result = await other.webContents.executeJavaScript('window.issuer.snapshot()');
      other.destroy();
      return {
        result,
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
      };
    },
    path.resolve(
      packaged
        ? 'artifacts/issuer-payload/resources/app.asar/dist/preload.js'
        : 'apps/issuer/dist/preload.js',
    ),
  );
  assert.deepEqual(security.result, { ok: false, code: 'IPC_DENIED' });
  assert.equal(security.sandbox, true);
  assert.equal(security.contextIsolation, true);
  assert.equal(security.nodeIntegration, false);
  await page.getByRole('tab', { name: '备份与恢复', exact: true }).click();
  await desktop.evaluate((_electron, home) => {
    globalThis.issuerTest.save = home + '/backup.missuer';
  }, home);
  await page.getByLabel('导出备份口令', { exact: true }).fill(password);
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  await page.getByText('操作完成', { exact: true }).waitFor();
  assert.equal(existsSync(path.join(home, 'backup.missuer')), true);
  await desktop.evaluate((_electron, home) => {
    globalThis.issuerTest.open = home + '/backup.missuer';
  }, home);
  await page.getByLabel('选择并恢复口令', { exact: true }).fill(password);
  await page.getByRole('button', { name: '选择并恢复', exact: true }).click();
  await page.getByRole('button', { name: /^确\s*定$/ }).click();
  await page.getByText('恢复后待核对，暂不能签发', { exact: true }).waitFor();
  await call('setFloor', request.installationId, 1, '恢复后核对已签发文件', false);
  await page.getByLabel('核对说明', { exact: true }).fill('已确认全部签发记录及序号');
  await page.getByRole('button', { name: '确认已核对所有实例', exact: true }).click();
  await page.getByText('操作完成', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '签发记录', exact: true }).click();
  await page.getByRole('button', { name: /^查\s*看$/ }).waitFor();
  await page.screenshot({ path: path.join(output, 'records.png'), fullPage: true });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(380, 720));
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true });
  await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await page.getByRole('button', { name: /^解\s*锁$/ }).waitFor();
  const locked = await page.evaluate(() => window.issuer.snapshot());
  assert.equal(locked.code, 'LOCKED');
  await page.getByLabel('口令', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^解\s*锁$/ }).click();
  await page.getByRole('tab', { name: '签发记录', exact: true }).waitFor();
  await desktop.evaluate(() => {
    globalThis.issuerOriginalNow = Date.now;
    const future = Date.now() + 600001;
    Date.now = () => future;
  });
  await page.getByRole('button', { name: /^解\s*锁$/ }).waitFor();
  await desktop.evaluate(() => {
    Date.now = globalThis.issuerOriginalNow;
  });
  assert.equal((await page.evaluate(() => window.issuer.snapshot())).code, 'LOCKED');
  assert.deepEqual(errors, []);
  assert.ok(pkg.id);
  console.log(
    `PASS ${packaged ? 'packaged ' : ''}issuer real Electron unlock, form signing, backup/restore, native chooser adapters, cancellation, overwrite denial, IPC, lock-screen, idle locking and narrow layout`,
  );
} catch (error) {
  if (desktop) {
    const page = await desktop.firstWindow();
    console.log(await page.locator('body').innerText());
    console.log(await page.evaluate(() => window.issuer.status()));
    await page
      .screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 })
      .catch(() => {});
  }
  throw error;
} finally {
  await desktop?.close();
  cleanup();
}
