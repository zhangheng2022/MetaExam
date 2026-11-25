import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApp } from '../apps/api/dist/app.js';
import { migrate, BootstrapRepository, digestToken } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
const t = await isolatedDatabase();
let app, browser;
try {
  await migrate(t.db);
  app = await createApp(t.config);
  await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + app.getHttpServer().address().port;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  mkdirSync('artifacts/m1', { recursive: true });
  const cspViolations: string[] = [];
  const externalRequests: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error('CSP_VIOLATION:' + event.violatedDirective);
    });
  });
  page.on('console', (message) => {
    if (message.text().startsWith('CSP_VIOLATION:')) cspViolations.push(message.text());
  });
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== base) externalRequests.push(request.url());
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/login');
  await page.getByText('系统尚未初始化', { exact: true }).waitFor();
  const token = randomBytes(32).toString('hex');
  await new BootstrapRepository(t.db).issue(digestToken(token), new Date(Date.now() + 60000), {
    requestId: 'browser-test',
  });
  const setup = await fetch(base + '/api/v1/setup/administrator', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      displayName: '浏览器测试管理员',
      password: 'browser password phrase',
    }),
  });
  assert.equal(setup.status, 201);
  await page.reload();
  await page.getByLabel('用户名', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/m1/login-desktop.png', fullPage: true });
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.getByText('账号或密码错误', { exact: true }).waitFor();
  const login = async (password: string) => {
    await page.getByLabel('用户名', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.getByRole('heading', { name: '个人信息', exact: true }).waitFor();
  };
  await login('browser password phrase');
  await page.reload();
  await page.getByRole('heading', { name: '个人信息', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.equal(await page.evaluate(() => document.cookie), '');
  await page.getByRole('button', { name: '查看管理概览' }).click();
  await page.getByText('账号数', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: 'artifacts/m1/profile-desktop.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'artifacts/m1/profile-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('dialog').getByRole('menuitem', { name: '账号安全' }).click();
  await page.getByRole('heading', { name: '修改密码', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.screenshot({ path: 'artifacts/m1/password-mobile.png', fullPage: true });
  await page.getByRole('link', { name: '返回个人信息' }).click();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route('**/api/v1/auth/me', (r) =>
    r.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'DATABASE_UNAVAILABLE',
        message: '数据库暂时不可用，请稍后重试。',
        requestId: 'browser-outage',
      }),
    }),
  );
  await page.getByRole('button', { name: '刷新个人信息' }).click();
  await page.getByRole('heading', { name: '服务暂时不可用' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  await page.unroute('**/api/v1/auth/me');
  await page.getByRole('button', { name: /重\s*试/ }).click();
  await page.getByRole('heading', { name: '个人信息', exact: true }).waitFor();
  await page.getByRole('link', { name: '修改密码', exact: true }).click();
  await page.getByLabel('原密码', { exact: true }).fill('browser password phrase');
  await page.getByLabel('新密码', { exact: true }).fill('changed browser phrase');
  await page.getByLabel('确认密码', { exact: true }).fill('changed browser phrase');
  await page.getByRole('button', { name: '保存新密码' }).click();
  await page.getByText('密码已修改，请重新登录。', { exact: true }).waitFor();
  await login('changed browser phrase');
  await t.db.pool.query('DELETE FROM auth_sessions');
  await page.getByRole('button', { name: '刷新个人信息' }).click();
  await page.getByRole('heading', { name: '登录 MetaExam' }).waitFor();
  await login('changed browser phrase');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '登录 MetaExam' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(
    await page.locator('.ant-btn-primary').evaluate((e) => getComputedStyle(e).backgroundColor),
    'rgb(22, 119, 255)',
  );
  mkdirSync('artifacts/m1', { recursive: true });
  await page.screenshot({ path: 'artifacts/m1/login-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(cspViolations, []);
  assert.deepEqual(externalRequests, []);
  writeFileSync(
    'artifacts/m1/browser-results.json',
    JSON.stringify({
      passed: true,
      checks: [
        'setup guidance',
        'wrong password',
        'real login and reload',
        'HttpOnly and no localStorage',
        'protected overview',
        '503 retry without logout',
        'password change',
        'session expiry',
        'logout',
        'mobile and default blue',
        'responsive profile and mobile navigation',
        'no CSP violations or external resources',
        'no browser exceptions',
      ],
    }),
  );
  console.log('PASS browser identity lifecycle, 503 recovery, expiry, mobile and default blue');
} finally {
  await browser?.close();
  await app?.close();
  await t.close();
}
