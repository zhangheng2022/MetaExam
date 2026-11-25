import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { questionFixture } from './questions-fixture.mts';
import { IMPORT_HEADERS } from '../packages/db/dist/file-processor.js';
const require = createRequire(path.resolve('packages/db/package.json'));
const Excel = require('exceljs'),
  sharp = require('sharp');
const t = await questionFixture();
const configFile = path.join(t.config.home, 'worker.json');
writeFileSync(configFile, JSON.stringify(t.config));
const worker = spawn(process.execPath, ['apps/worker/dist/main.js'], {
  env: { ...process.env, METAEXAM_CONFIG: configFile },
  stdio: 'pipe',
  windowsHide: true,
});
let browser;
mkdirSync('artifacts/m2-imports', { recursive: true });
try {
  const bank = await t.create('/question-banks', {
    name: '图片与导入验收',
    courseId: t.courseId,
    visibility: 'public',
  });
  const base = 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
  const book = new Excel.Workbook();
  const sheet = book.addWorksheet('题目');
  sheet.addRows([
    IMPORT_HEADERS,
    [
      '判断',
      '零是偶数',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '正确',
      '偶数定义',
      2,
      '整数',
      '基础',
      '',
      '',
    ],
  ]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== base && !r.url().startsWith('blob:')) external.push(r.url());
  });
  try {
    await page.goto(base + '/login');
    await page.getByLabel('用户名', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill(t.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.getByRole('menuitem', { name: '个人信息' }).waitFor();
    await page.goto(base + '/question-banks/' + bank);
    const open = async () => {
      await page.getByRole('button', { name: 'Excel 导入与记录' }).click();
    };
    const drawer = () => page.getByRole('dialog', { name: 'Excel 题目导入', exact: true });
    const close = async () => {
      await drawer()
        .getByRole('button', { name: /^(Close|关闭)$/ })
        .click();
      await drawer().waitFor({ state: 'hidden' });
    };
    const upload = async (buffer: Buffer, name: string) => {
      await drawer().locator('input[type=file]').setInputFiles({
        name,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer,
      });
    };
    await open();
    const download = page.waitForEvent('download');
    await drawer().getByRole('button', { name: '下载 Excel 模板' }).click();
    assert.equal((await download).suggestedFilename(), 'MetaExam-questions-template.xlsx');
    await upload(bytes, '正确模板.xlsx');
    await drawer().getByText('预检完成，请核对题目再确认', { exact: true }).waitFor();
    await drawer().getByRole('button', { name: '预览题目' }).click();
    const preview = page.getByRole('dialog', { name: '导入题目预览', exact: true });
    await preview.getByText('零是偶数', { exact: true }).waitFor();
    await preview.getByRole('button', { name: /^(Close|关闭)$/ }).click();
    await page.screenshot({ path: 'artifacts/m2-imports/preflight-desktop.png', fullPage: true });
    await page.route('**/imports/*/confirm', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'SERVICE_UNAVAILABLE',
          message: '服务暂时不可用，请重试。',
          requestId: 'ui-test',
        }),
      }),
    );
    await drawer().getByRole('button', { name: '确认导入', exact: true }).click();
    await drawer().getByText('服务暂时不可用，请重试。', { exact: true }).waitFor();
    await page.unroute('**/imports/*/confirm');
    await page.waitForResponse(
      (r) => r.request().method() === 'GET' && r.url().includes('/imports/') && r.ok(),
    );
    assert.equal(
      await drawer().getByText('服务暂时不可用，请重试。', { exact: true }).isVisible(),
      true,
      'successful polling must not erase the failed action',
    );
    await drawer().getByRole('button', { name: '确认导入', exact: true }).click();
    await drawer().getByText('导入完成：新增 1 题，跳过 0 题', { exact: true }).waitFor();
    await close();
    await page.getByRole('cell', { name: '零是偶数', exact: true }).waitFor();
    await open();
    await upload(bytes, '重复题.xlsx');
    await drawer().getByText('预检完成，请核对题目再确认', { exact: true }).waitFor();
    await drawer().getByRole('cell', { name: '重复题', exact: true }).waitFor();
    await drawer().getByRole('button', { name: '确认导入', exact: true }).click();
    await drawer().getByText('导入完成：新增 0 题，跳过 1 题', { exact: true }).waitFor();
    sheet.getCell('K2').value = '不正确的答案';
    await upload(Buffer.from(await book.xlsx.writeBuffer()), '错误题.xlsx');
    await drawer().getByText('存在错误，请修正 Excel 后重新上传', { exact: true }).waitFor();
    assert.equal(
      await drawer().getByRole('button', { name: '确认导入', exact: true }).isDisabled(),
      true,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/m2-imports/error-mobile.png', fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await close();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: '零是偶数', exact: true }) });
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    const edit = page.getByRole('dialog');
    const image = await sharp({
      create: { width: 320, height: 180, channels: 3, background: '#1677ff' },
    })
      .png()
      .toBuffer();
    await edit
      .locator('input[type=file]')
      .setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: image });
    await edit.getByLabel('图片 1 说明', { exact: true }).fill('蓝色示意图');
    await edit.getByRole('button', { name: /保\s*存/ }).click();
    await edit.waitFor({ state: 'hidden' });
    await row.getByRole('button', { name: '预览与历史' }).click();
    const history = page.getByRole('dialog');
    const img = history.getByRole('img', { name: '蓝色示意图', exact: true });
    await img.waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('img.question-image')].some(
        (i) => (i as HTMLImageElement).naturalWidth === 320,
      ),
    );
    await page.screenshot({ path: 'artifacts/m2-imports/image-history.png', fullPage: true });
    assert.equal(worker.exitCode, null);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(
      'PASS real Worker, template download, browser preflight/preview/confirm/duplicate/error, mobile layout and authenticated image history',
    );
  } catch (e) {
    await page.screenshot({ path: 'artifacts/m2-imports/failure.png', fullPage: true });
    writeFileSync('artifacts/m2-imports/failure.txt', await page.locator('body').innerText());
    throw e;
  }
} finally {
  await browser?.close();
  if (worker.pid && worker.exitCode === null)
    execFileSync('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  await t.close();
}
