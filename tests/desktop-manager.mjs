import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// Deterministic UI states over real Electron IPC. Real API, ACL denial and database
// isolation are covered separately by desktop-setup.mts; no development accounts used.
const home = mkdtempSync(path.join(tmpdir(), 'MetaExam-manager-ui-'));
const output = path.resolve('artifacts/local-manager');
mkdirSync(output, { recursive: true });
let failure = true,
  setupFailure = false,
  hold = true;
const waiting = [];
const status = {
  product: 'MetaExam',
  version: '0.1.0',
  initialized: true,
  adminInitialized: false,
  database: 'ready',
  schemaVersion: 10,
  worker: 'online',
  checkedAt: new Date().toISOString(),
  license: { state: 'unactivated', expiresAt: null, maxConcurrentAttempts: null, features: [] },
  stage: 'phase1',
};
const server = createServer((request, response) => {
  const respond = () => {
    const isSetup = request.url === '/api/v1/setup/status';
    response.writeHead(failure || (isSetup && setupFailure) ? 503 : 200, {
      'Content-Type': 'application/json',
    });
    response.end(
      JSON.stringify(
        failure || (isSetup && setupFailure)
          ? { code: 'DATABASE_UNAVAILABLE' }
          : isSetup
            ? { database: status.database, adminInitialized: status.adminInitialized }
            : status,
      ),
    );
  };
  if (hold) waiting.push(respond);
  else respond();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
writeFileSync(path.join(home, 'config.json'), JSON.stringify({ api: { port } }));
let desktop;
try {
  desktop = await electron.launch({
    executablePath: path.resolve('apps/desktop/node_modules/electron/dist/electron.exe'),
    args: ['apps/desktop', '--user-data-dir=' + path.join(home, 'profile')],
    env: {
      ...process.env,
      METAEXAM_CONFIG: path.join(home, 'config.json'),
      METAEXAM_WEB_PORT: '5179',
      METAEXAM_DESKTOP_SMOKE: '',
    },
  });
  const page = await desktop.firstWindow();
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('正在检查服务', { exact: true }).waitFor();
  await page.locator('.product-brand').first().waitFor();
  assert.ok(
    await page.locator('.product-brand').first().getByText('元考', { exact: true }).isVisible(),
  );
  await page
    .locator('.product-brand img')
    .first()
    .evaluate(async (image) => {
      await image.decode();
      if (!image.naturalWidth) throw new Error('Brand image failed to load');
    });

  assert.equal(await page.getByLabel('用户名', { exact: true }).count(), 0);
  hold = false;
  waiting.splice(0).forEach((respond) => respond());
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByLabel('用户名', { exact: true }).count(), 0);
  await page.screenshot({ path: path.join(output, 'unavailable.png') });
  const refresh = async () => {
    await page.getByRole('button', { name: '检查状态', exact: true }).click();
    await page.locator('.local-manager-header button:not([disabled])').waitFor();
  };
  failure = false;
  status.database = 'unavailable';
  setupFailure = true;
  await refresh();
  await page.getByText('数据库暂时不可用，请检查服务后重试。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('用户名', { exact: true }).count(), 0);
  status.database = 'ready';
  setupFailure = false;
  await refresh();
  await page.getByRole('heading', { name: '初始化管理员', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'setup.png'), fullPage: true });

  // Simulate creation outcomes for UI only; do not elevate or generate a token.
  await desktop.evaluate(({ ipcMain, shell, clipboard }) => {
    globalThis.managerTest = {
      setupCode: 'SETUP_TOKEN_INVALID',
      copied: '',
      copyFails: false,
      opened: '',
      openFails: true,
    };
    ipcMain.removeHandler('setup:create');
    ipcMain.handle('setup:create', () =>
      globalThis.managerTest.setupCode
        ? { ok: false, code: globalThis.managerTest.setupCode }
        : { ok: true },
    );
    shell.openExternal = async (url) => {
      globalThis.managerTest.opened = url;
      if (globalThis.managerTest.openFails) throw new Error('TEST_OPEN_FAILED');
    };
    // Keep the user's clipboard unchanged while testing the actual fixed-address handler.
    clipboard.writeText = (value) => {
      if (globalThis.managerTest.copyFails) throw new Error('TEST_COPY_FAILED');
      globalThis.managerTest.copied = value;
    };
  });
  const fillAndSubmit = async () => {
    await page.locator('button[type="submit"]:not([disabled]):not(.ant-btn-loading)').waitFor();
    await page.getByLabel('用户名', { exact: true }).fill('test_admin');
    await page.getByLabel('姓名', { exact: true }).fill('测试管理员');
    await page.getByLabel('密码', { exact: true }).fill('test password phrase');
    await page.getByLabel('确认密码', { exact: true }).fill('test password phrase');
    await page.getByRole('button', { name: '创建管理员', exact: true }).click();
  };
  await fillAndSubmit();
  await page.getByText('初始化已过期，请重新打开客户端。', { exact: true }).waitFor();
  await desktop.evaluate(() => {
    globalThis.managerTest.setupCode = '';
  });
  await fillAndSubmit();
  await page.getByText('管理员已创建', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回概览', exact: true }).click();
  await refresh(); // An old uninitialized response must not reopen consumed setup.
  assert.equal(await page.getByLabel('用户名', { exact: true }).count(), 0);
  assert.equal(await page.getByText('管理员已创建', { exact: true }).count(), 0);
  status.adminInitialized = true;
  await page.reload();
  await page.getByText('服务正常', { exact: true }).waitFor();
  assert.equal(await page.getByText('管理员已创建', { exact: true }).count(), 0);
  assert.equal(await page.locator('.ant-btn-primary').count(), 1);
  assert.equal(
    await page
      .locator('.ant-btn-primary')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(22, 119, 255)',
  );
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
    'normal overview fits default window',
  );
  await page.screenshot({ path: path.join(output, 'overview.png') });
  await page.getByRole('button', { name: '打开考试系统', exact: true }).click();
  await page.getByText('无法打开浏览器，请复制登录地址后手动访问。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '复制登录地址', exact: true }).click();
  await page.getByRole('button', { name: '已复制登录地址', exact: true }).waitFor();
  assert.equal(
    await desktop.evaluate(() => globalThis.managerTest.copied),
    'http://127.0.0.1:5179/login',
  );
  await desktop.evaluate(() => {
    globalThis.managerTest.openFails = false;
  });
  await page.getByRole('button', { name: '打开考试系统', exact: true }).click();
  assert.equal(
    await desktop.evaluate(() => globalThis.managerTest.opened),
    'http://127.0.0.1:5179/login',
  );
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '运行详情' }).click();
  await desktop.evaluate(() => {
    globalThis.managerTest.copyFails = true;
  });
  await page.getByRole('button', { name: '已复制登录地址', exact: true }).click();
  await page.getByText('复制失败，请重试。', { exact: true }).waitFor();
  await desktop.evaluate(() => {
    globalThis.managerTest.copyFails = false;
  });
  await page.getByRole('button', { name: '复制登录地址', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '运行详情' }).click();

  status.worker = 'offline';
  await refresh();
  await page
    .locator('.local-manager-summary')
    .getByText('后台任务未运行', { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole('button', { name: '打开考试系统', exact: true }).isEnabled(),
    true,
  );
  status.worker = 'online';
  status.license = {
    state: 'valid',
    expiresAt: '2027-11-26T00:00:00.000Z',
    maxConcurrentAttempts: 100,
    features: ['exam.core'],
  };
  await refresh();
  await page.getByText('100 人', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'licensed.png') });
  status.license.state = 'expired';
  await refresh();
  await page.getByText('授权已到期', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '打开考试系统', exact: true }).isEnabled(),
    true,
  );
  failure = true;
  await refresh();
  await page.getByText('以下为上次检查结果，可能已过时。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '运行详情' }).click();
  await page.getByText('已完成', { exact: true }).waitFor();
  failure = false;
  await refresh();
  assert.equal(await page.getByRole('alert').count(), 0);

  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(380, 600));
  await page.waitForFunction(() => innerWidth < 400);
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'narrow window has no horizontal overflow',
  );
  await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true });
  await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1000, 720);
    window.webContents.setZoomFactor(1.5);
  });
  await page.waitForFunction(() => innerWidth > 400 && innerWidth < 700);
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    '150% content scaling has no horizontal overflow',
  );
  await page.screenshot({ path: path.join(output, 'scaled.png'), fullPage: true });

  assert.equal(
    await desktop.evaluate(async ({ BrowserWindow }, preload) => {
      const main = BrowserWindow.getAllWindows()[0];
      const prefs = main.webContents.getLastWebPreferences();
      if (!prefs.sandbox || !prefs.contextIsolation || prefs.nodeIntegration)
        return 'UNSAFE_PREFERENCES';
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      try {
        await foreign.loadURL('data:text/html,<p>Untrusted frame</p>');
        return await foreign.webContents.executeJavaScript(
          "window.metaexam.copyBusinessAddress().then(() => 'ALLOWED', () => 'DENIED')",
        );
      } finally {
        foreign.destroy();
      }
    }, path.resolve('apps/desktop/dist/preload.js')),
    'DENIED',
    'foreign renderer cannot invoke copy-address IPC',
  );
  assert.deepEqual(errors, []);
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  await desktop.close();
  desktop = undefined;
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/system/status`)).status, 200);
  writeFileSync(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks: [
          'initial loading and failure',
          'database failure never opens setup',
          'setup recovery and expired token feedback',
          'success only once and no reopening',
          'unactivated and expired licenses keep business entry',
          'fixed business address open and copy',
          'worker offline',
          'stale data and recovery',
          'default/narrow/scaled layouts',
          'restricted IPC and sandbox',
          'window exit leaves server alive',
        ],
        limitations: [
          'setup success simulated; real elevation/ACL remains an independent environment check',
          '150% Electron content zoom is not a physical Windows DPI check',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS Electron manager states, fixed-address IPC, responsive layouts and server survival',
  );
} catch (error) {
  const page = desktop && (await desktop.firstWindow());
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  await desktop?.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setZoomFactor(1);
  });
  await desktop?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (
    path.dirname(home) === path.resolve(tmpdir()) &&
    path.basename(home).startsWith('MetaExam-manager-ui-')
  )
    rmSync(home, { recursive: true, force: true });
}
