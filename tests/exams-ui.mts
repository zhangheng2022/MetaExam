import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { examFixture } from './exams-fixture.mts';
const t = await examFixture();
let browser;
mkdirSync('artifacts/m2-exams', { recursive: true });
try {
  const base = 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== base) external.push(r.url());
  });
  const login = async (name: string) => {
    await page.goto(base + '/login');
    await page.getByLabel('用户名', { exact: true }).fill(name);
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
  const time = (n: number) => new Date(Date.now() + n + 8 * 3600000).toISOString().slice(0, 16);
  try {
    await login('teacher');
    await page.getByRole('menuitem', { name: '考试管理' }).click();
    await page.getByRole('button', { name: '创建考试', exact: true }).click();
    await dialog().getByLabel('考试名称', { exact: true }).fill('浏览器发布验收');
    await choose('所属课程', '数学');
    await choose('冻结试卷', '数学冻结试卷');
    await choose('参加班级', '一年一班');
    await dialog().getByLabel('开始时间（北京）', { exact: true }).click();
    await dialog().getByLabel('开始时间（北京）', { exact: true }).fill(time(3600000));
    await dialog().getByLabel('结束时间（北京）', { exact: true }).fill(time(10800000));
    await dialog()
      .getByRole('button', { name: /保\s*存/ })
      .click();
    await dialog().waitFor({ state: 'hidden' });
    await page.getByText('名单 1 人', { exact: false }).waitFor();
    const examUrl = page.url();
    const detailEndpoint = base + '/api/v1' + new URL(examUrl).pathname;
    await page.route(detailEndpoint, (route) => route.abort());
    await page.getByRole('button', { name: /^刷\s*新$/ }).click();
    await page.getByText('服务连接失败，请检查后台服务后重试。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '发布考试', exact: true }).count(), 0);
    await page.unroute(detailEndpoint);
    await page.getByRole('button', { name: /^重\s*试$/ }).click();
    await page.getByRole('button', { name: '发布考试', exact: true }).waitFor();
    await page.getByRole('button', { name: '发布考试', exact: true }).click();
    await dialog().getByRole('button', { name: '确认发布', exact: true }).click();
    await page.getByText('本地授权无效、未激活或已到期，暂不能发布考试', { exact: true }).waitFor();
    await t.activate();
    await page.getByRole('button', { name: '发布考试', exact: true }).click();
    await dialog().getByRole('button', { name: '确认发布', exact: true }).click();
    await page.getByText('考试已发布，配置与名单已固定', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '编辑与刷新名单', exact: true }).count(),
      0,
    );
    await page.reload();
    await page.getByText('考试已发布，配置与名单已固定', { exact: true }).waitFor();
    await page.screenshot({ path: 'artifacts/m2-exams/published-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '取消考试', exact: true }).click();
    await dialog().getByLabel('取消原因', { exact: true }).fill('学校调整考试时间');
    await dialog().getByRole('button', { name: '确认取消', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    await page.getByText('考试已取消', { exact: true }).waitFor();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await login('student');
    assert.equal(await page.getByRole('menuitem', { name: '考试管理' }).count(), 0);
    await page.getByRole('menuitem', { name: '我的考试' }).click();
    await page.getByRole('cell', { name: '浏览器发布验收', exact: true }).waitFor();
    await page.getByRole('cell', { name: '学校调整考试时间', exact: true }).waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('仅教师可见'));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: 'artifacts/m2-exams/student-mobile.png', fullPage: true });
    await page.goto(examUrl);
    await page.getByText('没有访问权限', { exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await login('other');
    await page.goto(examUrl);
    await page.getByText('记录不存在', { exact: true }).first().waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    writeFileSync(
      'artifacts/m2-exams/browser-results.json',
      JSON.stringify(
        {
          passed: true,
          checks: [
            'create with Beijing time and class roster',
            'unactivated rejection and recovery',
            'publish/immutable/reload',
            'cancel reason',
            'student own redacted schedule/mobile',
            'teacher ownership',
            'no external requests/page errors',
          ],
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS exam browser create/roster/publish/reload/cancel/student/mobile/ownership/offline',
    );
  } catch (e) {
    await page.screenshot({ path: 'artifacts/m2-exams/failure.png', fullPage: true });
    writeFileSync('artifacts/m2-exams/failure.txt', await page.locator('body').innerText());
    throw e;
  }
} finally {
  await browser?.close();
  await t.close();
}
