import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { questionFixture } from './questions-fixture.mts';
const t = await questionFixture();
let browser;
mkdirSync('artifacts/m2-papers', { recursive: true });
try {
  const bank = await t.create('/question-banks', {
    name: '数学组卷库',
    courseId: t.courseId,
    visibility: 'public',
  });
  for (let i = 1; i <= 4; i++)
    await t.create(`/question-banks/${bank}/questions`, {
      stem: `浏览器组卷题 ${i}`,
      content: { type: 'boolean', answer: true },
      difficulty: 2,
      tags: ['基础'],
      knowledgePoints: ['整数'],
      explanation: '冻结后保持此答案',
    });
  const base = 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== base) external.push(r.url());
  });
  const login = async (username: string) => {
    await page.goto(base + '/login');
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(t.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.getByRole('menuitem', { name: '个人信息' }).waitFor();
  };
  const dialog = () => page.getByRole('dialog');
  const choose = async (label: string, text: string) => {
    await dialog().getByLabel(label, { exact: true }).click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: text })
      .first()
      .click();
  };
  try {
    await login('admin');
    await page.getByRole('menuitem', { name: '试卷管理' }).click();
    await page.getByRole('button', { name: '创建试卷', exact: true }).click();
    await dialog().getByLabel('试卷名称', { exact: true }).fill('数学单元测试');
    await choose('所属课程', '数学');
    await dialog().getByLabel('作答说明', { exact: true }).fill('请仔细阅读每道题。');
    await dialog()
      .getByRole('button', { name: /保\s*存/ })
      .click();
    await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '手动选题', exact: true }).waitFor();
    const paperUrl = page.url();
    await page.getByRole('button', { name: '手动选题', exact: true }).click();
    await choose('来源题库', '数学组卷库');
    const row = dialog()
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: '浏览器组卷题 1', exact: true }) });
    await row.getByRole('checkbox').check();
    await dialog().getByLabel('所选题目分值', { exact: true }).fill('2.5');
    await dialog().getByRole('button', { name: '加入试卷（1 题）' }).click();
    await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '按条件抽题', exact: true }).click();
    await choose('来源题库', '数学组卷库');
    await choose('题型', '判断题');
    await choose('难度', '2');
    await dialog().getByLabel('标签', { exact: true }).fill('基础');
    await dialog().getByLabel('知识点', { exact: true }).fill('整数');
    await dialog().getByLabel('抽题数量', { exact: true }).fill('10');
    await dialog().getByRole('button', { name: '抽题并加入' }).click();
    await dialog()
      .getByText('符合条件且未选入试卷的题目不足，请减少数量或调整条件', { exact: true })
      .waitFor();
    await dialog().getByLabel('抽题数量', { exact: true }).fill('2');
    await dialog().getByLabel('每题分值', { exact: true }).fill('1');
    await dialog().getByRole('button', { name: '抽题并加入' }).click();
    await dialog().waitFor({ state: 'hidden' });
    await page.getByLabel('第 1 题分值', { exact: true }).waitFor();
    await page.getByLabel('第 1 题分值', { exact: true }).fill('3.5');
    await page.getByRole('button', { name: '下移第 1 题', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: '冻结试卷', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.getByText('3 题 · 5.5 分', { exact: true }).waitFor();
    await page.screenshot({ path: 'artifacts/m2-papers/draft-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '预览试卷', exact: true }).click();
    await dialog().getByRole('heading', { name: '数学单元测试', exact: true }).waitFor();
    await dialog().getByText('冻结后保持此答案', { exact: true }).first().waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/m2-papers/preview-mobile.png', fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await dialog()
      .getByRole('button', { name: /^(Close|关闭)$/ })
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '冻结试卷', exact: true }).click();
    await dialog().getByRole('button', { name: '确认冻结', exact: true }).click();
    await page.getByText('试卷已冻结', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('试卷已冻结', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存草稿', exact: true }).count(), 0);
    await page.screenshot({ path: 'artifacts/m2-papers/frozen-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '复制为新草稿', exact: true }).click();
    await dialog().getByLabel('新试卷名称', { exact: true }).fill('数学单元测试第二版');
    await dialog()
      .getByRole('button', { name: /保\s*存/ })
      .click();
    await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '手动选题', exact: true }).waitFor();
    assert.notEqual(page.url(), paperUrl);
    await page.getByRole('button', { name: '返回试卷列表', exact: true }).click();
    await page.getByRole('link', { name: '数学单元测试第二版', exact: true }).waitFor();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await login('teacher');
    await page.getByRole('menuitem', { name: '试卷管理' }).click();
    assert.equal(await page.getByRole('link', { name: '数学单元测试', exact: true }).count(), 0);
    await page.goto(paperUrl);
    await page.getByText('记录不存在', { exact: true }).waitFor();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await login('student');
    assert.equal(await page.getByRole('menuitem', { name: '试卷管理' }).count(), 0);
    await page.goto(base + '/papers');
    await page.getByText('没有访问权限', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    writeFileSync(
      'artifacts/m2-papers/browser-results.json',
      JSON.stringify(
        {
          passed: true,
          checks: [
            'manual selection',
            'conditional draw shortage and success',
            'fractional scores and ordering',
            'unsaved freeze disabled',
            'teacher preview and mobile',
            'freeze/reload/copy',
            'teacher ownership/student denial',
            'offline assets/no page errors',
          ],
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS paper browser create/manual/draw/scores/order/preview/freeze/copy, mobile and permissions',
    );
  } catch (e) {
    await page.screenshot({ path: 'artifacts/m2-papers/failure.png', fullPage: true });
    writeFileSync('artifacts/m2-papers/failure.txt', await page.locator('body').innerText());
    throw e;
  }
} finally {
  await browser?.close();
  await t.close();
}
