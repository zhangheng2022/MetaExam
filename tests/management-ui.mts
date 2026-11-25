import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createApp } from '../apps/api/dist/app.js';
import { migrate, BootstrapRepository, digestToken } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
const t = await isolatedDatabase();
let app, browser;
try {
  await migrate(t.db);
  app = await createApp({ ...t.config, auth: { accountLimit: 100, ipLimit: 500 } });
  await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + app.getHttpServer().address().port;
  const token = randomBytes(32).toString('hex');
  await new BootstrapRepository(t.db).issue(digestToken(token), new Date(Date.now() + 60000), {
    requestId: 'management-ui',
  });
  const initialized = await fetch(base + '/api/v1/setup/administrator', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      displayName: '验收管理员',
      password: 'administrator phrase',
    }),
  });
  assert.equal(initialized.status, 201);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== base) external.push(r.url());
  });
  mkdirSync('artifacts/m1-management', { recursive: true });
  const login = async (username: string, password: string) => {
    await page.goto(base + '/login');
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
  };
  const dialog = () => page.getByRole('dialog');
  const save = async () => {
    await dialog()
      .getByRole('button', { name: /保\s*存/ })
      .click();
    await dialog().waitFor({ state: 'hidden' });
  };
  const choose = async (label: string, text: string) => {
    await dialog().getByLabel(label, { exact: true }).click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: text })
      .first()
      .click();
  };
  await login('admin', 'administrator phrase');
  await page.getByRole('heading', { name: '个人信息', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: '账号管理' }).click();
  for (const [username, displayName, role] of [
    ['student01', '学生甲', '学生'],
    ['teacher01', '教师甲', '教师'],
  ]) {
    await page.getByRole('button', { name: '创建账号' }).click();
    await dialog().getByLabel('用户名', { exact: true }).fill(username!);
    await dialog().getByLabel('姓名', { exact: true }).fill(displayName!);
    if (role === '教师') {
      await dialog().locator('.ant-select-selection-item-remove').click();
      await choose('角色', role);
      await dialog().getByLabel('姓名', { exact: true }).click();
    }
    await dialog().getByLabel('临时密码', { exact: true }).fill('temporary account phrase');
    await save();
    await page.getByRole('cell', { name: displayName!, exact: true }).waitFor();
  }
  await page.screenshot({ path: 'artifacts/m1-management/users-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'mobile list stays within viewport',
  );
  await page.screenshot({ path: 'artifacts/m1-management/users-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [menu, noun, code, name] of [
    ['班级管理', '班级', 'class01', '一年一班'],
    ['课程管理', '课程', 'math01', '数学'],
  ]) {
    await page.getByRole('menuitem', { name: menu! }).click();
    await page.getByRole('button', { name: '创建' + noun }).click();
    await dialog()
      .getByLabel(noun + '编码', { exact: true })
      .fill(code!);
    await dialog()
      .getByLabel(noun + '名称', { exact: true })
      .fill(name!);
    await save();
    await page.getByRole('cell', { name: name!, exact: true }).waitFor();
  }
  await page.getByRole('menuitem', { name: '班级管理' }).click();
  await page.getByRole('link', { name: '学生名单' }).click();
  await page.getByRole('button', { name: '添加学生' }).click();
  await choose('学生', '学生甲');
  await save();
  await page.getByRole('cell', { name: '学生甲', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: '授课安排' }).click();
  await page.getByRole('button', { name: '添加授课安排' }).click();
  await choose('课程', '数学');
  await choose('班级', '一年一班');
  await choose('教师', '教师甲');
  await save();
  await page.getByRole('cell', { name: '教师甲', exact: true }).waitFor();
  await page.screenshot({
    path: 'artifacts/m1-management/assignments-desktop.png',
    fullPage: true,
  });
  await page.getByRole('menuitem', { name: '操作日志' }).click();
  await page.getByRole('cell', { name: 'assignment.add', exact: true }).waitFor();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await login('student01', 'temporary account phrase');
  await page.getByText('首次登录或密码被重置，请先修改密码', { exact: true }).waitFor();
  await page.goto(base + '/users');
  await page.getByRole('heading', { name: '修改密码', exact: true }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: '账号管理' }).count(), 0);
  await page.getByLabel('原密码', { exact: true }).fill('temporary account phrase');
  await page.getByLabel('新密码', { exact: true }).fill('student personal phrase');
  await page.getByLabel('确认密码', { exact: true }).fill('student personal phrase');
  await page.getByRole('button', { name: '保存新密码' }).click();
  await page.getByRole('heading', { name: '登录 MetaExam' }).waitFor();
  await login('student01', 'student personal phrase');
  await page.getByRole('heading', { name: '工作台', exact: true }).waitFor();
  await page.getByRole('cell', { name: '数学', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/m1-management/student-desktop.png', fullPage: true });
  await page.goto(base + '/users');
  await page.getByText('没有访问权限', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  writeFileSync(
    'artifacts/m1-management/browser-results.json',
    JSON.stringify(
      {
        passed: true,
        checks: [
          'create accounts',
          'create organizations',
          'assign student',
          'assign teacher',
          'audit records',
          'forced password change',
          'student workspace and unauthorized route',
          'mobile containment',
          'no page exceptions or external requests',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS real management browser workflow, forced password change, role navigation, mobile and offline resources',
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: 'artifacts/m1-management/failure.png', fullPage: true });
    writeFileSync('artifacts/m1-management/failure.html', await page.content());
  }
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await t.close();
}
