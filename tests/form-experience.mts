import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, type Locator } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
async function valueIs(input: Locator, expected: string) {
  for (let i = 0; i < 200; i++) {
    if ((await input.inputValue()) === expected) return;
    await delay(25);
  }
  assert.equal(await input.inputValue(), expected);
}
import { reportFixture } from './reports-fixture.mts';
mkdirSync('artifacts/ux-review', { recursive: true });
const t = await reportFixture();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const base = 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
const results: { issue: string; evidence: unknown }[] = [];
const record = (issue: string, evidence: unknown) => {
  results.push({ issue, evidence });
  console.log(JSON.stringify(results.at(-1)));
  writeFileSync('artifacts/ux-review/results.json', JSON.stringify(results, null, 2));
};
const login = async (username: string) => {
  await page.context().clearCookies();
  await page.goto(base + '/login');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(t.password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.getByRole('menuitem', { name: '个人信息' }).waitFor();
};
try {
  await login('teacher');
  await page.goto(base + '/exams/' + t.examId);
  await page.getByLabel('考生搜索', { exact: true }).fill('student');
  await page.getByRole('button', { name: /查\s*询/ }).click();
  await page.waitForURL('**/*q=student*');
  await page.getByRole('button', { name: /重\s*置/ }).click();
  await page.waitForURL((u) => !u.searchParams.has('q'));
  await valueIs(page.getByLabel('考生搜索', { exact: true }), '');
  record('名单重置清空输入', {
    input: await page.getByLabel('考生搜索', { exact: true }).inputValue(),
    query: new URL(page.url()).search,
  });
  await page.goto(base + '/exams/' + t.examId + '/grading?q=student');
  await page.getByLabel('考生', { exact: true }).waitFor();
  await valueIs(page.getByLabel('考生', { exact: true }), 'student');
  record('阅卷搜索条件正确回填', { input: 'student', query: new URL(page.url()).search });
  await page.goto(base + '/exams/' + t.examId + '/report');
  await page.getByText('共 3 条', { exact: true }).waitFor();
  await page.getByLabel('用户名或姓名', { exact: true }).fill('SECOND');
  await page.getByRole('button', { name: '应用筛选', exact: true }).click();
  await page.getByText('共 1 条', { exact: true }).waitFor();
  await page.getByLabel('用户名或姓名', { exact: true }).fill('UNAPPLIED');
  await page.goBack();
  await page.getByText('共 3 条', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('用户名或姓名', { exact: true }).inputValue(), '');
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('导出 Excel'),
      )?.disabled,
  );
  assert.equal(
    await page.getByRole('button', { name: '导出 Excel', exact: true }).isDisabled(),
    false,
  );
  record('统计页后退恢复筛选并允许导出', {
    input: '',
    warning: await page.getByText('筛选条件尚未应用，请先应用筛选再导出').isVisible(),
  });
  const paper = await t.request(
    '/papers',
    'POST',
    { name: '体验审查试卷', courseId: t.courseId },
    t.people.teacher.cookie,
  );
  assert.equal(paper.statusCode, 201, paper.body);
  await page.goto(base + '/papers');
  await page.getByRole('link', { name: '体验审查试卷', exact: true }).click();
  await page.getByLabel('试卷名称', { exact: true }).fill('未保存的新名称');
  await page.getByRole('menuitem', { name: '考试管理' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '继续编辑' }).click();
  assert.equal(await page.getByLabel('试卷名称', { exact: true }).inputValue(), '未保存的新名称');
  await page.goBack();
  await page.getByRole('dialog').getByRole('button', { name: '继续编辑' }).click();
  assert.equal(await page.getByLabel('试卷名称', { exact: true }).inputValue(), '未保存的新名称');
  await page.getByRole('menuitem', { name: '考试管理' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃修改' }).click();
  await page.waitForURL('**/exams');
  await page.getByRole('button', { name: '创建考试', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.goBack();
  await page.getByLabel('试卷名称', { exact: true }).waitFor();
  await valueIs(page.getByLabel('试卷名称', { exact: true }), '体验审查试卷');
  record('试卷导航确认支持保留及放弃修改', {
    restored: await page.getByLabel('试卷名称', { exact: true }).inputValue(),
  });

  await page.goto(base + '/exams');
  await page.getByRole('button', { name: '创建考试', exact: true }).click();
  await page.getByLabel('所属课程', { exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: '数学' })
    .first()
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('dialog').last().getByRole('button', { name: '继续编辑' }).click();
  assert.equal(await page.getByLabel('冻结试卷', { exact: true }).count(), 1);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await page.getByRole('dialog').last().getByRole('button', { name: '放弃修改' }).click();
  const original = (
    await t.request('/exams/' + t.examId, 'GET', undefined, t.people.teacher!.cookie)
  ).json();
  const draft = await t.request(
    '/exams',
    'POST',
    { ...t.input, paperVersionId: original.paperVersionId },
    t.people.teacher!.cookie,
  );
  assert.equal(draft.statusCode, 201, draft.body);
  await page.route('**/api/v1/exams/choices/papers?**', (r) =>
    r.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } }),
  );
  await page.goto(base + '/exams/' + draft.json().id);
  const choices = page.waitForResponse((r) => r.url().includes('/exams/choices/papers?'));
  await page.getByRole('button', { name: '编辑与刷新名单' }).click();
  await choices;
  assert.ok((await page.getByRole('dialog').innerText()).includes(original.paperName));
  assert.ok(!(await page.getByRole('dialog').innerText()).includes(original.paperVersionId));
  record('考试选择项丢弃确认与跨页名称回填', true);
  await login('admin');
  const bank = await t.create('/question-banks', {
    name: '体验审查题库',
    courseId: t.courseId,
    visibility: 'public',
  });
  await page.goto(base + '/question-banks/' + bank);
  await page.getByRole('button', { name: '录入题目', exact: true }).click();
  await page.getByLabel('题干', { exact: true }).fill('检查错误反馈');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.ant-drawer-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /保\s*存/ })
      .click();
    const error = page.locator('.ant-form-item-explain-error').first();
    await error.waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'management-editor_content');
    const evidence = await error.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const body = el.closest('.ant-drawer-body')!.getBoundingClientRect();
      return { message: el.textContent, visible: r.bottom > body.top && r.top < body.bottom };
    });
    assert.equal(evidence.visible, true);
    await page.screenshot({ path: 'artifacts/ux-review/hidden-error-' + width + '.png' });
    record('题目错误可见且获得焦点', { width, ...evidence });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel('选项 A', { exact: true }).fill('2');
  await page.getByLabel('选项 B', { exact: true }).fill('4');
  await page.getByLabel('正确答案', { exact: true }).click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: 'A.' })
    .first()
    .click();
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/v1/question-banks/' + bank + '/questions', async (r) => {
    if (r.request().method() === 'POST') {
      await hold;
      await r.fulfill({ status: 503, json: { message: '模拟保存失败，请重试' } });
    } else await r.continue();
  });
  const pending = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/questions'),
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /保\s*存/ })
    .click();
  await pending;
  try {
    assert.equal(
      await page.getByRole('button', { name: '添加选项', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: '上传题目图片', exact: true }).isDisabled(),
      true,
    );
  } finally {
    release();
  }
  await page.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
  assert.equal(await page.getByLabel('选项 A', { exact: true }).inputValue(), '2');
  record('保存中禁用内部按钮，失败保留输入并展示错误', true);
} finally {
  await browser.close();
  await t.close();
}
