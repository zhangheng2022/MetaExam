import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(import.meta.dirname, '..'),
  port = 3302;
const config = JSON.parse(readFileSync(path.join(root, '.local/config.json'), 'utf8'));
const conf = path.join(root, '.local/ui-config.json');
writeFileSync(conf, JSON.stringify({ ...config, api: { ...config.api, port } }));
const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
  cwd: root,
  env: { ...process.env, METAEXAM_CONFIG: conf },
  stdio: 'ignore',
  windowsHide: true,
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:' + port + '/health/ready')).ok) {
        ready = true;
        break;
      }
    } catch {
      /* boot */
    }
    await delay(250);
  }
  assert.ok(ready, 'API ready');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const output = path.join(root, '.impeccable/review');
  mkdirSync(output, { recursive: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/v1/system/status', (route) => route.abort());
  await page.goto('http://127.0.0.1:' + port);
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByText('无法获取', { exact: true }).count(), 3);
  assert.ok(await page.getByText('尚未获取检查结果', { exact: true }).isVisible());
  await page.screenshot({ path: path.join(output, 'initial-error.png'), fullPage: true });
  await page.unroute('**/api/v1/system/status');
  await page.goto('http://127.0.0.1:' + port);
  await page.getByText('本地数据库', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重新检查' }).waitFor();
  assert.ok(await page.getByRole('heading', { name: '运行概览', exact: true }).isVisible());
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'no horizontal overflow',
  );
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  await page.route('**/api/v1/system/status', (route) => route.abort());
  await page.getByRole('button', { name: '重新检查' }).click();
  await page.getByRole('alert').waitFor();
  assert.ok(
    await page
      .getByRole('alert')
      .innerText()
      .then((t) => t.includes('上次检查结果')),
  );
  await page.screenshot({ path: path.join(output, 'error.png'), fullPage: true });
  await page.unroute('**/api/v1/system/status');
  await page.getByRole('button', { name: '重新检查' }).click();
  await page.getByRole('button', { name: '重新检查' }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(root, 'artifacts/ui-results.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        checks: [
          'initial failure is not shown as loading',
          'desktop status',
          'mobile 390px no overflow',
          'connection failure and stale data',
          'retry recovery',
          'no page JavaScript errors',
        ],
      },
      null,
      2,
    ),
  );
  console.log('UI_CHECKS_PASSED');
} finally {
  await browser?.close();
  if (child.pid && child.exitCode === null)
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
}
