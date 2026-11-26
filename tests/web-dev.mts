import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { questionFixture } from './questions-fixture.mts';

const webRoot = path.resolve('apps/web');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const t = await questionFixture();
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const errors: string[] = [];
mkdirSync('artifacts/web-dev', { recursive: true });
try {
  const backend = 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
  vite = await createServer({
    root: webRoot,
    configFile: path.join(webRoot, 'vite.config.ts'),
    cacheDir: path.join(t.config.home, 'vite-cache'),
    server: { port: 0, proxy: { '/api': backend, '/health': backend } },
  });
  await vite.listen();
  const base = 'http://127.0.0.1:' + vite.httpServer!.address().port;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/login');
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill(t.password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.getByRole('menuitem', { name: '题库管理' }).click();
  await page.getByRole('button', { name: '创建题库', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '创建题库', exact: true }).waitFor();
  const bank = await t.create('/question-banks', {
    name: '开发模式题库',
    courseId: t.courseId,
    visibility: 'public',
  });
  await page.goto(base + '/question-banks/' + bank);
  await page.getByRole('button', { name: '录入题目', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('题干', { exact: true }).fill('Vite 开发模式题目');
  await dialog.getByLabel('选项 A', { exact: true }).fill('甲');
  await dialog.getByLabel('选项 B', { exact: true }).fill('乙');
  await dialog.getByLabel('正确答案', { exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: 'A.' })
    .click();
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith('/question-banks/' + bank + '/questions') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: /保\s*存/ }).click();
  assert.equal((await saved).status(), 201);
  await dialog.waitFor({ state: 'hidden' });
  await page.screenshot({ path: 'artifacts/web-dev/questions.png', fullPage: true });
  // These lazy routes also import runtime schemas from the shared contracts.
  for (const [route, action] of [
    ['papers', '创建试卷'],
    ['exams', '创建考试'],
  ] as const) {
    await page.goto(base + '/' + route);
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.getByRole('dialog').waitFor();
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    'artifacts/web-dev/results.json',
    JSON.stringify(
      {
        passed: true,
        errors,
        checks: [
          'cold Vite cache',
          'real login',
          'question route + reload',
          'question editor validation + save',
          'paper + exam lazy routes',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS Vite cold-cache login, question route/refresh/save, paper and exam lazy routes',
  );
} catch (e) {
  console.error('Browser errors: ' + JSON.stringify(errors));
  throw e;
} finally {
  await browser?.close();
  await vite?.close();
  await t.close();
}
