import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { attemptFixture } from './attempts-fixture.mts';
import {
  processFile,
  ManagementRepository,
  createDatabase,
  grantRuntimeAccess,
} from '../packages/db/dist/index.js';
const ExcelJS = createRequire(path.resolve('packages/db/package.json'))('exceljs');
const t = await attemptFixture();
let browser;
try {
  const admin = t.people.admin!.cookie;
  const base = () => 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
  const workbook = async (rows: unknown[][]) => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('账号');
    sheet.addRow(['用户名', '姓名', '角色', '班级编码', '初始密码']);
    rows.forEach((row) => sheet.addRow(row));
    return Buffer.from(await book.xlsx.writeBuffer());
  };
  const upload = async (rows: unknown[][], cookie = admin) => {
    const data = await workbook(rows),
      form = new FormData();
    form.append('file', new Blob([data]), 'accounts.xlsx');
    return fetch(base() + '/api/v1/admin/account-imports', {
      method: 'POST',
      headers: { cookie },
      body: form,
    });
  };
  const preview = async (rows: unknown[][]) => {
    const r = await upload(rows);
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const confirm = (id: string, cookie = admin) =>
    t.request('/admin/account-imports/' + id + '/confirm', 'POST', {}, cookie);
  assert.equal((await t.request('/admin/account-imports/template')).statusCode, 401);
  assert.equal(
    (await upload([['test01', '测试', '学生', 'ONE', '123456']], t.people.teacher!.cookie)).status,
    403,
  );
  assert.equal((await upload([[{ formula: '1+1' }, '测试', '学生', 'ONE', '123456']])).status, 400);
  const boundary = Array.from({ length: 500 }, (_, i) => [
    'bound' + i,
    '边界',
    '学生',
    '',
    '123456',
  ]);
  assert.equal(
    (await processFile<unknown[]>('account-workbook', await workbook(boundary))).length,
    500,
  );
  await assert.rejects(
    processFile('account-workbook', await workbook([...boundary, boundary[0]!])),
  );
  const fullBatch = await preview(boundary);
  assert.equal(fullBatch.rows.length, 500);
  assert.ok(fullBatch.rows.every((r: { errors: string[] }) => !r.errors.length));
  const fullResult = await confirm(fullBatch.id);
  assert.equal(fullResult.statusCode, 200, fullResult.body);
  assert.equal(fullResult.json().created, 500);
  const bad = await preview([
    ['bad01', '错误', '学生', 'NONE', '123'],
    ['bad01', '重复', '管理员', '', '123456'],
  ]);
  assert.ok(bad.rows.every((r: { errors: string[] }) => r.errors.length));
  assert.equal((await confirm(bad.id)).statusCode, 409);
  const goodRows = [
    ['bulk001', '学生批量', '学生', 'ONE', 'personal-123'],
    ['bulk002', '教师批量', '教师', '', 'teacher-123'],
  ];
  const good = await preview(goodRows);
  assert.ok(good.rows.every((r: { errors: string[] }) => !r.errors.length));
  assert.ok(!JSON.stringify(good).includes('personal-123'));
  const confirmed = await Promise.all([confirm(good.id), confirm(good.id)]);
  for (const r of confirmed) {
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { created: 2, added: 1, skipped: 0 });
  }
  const login = await t.request('/auth/login', 'POST', {
    username: 'bulk001',
    password: 'personal-123',
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mustChangePassword, true);
  assert.equal(
    (
      await t.request(
        '/admin/account-imports/template',
        'GET',
        undefined,
        String(login.headers['set-cookie']).split(';')[0],
      )
    ).statusCode,
    403,
  );
  const existing = await preview([['bulk001', '学生批量', '学生', 'ONE', '']]);
  assert.equal(existing.rows[0].action, 'skip');
  assert.equal((await confirm(existing.id)).json().skipped, 1);
  const changed = await preview([['stale01', '变更', '学生', 'ONE', '123456']]);
  await t.db.pool.query('UPDATE classes SET revision=revision+1 WHERE id=$1', [t.classId]);
  assert.equal((await confirm(changed.id)).json().code, 'ACCOUNT_IMPORT_CHANGED');
  assert.equal(
    (await t.db.pool.query("SELECT count(*) FROM users WHERE username='stale01'")).rows[0].count,
    '0',
  );
  const cancelled = await preview([['cancel01', '取消', '学生', '', '123456']]);
  await t.request('/admin/account-imports/' + cancelled.id, 'DELETE', undefined, admin);
  assert.equal((await confirm(cancelled.id)).statusCode, 409);
  const audit = await t.db.pool.query(
    "SELECT details FROM audit_events WHERE event='accounts.import'",
  );
  assert.ok(
    audit.rows.every((r) => Object.keys(r.details).sort().join(',') === 'added,created,skipped'),
  );
  const rollback = await preview([
    ['atomic01', '事务一', '学生', '', '123456'],
    ['atomic02', '事务二', '学生', '', '123456'],
  ]);
  await t.db.pool.query(
    "CREATE FUNCTION pilot_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.username='atomic02' THEN RAISE EXCEPTION 'pilot failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER pilot_reject BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION pilot_reject()",
  );
  assert.equal((await confirm(rollback.id)).statusCode, 503);
  assert.equal(
    (await t.db.pool.query("SELECT count(*) FROM users WHERE username LIKE 'atomic%'")).rows[0]
      .count,
    '0',
  );
  await t.db.pool.query('DROP TRIGGER pilot_reject ON users; DROP FUNCTION pilot_reject()');
  assert.equal((await confirm(rollback.id)).statusCode, 200);
  const revoked = await preview([['revoked01', '撤权', '学生', '', '123456']]);
  await t.db.pool.query('UPDATE user_credentials SET must_change_password=true WHERE user_id=$1', [
    t.people.admin!.id,
  ]);
  assert.equal((await confirm(revoked.id)).statusCode, 403);
  await t.db.pool.query('UPDATE user_credentials SET must_change_password=false WHERE user_id=$1', [
    t.people.admin!.id,
  ]);
  const role = 'metaexam_test_' + randomUUID().replaceAll('-', ''),
    rolePassword = randomUUID();
  await t.db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${rolePassword}'`);
  const low = createDatabase({
    ...t.config,
    database: { ...t.config.database, user: role, password: rolePassword },
  });
  try {
    await grantRuntimeAccess(t.db.pool, role, t.config.database.database);
    await assert.rejects(
      low.pool.query('CREATE TABLE forbidden_table(id integer)'),
      /permission denied/,
    );
    const repository = new ManagementRepository(low);
    const hash = (
      await t.db.pool.query('SELECT password_hash FROM user_credentials WHERE user_id=$1', [
        t.people.student!.id,
      ])
    ).rows[0].password_hash;
    const input = [
      {
        row: 2,
        username: 'lowrole01',
        displayName: '受限导入',
        role: 'student' as const,
        classCode: 'ONE',
        passwordHash: hash,
      },
    ];
    const checked = await repository.inspectAccountImport(t.people.admin!.id, input);
    await assert.rejects(
      repository.confirmAccountImport(
        t.people.admin!.id,
        randomUUID(),
        input,
        JSON.stringify(checked),
        { requestId: 'expired-preview' },
        Date.now() - 1,
      ),
      /ACCOUNT_IMPORT_EXPIRED/,
    );
    assert.deepEqual(
      await repository.confirmAccountImport(
        t.people.admin!.id,
        randomUUID(),
        input,
        JSON.stringify(checked),
        { requestId: 'pilot-restricted' },
        Date.now() + 600000,
      ),
      { created: 1, added: 1, skipped: 0 },
    );
    await assert.rejects(repository.inspectAccountImport(t.people.student!.id, input), /FORBIDDEN/);
  } finally {
    await low.pool.end();
    await t.db.pool.query('DROP OWNED BY ' + role);
    await t.db.pool.query('DROP ROLE ' + role);
  }

  await t.open();
  const endpoint = '/exams/' + t.examId + '/progress';
  const progress = async () => {
    const r = await t.request(endpoint, 'GET', undefined, t.people.teacher!.cookie);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  assert.equal(
    (await t.request(endpoint, 'GET', undefined, t.people.student!.cookie)).statusCode,
    403,
  );
  assert.equal(
    (await t.request(endpoint, 'GET', undefined, t.people.other!.cookie)).statusCode,
    404,
  );
  assert.deepEqual((await progress()).counts, { waiting: 2, active: 0, submitted: 0 });
  const started = await t.request(
    '/my-exams/' + t.examId + '/start',
    'POST',
    {},
    t.people.student!.cookie,
  );
  assert.equal(started.statusCode, 200, started.body);
  const attempt = started.json().id;
  const saved = await t.request(
    '/attempts/' + attempt + '/questions/1',
    'PUT',
    { revision: 0, mutationId: randomUUID(), answer: { type: 'boolean', value: true } },
    t.people.student!.cookie,
  );
  assert.equal(saved.statusCode, 200, saved.body);
  const active = await progress();
  assert.equal(active.counts.active, 1);
  assert.ok(active.rows.find((r: { id: string }) => r.id === t.people.student!.id).savedAt);
  assert.ok(!JSON.stringify(active).includes('answer'));

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base() + '/login');
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill(t.password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.getByRole('menuitem', { name: '账号管理' }).click();
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'accounts.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: await workbook([['browser01', '浏览器导入', '学生', 'ONE', '123456']]),
  });
  await page.getByText('浏览器导入', { exact: true }).waitFor();
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.getByText('导入完成：新建 1 个账号，加入 1 个班级成员，跳过 0 行。').waitFor();
  mkdirSync('artifacts/pilot', { recursive: true });
  await page.screenshot({ path: 'artifacts/pilot/import.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click();
  await page.goto(base() + '/exams/' + t.examId);
  await page.getByText('考中状态', { exact: true }).waitFor();
  await page.getByText(/未入场 1 人/).waitFor();
  await page.getByLabel('搜索考生').fill('missing');
  await page.getByText(/未入场 1 人/).waitFor();
  await page.route('**/api/v1/exams/*/progress', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"message":"状态读取失败"}',
    }),
  );
  await page.getByRole('button', { name: '刷新状态' }).click();
  await page.getByText('状态读取失败', { exact: true }).waitFor();
  assert.equal(await page.getByText(/最近成功读取/).count(), 0);
  await page.unroute('**/api/v1/exams/*/progress');
  await page.getByRole('button', { name: '刷新状态' }).click();
  await page.getByText(/未入场 1 人/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/pilot/progress-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(
    (
      await t.request(
        '/attempts/' + attempt + '/submit',
        'POST',
        { revision: 1 },
        t.people.student!.cookie,
      )
    ).statusCode,
    200,
  );
  const submitted = await progress();
  assert.deepEqual(submitted.counts, { waiting: 1, active: 0, submitted: 1 });
  assert.equal(
    submitted.rows.find((r: { id: string }) => r.id === t.people.student!.id).submitReason,
    'manual',
  );
  await t.db.pool.query('DELETE FROM teaching_assignments WHERE teacher_id=$1', [
    t.people.teacher!.id,
  ]);
  assert.equal(
    (await t.request(endpoint, 'GET', undefined, t.people.teacher!.cookie)).statusCode,
    404,
  );
  const expired = await preview([['expired01', '过期', '学生', '', '123456']]);
  await t.restart();
  assert.equal((await confirm(expired.id)).statusCode, 409);
  assert.deepEqual((await confirm(good.id)).json(), { created: 2, added: 1, skipped: 0 });
  console.log(
    'PASS pilot imports: permissions, 500 rows, formula refusal, validation, no secret response, concurrent confirmation, forced password change, membership, stale preview, cancellation, restart receipt, atomic rollback; progress: permissions, saved timestamp, counts, browser import, filtering, failure recovery and mobile',
  );
} finally {
  await browser?.close();
  await t.close();
}
