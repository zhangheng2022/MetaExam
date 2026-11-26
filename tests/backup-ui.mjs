import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { createApp } from '../apps/api/dist/app.js';
import { BootstrapRepository, digestToken, createDatabase } from '../packages/db/dist/index.js';
import { licenseManagerFixture } from './license-manager-fixture.mts';
const t = await licenseManagerFixture(),
  output = path.resolve('artifacts/backup');
const destination = mkdtempSync(path.join(tmpdir(), 'MetaExam-backup-ui-'));
mkdirSync(output, { recursive: true });
let api, desktop;
try {
  const bootstrap = new BootstrapRepository(t.db),
    token = randomBytes(32).toString('hex');
  await bootstrap.issue(digestToken(token), new Date(Date.now() + 60000), {
    requestId: 'backup-ui',
  });
  await bootstrap.create(
    { username: 'backup_admin', displayName: '备份管理员', password: 'unused' },
    token,
    'test-only',
    { requestId: 'backup-ui' },
  );
  await t.db.pool.end();
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
  await page.getByText('备份与恢复', { exact: true }).click();
  await page.getByRole('button', { name: '创建备份', exact: true }).click();
  await page.getByText('请以管理员身份运行本地管理器。', { exact: true }).waitFor();
  assert.deepEqual(
    await desktop.evaluate(async ({ BrowserWindow }, preload) => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      try {
        await other.loadURL('data:text/html,<p>Untrusted</p>');
        return await other.webContents.executeJavaScript(
          `Promise.all([window.metaexam.createBackup(),window.metaexam.previewRestore(),window.metaexam.confirmRestore('fake'),window.metaexam.cancelRestore('fake'),window.metaexam.recoverRestore()].map(p=>p.then(()=> 'allowed',()=> 'denied')))`,
        );
      } finally {
        other.destroy();
      }
    }, path.resolve('apps/desktop/dist/preload.js')),
    ['denied', 'denied', 'denied', 'denied', 'denied'],
  );
  // The test replaces elevation and native choosers only. Production engine, IPC bridge and UI remain real.
  await desktop.evaluate(
    ({ ipcMain }, input) => {
      const require = process
        .getBuiltinModule('node:module')
        .createRequire(input.root + '/package.json');
      const { BackupService } = require(input.root + '/packages/db/dist/index.js');
      const { BackupOperations } = require(input.root + '/apps/desktop/dist/backup-operations.js');
      const service = new BackupService(input.config, {
        key: Buffer.from(input.key, 'hex'),
        bin: input.root + '/.tools/pgsql/bin',
        runtimeRole: input.config.database.user,
        secureDirectory: async () => {},
      });
      globalThis.backupUi = { directory: input.destination };
      const ops = new BackupOperations({
        authorize: async () => {},
        choose: async () => globalThis.backupUi.directory,
        run: async (input) =>
          input.operation === 'create'
            ? service.create(input.directory)
            : input.operation === 'preview'
              ? service.preview(input.directory)
              : input.operation === 'restore'
                ? service.restore(input.directory, input.id)
                : service.recover(),
      });
      for (const channel of ['create', 'preview', 'confirm', 'cancel', 'recover'])
        ipcMain.removeHandler('backup:' + channel);
      ipcMain.handle('backup:create', () => ops.create());
      ipcMain.handle('backup:preview', () => ops.preview());
      ipcMain.handle('backup:confirm', (_event, id) => ops.confirm(id));
      ipcMain.handle('backup:cancel', (_event, id) => ops.cancel(id));
      ipcMain.handle('backup:recover', () => ops.recover());
    },
    {
      root: path.resolve('.'),
      config: t.config,
      key: randomBytes(32).toString('hex'),
      destination,
    },
  );
  await page.getByRole('button', { name: '创建备份', exact: true }).click();
  await page
    .getByText('请先停止考试服务、后台任务及其他维护命令，再重试。数据库需保持运行。', {
      exact: true,
    })
    .waitFor();
  await api.close();
  api = undefined;
  await page.getByRole('button', { name: '创建备份', exact: true }).click();
  await page.getByText('备份已保存到所选位置。请妥善保管完整文件夹。', { exact: true }).waitFor();
  const folder = path.join(
    destination,
    readdirSync(destination).find((name) => name.endsWith('.mbackup')),
  );
  const changed = createDatabase(t.config);
  try {
    await changed.pool.query("UPDATE users SET display_name='备份之后修改'");
  } finally {
    await changed.pool.end();
  }
  await desktop.evaluate((_electron, directory) => {
    globalThis.backupUi.directory = directory;
  }, folder);
  await page.getByRole('button', { name: '恢复备份', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: path.join(output, 'preview.png'), fullPage: true });
  await page.getByRole('button', { name: '取消恢复', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const unchanged = createDatabase(t.config);
  try {
    assert.equal(
      (await unchanged.pool.query('SELECT display_name FROM users')).rows[0].display_name,
      '备份之后修改',
    );
  } finally {
    await unchanged.pool.end();
  }
  await page.getByRole('button', { name: '恢复备份', exact: true }).click();
  await page.getByRole('button', { name: '确认恢复', exact: true }).click();
  await page
    .getByText('恢复完成，请重新启动服务。所有用户需要重新登录。', { exact: true })
    .waitFor();
  const restored = createDatabase(t.config);
  try {
    assert.equal(
      (await restored.pool.query('SELECT display_name FROM users')).rows[0].display_name,
      '备份管理员',
    );
  } finally {
    await restored.pool.end();
  }
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(420, 700));
  await page.getByRole('button', { name: '恢复备份', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true });
  await page.getByRole('button', { name: '取消恢复', exact: true }).click();
  assert.deepEqual(errors, []);
  writeFileSync(
    path.join(output, 'results.json'),
    JSON.stringify({
      elevationDenied: true,
      foreignFrameDenied: true,
      runningApiDenied: true,
      backupCreated: true,
      cancelPreservesData: true,
      restoreConfirmed: true,
      narrowNoOverflow: true,
    }),
  );
  console.log(
    'PASS real Electron backup, preflight/cancel/restore, unelevated/foreign-frame denial and narrow layout',
  );
} finally {
  await desktop?.close();
  await api?.close();
  const { Pool } = createRequire(path.resolve('packages/db/package.json'))('pg');
  const owner = new Pool({ ...t.config.database, database: 'postgres' });
  try {
    for (const name of readdirSync(t.config.home)) {
      const match = /^restore-([a-f0-9-]{36})$/.exec(name);
      if (!match) continue;
      const suffix = match[1].replaceAll('-', '');
      assert.match(suffix, /^[a-f0-9]{32}$/);
      for (const prefix of ['metaexam_old_', 'metaexam_restore_'])
        await owner.query('DROP DATABASE IF EXISTS ' + prefix + suffix + ' WITH (FORCE)');
    }
  } finally {
    await owner.end();
    await t.close();
  }
  if (
    path.dirname(destination) === path.resolve(tmpdir()) &&
    path.basename(destination).startsWith('MetaExam-backup-ui-')
  )
    rmSync(destination, { recursive: true, force: true });
}
