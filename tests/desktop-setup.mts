import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../apps/api/dist/app.js';
import { migrate } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
import type { DiagnosticBridge } from '@metaexam/contracts';
const t = await isolatedDatabase(),
  home = mkdtempSync(path.join(tmpdir(), 'MetaExam-desktop-test-'));
let api, desktop;
try {
  await migrate(t.db);
  api = await createApp(t.config);
  await api.listen(0, '127.0.0.1');
  const port = api.getHttpServer().address().port,
    config = path.join(home, 'config.json');
  writeFileSync(config, JSON.stringify({ ...t.config, home, api: { ...t.config.api, port } }));
  desktop = await electron.launch({
    executablePath: path.resolve('apps/desktop/node_modules/electron/dist/electron.exe'),
    args: ['apps/desktop'],
    env: { ...process.env, METAEXAM_CONFIG: config, METAEXAM_DESKTOP_SMOKE: '' },
  });
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: '初始化管理员', exact: true }).waitFor();
  const exposed = await page.evaluate(() =>
    Object.keys((window as unknown as { metaexam: object }).metaexam),
  );
  assert.deepEqual(exposed.sort(), [
    'cancelLicenseImport',
    'cancelRestore',
    'checkDiagnostics',
    'confirmLicenseImport',
    'confirmRestore',
    'copyBusinessAddress',
    'createAdministrator',
    'createBackup',
    'exportDiagnostics',
    'exportLicenseRequest',
    'openBusiness',
    'previewLicenseImport',
    'previewRestore',
    'recoverRestore',
    'setupStatus',
    'status',
  ]);
  const diagnostic = await page.evaluate(() =>
    (window as unknown as { metaexam: DiagnosticBridge }).metaexam.checkDiagnostics(),
  );
  assert.equal(diagnostic.status, 'success');
  if (diagnostic.status === 'success') {
    assert.equal(diagnostic.value.checks.live.state, 'ok');
    assert.equal(diagnostic.value.checks.ready.state, 'ok');
    assert.equal(diagnostic.value.checks.system.state, 'ok');
    assert.equal(diagnostic.value.system.adminInitialized, false);
    assert.equal(diagnostic.value.system.license, 'unactivated');
  }
  const licenseDenied = await page.evaluate(async () => {
    const bridge = (
      window as unknown as {
        metaexam: {
          exportLicenseRequest(): Promise<{ status: string; code: string }>;
          previewLicenseImport(): Promise<{ status: string; code: string }>;
        };
      }
    ).metaexam;
    return [await bridge.exportLicenseRequest(), await bridge.previewLicenseImport()];
  });
  assert.deepEqual(
    licenseDenied,
    Array(2).fill({ status: 'error', code: 'ADMINISTRATOR_REQUIRED' }),
  );
  await page.getByLabel('用户名', { exact: true }).fill('desktop_admin');
  await page.getByLabel('姓名', { exact: true }).fill('桌面管理员');
  await page.getByLabel('密码', { exact: true }).fill('desktop password phrase');
  await page.getByLabel('确认密码', { exact: true }).fill('desktop password phrase');
  await page.getByRole('button', { name: '创建管理员', exact: true }).click();
  await page
    .getByText('请关闭客户端，右键选择“以管理员身份运行”后重试。', { exact: true })
    .waitFor();
  assert.equal(existsSync(path.join(home, 'bootstrap/token.json')), false);
  assert.equal((await t.db.pool.query('SELECT count(*) FROM users')).rows[0].count, '0');
  await desktop.close();
  desktop = undefined;
  assert.equal((await fetch('http://127.0.0.1:' + port + '/health/ready')).status, 200);
  console.log('PASS real Electron wizard, limited IPC, non-elevated rejection and API survival');
} finally {
  await desktop?.close();
  await api?.close();
  await t.close();
  if (
    path.dirname(home) === path.resolve(tmpdir()) &&
    path.basename(home).startsWith('MetaExam-desktop-test-')
  )
    rmSync(home, { recursive: true, force: true });
}
