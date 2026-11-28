import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { questionFixture } from './questions-fixture.mts';
const t = await questionFixture();
let browser;
mkdirSync('artifacts/m2-questions', { recursive: true });
try {
  const base = 'http://metaexam-http.test:' + t.app.getHttpServer().address().port;
  browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--host-resolver-rules=MAP metaexam-http.test 127.0.0.1', '--no-proxy-server'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== base) external.push(r.url());
  });
  const login = async (username: string) => {
    await page.goto(base + '/login');
    assert.equal(await page.evaluate(() => window.isSecureContext), false);
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(t.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.getByRole('menuitem', { name: '个人信息' }).waitFor();
  };
  const dialog = () => page.getByRole('dialog');
  const choose = async (label: string, name: string) => {
    await dialog().getByLabel(label, { exact: true }).click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: name })
      .first()
      .click();
  };
  const save = async () => {
    await dialog()
      .getByRole('button', { name: /保\s*存/ })
      .click();
    await dialog().waitFor({ state: 'hidden' });
  };
  try {
    await login('admin');
    await page.getByRole('menuitem', { name: '题库管理' }).click();
    await page.getByRole('button', { name: '创建题库' }).click();
    await dialog().getByLabel('题库名称').fill('数学公共题库');
    await choose('所属课程', '数学');
    await save();
    await page.getByRole('link', { name: '数学公共题库', exact: true }).click();
    const bankUrl = page.url();
    for (const [type, stem] of [
      ['单选题', '计算 1 + 1 = ?'],
      ['多选题', '哪些是偶数？'],
      ['判断题', '零是偶数。'],
      ['填空题', '1 + 1 = [[blank]]'],
      ['简答题', '说明你的计算过程。'],
    ] as const) {
      await page.getByRole('button', { name: '录入题目' }).click();
      await dialog().getByLabel('题干', { exact: true }).fill(stem);
      if (type !== '单选题') {
        await choose('题型', type);
        await page.getByRole('dialog').last().getByRole('button', { name: '切换题型' }).click();
      }
      if (type === '单选题' || type === '多选题') {
        await dialog().getByLabel('选项 A', { exact: true }).fill('2');
        await dialog().getByLabel('选项 B', { exact: true }).fill('4');
        await choose('正确答案', 'A.');
        if (type === '多选题') {
          await page
            .locator('.ant-select-dropdown:visible .ant-select-item-option')
            .filter({ hasText: 'B.' })
            .click();
          await dialog().getByLabel('题干', { exact: true }).click();
        }
      }
      if (type === '填空题')
        await dialog().getByLabel('第 1 空答案', { exact: true }).fill('2\n二');
      if (type === '简答题')
        await dialog().getByLabel('参考答案', { exact: true }).fill('先列式，再计算。');
      await dialog().getByLabel('解析', { exact: true }).fill('教师专用解析：用于复核。');
      await save();
      await page.getByRole('cell', { name: stem, exact: true }).waitFor();
    }
    await page.screenshot({ path: 'artifacts/m2-questions/questions-desktop.png', fullPage: true });
    const row = () =>
      page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: '计算 1 + 1 = ?', exact: true }) });
    await row().getByRole('button', { name: '编辑', exact: true }).click();
    await dialog().getByLabel('题干', { exact: true }).fill('计算 2 + 2 = ?');
    await save();
    const edited = () =>
      page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: '计算 2 + 2 = ?', exact: true }) });
    await edited().getByRole('button', { name: '预览与历史' }).click();
    await dialog().getByRole('button', { name: '查看 V1', exact: true }).click();
    await dialog().getByText('计算 1 + 1 = ?', { exact: true }).waitFor();
    await dialog().getByRole('button', { name: '查看 V2', exact: true }).click();
    await dialog().getByText('计算 2 + 2 = ?', { exact: true }).waitFor();
    await page.screenshot({ path: 'artifacts/m2-questions/history-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: 'artifacts/m2-questions/history-mobile.png', fullPage: true });
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '录入题目' }).click();
    await dialog().getByLabel('题干', { exact: true }).fill('<img src=x onerror=alert(1)>');
    await dialog()
      .getByRole('button', { name: /保\s*存/ })
      .click();
    await dialog().getByText('选项 A：内容不能为空', { exact: true }).waitFor();
    assert.ok((await dialog().locator('.ant-form-item-has-error').count()) > 0);
    await dialog()
      .getByRole('button', { name: /取\s*消/ })
      .click();
    await page.getByRole('dialog').last().getByRole('button', { name: '放弃修改' }).click();
    await dialog().waitFor({ state: 'hidden' });
    await edited().getByRole('button', { name: '归档', exact: true }).click();
    await dialog()
      .getByRole('button', { name: /归\s*档/ })
      .click();
    await edited().getByRole('cell', { name: '已归档', exact: true }).waitFor();
    await page.getByLabel('搜索', { exact: true }).fill('零是偶数');
    await page.getByRole('button', { name: /查\s*询/ }).click();
    await page.getByRole('cell', { name: '零是偶数。', exact: true }).waitFor();
    await page
      .getByRole('cell', { name: '计算 2 + 2 = ?', exact: true })
      .waitFor({ state: 'hidden' });
    await page.reload();
    await page.getByRole('cell', { name: '零是偶数。', exact: true }).waitFor();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await login('teacher');
    await page.goto(bankUrl);
    await page.getByText('只读题库', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '录入题目' }).count(), 0);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await login('student');
    assert.equal(await page.getByRole('menuitem', { name: '题库管理' }).count(), 0);
    await page.goto(bankUrl);
    await page.getByText('没有访问权限', { exact: true }).waitFor();
    assert.equal(await page.getByText('教师专用解析：用于复核。', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    writeFileSync(
      'artifacts/m2-questions/browser-results.json',
      JSON.stringify(
        {
          passed: true,
          checks: [
            'create public bank',
            'five question forms',
            'immutable history preview',
            'invalid content feedback',
            'archive',
            'URL search and refresh',
            'teacher readonly and student denial',
            'mobile drawer containment',
            'offline assets/no browser errors',
          ],
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS question bank browser flow, five types, history, permissions, mobile and offline assets',
    );
  } catch (e) {
    await page.screenshot({ path: 'artifacts/m2-questions/failure.png', fullPage: true });
    writeFileSync('artifacts/m2-questions/failure.html', await page.content());
    throw e;
  }
} finally {
  await browser?.close();
  await t.close();
}
