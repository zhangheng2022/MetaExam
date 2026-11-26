import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';
import { reportFixture } from './reports-fixture.mts';
const ExcelJS = createRequire(path.resolve('packages/db/package.json'))('exceljs');
const t = await reportFixture(),
  base = 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
let browser;
mkdirSync('artifacts/m2-reports', { recursive: true });
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    }),
    page = await context.newPage();
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!r.url().startsWith('blob:') && new URL(r.url()).origin !== base) external.push(r.url());
  });
  try {
    await page.goto(base + '/login');
    await page.getByLabel('用户名', { exact: true }).fill('teacher');
    await page.getByLabel('密码', { exact: true }).fill(t.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.getByRole('button', { name: '退出登录' }).waitFor();
    await page.goto(base + `/exams/${t.examId}/grading`);
    await page.getByRole('link', { name: '成绩统计与导出' }).click();
    await page.getByText('名单 3 人 · 实考 2 人 · 缺考 1 人', { exact: false }).waitFor();
    const stats = page.locator('.overview-statistics');
    assert.ok((await stats.innerText()).includes('4.75'));
    assert.ok((await stats.innerText()).includes('50'));
    await page.getByLabel('合格比例（满分百分比）').fill('96');
    assert.equal(await page.getByRole('button', { name: '导出 Excel' }).isDisabled(), true);
    await page.getByRole('button', { name: '应用筛选' }).click();
    await page.getByText('合格线 9.6 分（96%）', { exact: false }).waitFor();
    await page.getByLabel('合格比例（满分百分比）').fill('60');
    await page.getByLabel('用户名或姓名').fill('SECOND');
    await page.getByRole('button', { name: '应用筛选' }).click();
    await page.getByText('共 1 条', { exact: true }).waitFor();
    await page.getByText('合格线 6 分（60%）', { exact: false }).waitFor();
    // Export the applied filter, then verify the actual downloaded workbook.
    await page.getByRole('button', { name: '导出 Excel' }).click();
    await page.getByText('导出当前筛选匹配的全部 1 条成绩', { exact: false }).waitFor();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '确认导出', exact: true }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), `MetaExam-results-${t.examId}.xlsx`);
    const file = await download.path();
    assert.ok(file);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(file);
    assert.equal(book.getWorksheet('成绩名单').rowCount, 2);
    assert.equal(book.getWorksheet('成绩名单').getCell('A2').value, 'secondstudent');
    assert.equal(book.getWorksheet('成绩名单').getCell('D2').value, 0);
    await page.getByText('成绩文件已生成，请在浏览器下载中查看。', { exact: true }).waitFor();
    await page.getByLabel('用户名或姓名').fill('');
    await page.getByRole('button', { name: '应用筛选' }).click();
    await page.getByText('共 3 条', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('共 3 条', { exact: true }).waitFor();
    await page.screenshot({ path: 'artifacts/m2-reports/overview-desktop.png', fullPage: true });
    const exportUrl = base + `/api/v1/reports/exams/${t.examId}/export`;
    await page.route(exportUrl, (r) =>
      r.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'RESULT_EXPORT_BUSY',
          message: '成绩导出正在处理中，请稍后重试',
          requestId: 'test',
        }),
      }),
    );
    await page.getByRole('button', { name: '导出 Excel' }).click();
    await page.getByRole('button', { name: '确认导出', exact: true }).click();
    await page.getByText('成绩导出正在处理中，请稍后重试', { exact: true }).waitFor();
    await page.unroute(exportUrl);
    await page.getByRole('button', { name: '导出 Excel' }).click();
    const retryDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '确认导出', exact: true }).click();
    await retryDownload;
    const summaryUrl = base + `/api/v1/reports/exams/${t.examId}?passPercent=60`;
    await page.route(summaryUrl, (r) =>
      r.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'DATABASE_UNAVAILABLE',
          message: '数据库暂时不可用',
          requestId: 'test',
        }),
      }),
    );
    await page.getByRole('button', { name: '刷新统计' }).click();
    await page.getByText('数据库暂时不可用', { exact: true }).waitFor();
    assert.equal(await page.locator('.overview-statistics').count(), 0);
    assert.equal(await page.getByRole('button', { name: '导出 Excel' }).isDisabled(), true);
    await page.unroute(summaryUrl);
    await page.getByRole('button', { name: /^重\s*试$/ }).click();
    await page.locator('.overview-statistics').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: 'artifacts/m2-reports/overview-mobile.png', fullPage: true });
    await context.clearCookies();
    await page.goto(base + '/login');
    await page.getByLabel('用户名', { exact: true }).fill('student');
    await page.getByLabel('密码', { exact: true }).fill(t.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.getByRole('button', { name: '退出登录' }).waitFor();
    await page.goto(base + `/exams/${t.examId}/report`);
    await page.getByText('没有访问权限', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '导出 Excel' }).count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    writeFileSync(
      'artifacts/m2-reports/browser-results.json',
      JSON.stringify(
        {
          checks: [
            'published entry',
            'whole-exam statistics and threshold',
            'filter + refresh',
            'actual XLSX download',
            '429 export retry',
            '503 hides stale statistics',
            'mobile',
            'student denied',
          ],
          errors,
          external,
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS browser statistics, filter/threshold, real XLSX download/retry, 503 recovery, mobile and student denial',
    );
  } catch (e) {
    await page.screenshot({ path: 'artifacts/m2-reports/failure.png', fullPage: true });
    writeFileSync('artifacts/m2-reports/failure.txt', await page.locator('body').innerText());
    throw e;
  }
} finally {
  await browser?.close();
  await t.close();
}
