import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { gradeNextAttempt } from '../packages/db/dist/index.js';
import { gradingFixture } from './grading-fixture.mts';
const t = await gradingFixture();
let browser;
mkdirSync('artifacts/m2-grading', { recursive: true });
try {
  await gradeNextAttempt(t.db);
  await t.finish();
  const base = 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== base) external.push(r.url());
  });
  async function login(username: string) {
    await page.goto(base + '/login');
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(t.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
  }
  try {
    await login('teacher');
    await page.goto(base + `/exams/${t.examId}`);
    await page.getByRole('link', { name: '阅卷与成绩', exact: true }).click();
    await page.getByText('待评分', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '发布成绩', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: '查看答卷', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('考生答案', { exact: true }).waitFor();
    for (let i = 0; i < 4; i++) {
      await dialog.getByRole('button', { name: '下一题', exact: true }).click();
      await dialog
        .getByText(`第 ${i + 2} 题`, { exact: false })
        .first()
        .waitFor();
    }
    await dialog.getByText('秘密简答参考答案', { exact: true }).waitFor();
    await dialog.getByText('考生的人工评分答案', { exact: true }).waitFor();
    const image = dialog.getByAltText('作答示意图');
    await image.waitFor();
    await image.evaluate((img: HTMLImageElement) => img.decode());
    await dialog.getByLabel('本题得分', { exact: true }).fill('1.5');
    await dialog.getByLabel('评语（发布后学生可见）').fill('解释较完整');
    const saveUrl = base + `/api/v1/grading/exams/${t.examId}/attempts/${t.attemptId}/questions/5`;
    await page.route(saveUrl, (route) =>
      route.request().method() === 'PUT' ? route.abort() : route.continue(),
    );
    await dialog.getByRole('button', { name: '保存评分' }).click();
    await dialog.getByRole('button', { name: '重新读取' }).waitFor();
    assert.equal(await dialog.getByLabel('本题得分', { exact: true }).inputValue(), '1.5');
    await page.unroute(saveUrl);
    await dialog.getByRole('button', { name: '保存评分' }).click();
    await dialog.getByText('当前得分 1.5', { exact: false }).waitFor();
    // Another marker saves; stale form must fail rather than overwrite it.
    assert.equal(
      (
        await t.request(
          `/grading/exams/${t.examId}/attempts/${t.attemptId}/questions/5`,
          'PUT',
          { revision: 2, score: 1, comment: '另一页评分' },
          t.people.admin!.cookie,
        )
      ).statusCode,
      200,
    );
    await dialog.getByLabel('本题得分', { exact: true }).fill('2');
    await dialog.getByRole('button', { name: '保存评分' }).click();
    await dialog.getByText('数据已被修改，请刷新后重新编辑', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '重新读取' }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await dialog.getByText('当前得分 1', { exact: false }).waitFor();
    await dialog.getByLabel('本题得分', { exact: true }).fill('1.5');
    await dialog.getByLabel('评语（发布后学生可见）').fill('解释较完整');
    await dialog.getByRole('button', { name: '保存评分' }).click();
    await dialog.getByText('当前得分 1.5', { exact: false }).waitFor();
    await page.screenshot({ path: 'artifacts/m2-grading/marking-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: 'artifacts/m2-grading/marking-mobile.png', fullPage: true });
    await dialog.getByRole('button', { name: '关闭阅卷', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const hidden = (
      await t.request(`/my-exams/${t.examId}/result`, 'GET', undefined, t.people.student!.cookie)
    ).json();
    assert.equal(hidden.state, 'unpublished');
    assert.equal(hidden.totalScore, null);
    await page.getByRole('button', { name: '发布成绩', exact: true }).click();
    await page.getByRole('button', { name: '确认发布', exact: true }).click();
    await page.getByText('成绩已发布', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('成绩已发布', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查看答卷', exact: true }).click();
    await dialog.getByText('考生答案', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '保存评分' }).count(), 0);
    await dialog.getByRole('button', { name: '关闭阅卷', exact: true }).click();
    await context.clearCookies();
    await login('student');
    await page.goto(base + '/my-exams');
    await page.getByRole('link', { name: '查看成绩', exact: true }).click();
    await page.getByRole('heading', { name: '总分 9.5 / 10', exact: true }).waitFor();
    await page.getByText('解释较完整', { exact: true }).waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('秘密'));
    await page.reload();
    await page.getByRole('heading', { name: '总分 9.5 / 10', exact: true }).waitFor();
    const resultUrl = base + `/api/v1/my-exams/${t.examId}/result`;
    await page.route(resultUrl, (r) =>
      r.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'DATABASE_UNAVAILABLE',
          message: '数据库暂时不可用',
          requestId: 'ui-test',
        }),
      }),
    );
    await page.getByRole('button', { name: '刷新成绩' }).click();
    await page.getByText('数据库暂时不可用', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('heading', { name: '总分 9.5 / 10', exact: true }).count(),
      0,
    );
    await page.unroute(resultUrl);
    await page.getByRole('button', { name: /^重\s*试$/ }).click();
    await page.getByRole('heading', { name: '总分 9.5 / 10', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: 'artifacts/m2-grading/result-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    writeFileSync(
      'artifacts/m2-grading/browser-results.json',
      JSON.stringify(
        {
          checks: [
            'teacher review and image',
            'failed save preserves input',
            'revision conflict reload',
            'publish confirmation and immutable state',
            'student score and feedback only',
            'refresh and 503 recovery',
            'mobile',
          ],
          errors,
          external,
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS browser manual grading/save recovery/conflict/publication/student result/mobile',
    );
  } catch (e) {
    await page.screenshot({ path: 'artifacts/m2-grading/failure.png', fullPage: true });
    writeFileSync('artifacts/m2-grading/failure.txt', await page.locator('body').innerText());
    throw e;
  }
} finally {
  await browser?.close();
  await t.close();
}
