import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createApp } from '../apps/api/dist/app.js';
import {
  createDatabase,
  grantRuntimeAccess,
  ReportRepository,
  processFile,
} from '../packages/db/dist/index.js';
import { reportFiltersSchema, type ResultExport } from '../packages/contracts/dist/index.js';
import { reportFixture } from './reports-fixture.mts';
const ExcelJS = createRequire(path.resolve('packages/db/package.json'))('exceljs');
const t = await reportFixture({ publish: false }),
  base = '/reports/exams/' + t.examId;
const role = 'metaexam_test_' + randomUUID().replaceAll('-', '');
let roleCreated = false;
mkdirSync('artifacts/m2-reports', { recursive: true });
try {
  const teacher = t.people.teacher!.cookie,
    student = t.people.student!.cookie;
  assert.equal((await t.request(base, 'GET', undefined, '')).statusCode, 401);
  assert.equal((await t.request(base, 'GET', undefined, student)).statusCode, 403);
  assert.equal((await t.request(base, 'GET', undefined, t.people.other!.cookie)).statusCode, 404);
  for (const method of ['GET', 'POST'])
    assert.equal(
      (
        await t.request(
          base + (method === 'POST' ? '/export' : ''),
          method,
          method === 'POST' ? {} : undefined,
          teacher,
        )
      ).statusCode,
      409,
    );
  await t.publish();
  const report = (await t.request(base, 'GET', undefined, teacher)).json();
  assert.deepEqual(
    [
      report.statistics.rosterCount,
      report.statistics.presentCount,
      report.statistics.absentCount,
      report.statistics.average,
      report.statistics.median,
      report.statistics.passRate,
    ],
    [3, 2, 1, 4.75, 4.75, 50],
  );
  assert.equal(report.questions[4].average, 0.75);
  assert.equal(report.questions[4].scoreRate, 37.5);
  assert.equal(report.questions[0].fullCount, 1);
  assert.equal(report.questions[0].zeroCount, 1);
  assert.equal(
    (await t.request(base + '?passPercent=96', 'GET', undefined, teacher)).json().statistics
      .passedCount,
    0,
  );
  for (const q of [
    'passPercent=-1',
    'passPercent=101',
    'passPercent=0.5',
    'passPercent=NaN',
    'userId=someone',
  ])
    assert.equal((await t.request(base + '?' + q, 'GET', undefined, teacher)).statusCode, 400);
  const list = (
    await t.request(base + '/records?sort=score_asc&pageSize=1&page=2', 'GET', undefined, teacher)
  ).json();
  assert.equal(list.total, 3);
  assert.equal(list.items[0].score, 9.5);
  const missing = (
    await t.request(base + '/records?status=absent', 'GET', undefined, teacher)
  ).json().items[0];
  assert.equal(missing.username, '00007');
  assert.equal(missing.displayName, '=2+3');
  assert.equal(missing.score, null);
  const only = (await t.request(base + '/records?q=SECOND', 'GET', undefined, teacher)).json();
  assert.equal(only.total, 1);
  assert.equal(only.items[0].score, 0);
  assert.equal(
    (
      await t.request(
        base + '/records?q=' + encodeURIComponent("' OR 1=1--"),
        'GET',
        undefined,
        teacher,
      )
    ).json().total,
    0,
  );
  assert.equal(
    (await t.request(base + '/records?sort=unknown', 'GET', undefined, teacher)).statusCode,
    400,
  );
  const csrf = await t.app.inject({
    method: 'POST',
    url: '/api/v1' + base + '/export',
    headers: { cookie: teacher, origin: 'https://bad.invalid' },
    payload: {},
  });
  assert.equal(csrf.statusCode, 403);
  assert.equal((await t.request(base + '/export', 'POST', { page: 1 }, teacher)).statusCode, 400);
  // Competing requests for one teacher are bounded before workbook allocation.
  const pair = await Promise.all([
    t.request(base + '/export', 'POST', { sort: 'score_desc' }, teacher),
    t.request(base + '/export', 'POST', { sort: 'score_desc' }, teacher),
  ]);
  assert.deepEqual(pair.map((r) => r.statusCode).sort(), [200, 429]);
  const exported = pair.find((r) => r.statusCode === 200)!;
  assert.ok(exported.headers['content-type'].includes('spreadsheetml'));
  assert.equal(exported.headers['cache-control'], 'no-store');
  assert.equal(
    exported.headers['content-disposition'],
    `attachment; filename="MetaExam-results-${t.examId}.xlsx"`,
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.rawPayload);
  assert.deepEqual(
    workbook.worksheets.map((s: { name: string }) => s.name),
    ['统计概览', '成绩名单', '逐题统计'],
  );
  const roster = workbook.getWorksheet('成绩名单');
  assert.equal(roster.rowCount, 4);
  assert.equal(roster.getCell('A4').value, '00007');
  assert.equal(roster.getCell('B4').value, '=2+3');
  assert.equal(roster.getCell('D4').value, null);
  assert.equal(roster.getCell('D3').value, 0);
  for (const sheet of workbook.worksheets)
    sheet.eachRow((row: { eachCell: (f: (cell: { type: number }) => void) => void }) =>
      row.eachCell((cell) => {
        assert.notEqual(cell.type, ExcelJS.ValueType.Formula);
        assert.notEqual(cell.type, ExcelJS.ValueType.Hyperlink);
      }),
    );
  const serialized = JSON.stringify(workbook.model);
  for (const secret of ['秘密', '考生原文不导出', '内部评语不导出', 'password', 'referenceAnswer'])
    assert.ok(!serialized.includes(secret));
  const filtered = await t.request(
    base + '/export',
    'POST',
    { q: '=2+3', status: 'absent' },
    teacher,
  );
  assert.equal(filtered.statusCode, 200);
  const filteredBook = new ExcelJS.Workbook();
  await filteredBook.xlsx.load(filtered.rawPayload);
  assert.equal(filteredBook.getWorksheet('成绩名单').rowCount, 2);
  assert.equal(
    (await t.request(base + '/export', 'POST', { q: '不存在' }, teacher)).statusCode,
    200,
  );
  // Updating live identity does not rewrite the publication's roster snapshot.
  await t.db.pool.query("UPDATE users SET display_name='现在的新姓名' WHERE id=$1", [
    t.people.student!.id,
  ]);
  assert.equal(
    (await t.request(base + '/records?q=student', 'GET', undefined, teacher))
      .json()
      .items.find((r: { username: string }) => r.username === 'student').displayName,
    'student',
  );
  await t.db.pool.query("UPDATE license_state SET raw='invalid'");
  assert.equal((await t.request(base, 'GET', undefined, teacher)).statusCode, 200);
  await t.db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'report-temporary-password'`);
  roleCreated = true;
  await grantRuntimeAccess(t.db.pool, role, t.config.database.database);
  const runtime = await createApp({
    ...t.config,
    database: { ...t.config.database, user: role, password: 'report-temporary-password' },
  });
  await runtime.init();
  await runtime.getHttpAdapter().getInstance().ready();
  try {
    const response = await runtime.inject({
      method: 'POST',
      url: '/api/v1' + base + '/export',
      headers: { cookie: teacher },
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body.slice(0, 80));
  } finally {
    await runtime.close();
  }
  const repository = new ReportRepository(t.db),
    prepared = await repository.prepare(
      t.people.teacher!.id,
      t.examId,
      reportFiltersSchema.parse({}),
    );
  await t.db.pool.query('DELETE FROM teaching_assignments WHERE teacher_id=$1', [
    t.people.teacher!.id,
  ]);
  await assert.rejects(
    repository.authorizeDownload(t.people.teacher!.id, t.examId, prepared, {
      requestId: 'revoked',
    }),
  );
  assert.equal((await t.request(base + '/export', 'POST', {}, teacher)).statusCode, 404);
  assert.equal((await t.request(base, 'GET', undefined, t.people.admin!.cookie)).statusCode, 200);
  const audits = (
    await t.db.pool.query("SELECT details FROM audit_events WHERE event='results.export'")
  ).rows;
  assert.ok(audits.length >= 3);
  assert.ok(!JSON.stringify(audits).includes('=2+3'));
  const maxData: ResultExport = {
    ...prepared,
    records: Array.from({ length: 5000 }, (_, i) => ({
      ...prepared.records[0]!,
      id: randomUUID(),
      username: String(i).padStart(8, '0'),
      displayName: i % 2 ? '=SUM(1,2)' : '@literal',
    })),
  };
  const started = performance.now(),
    bytes = Buffer.from(
      await processFile<Uint8Array>('results', Buffer.from(JSON.stringify(maxData))),
    );
  const large = new ExcelJS.Workbook();
  await large.xlsx.load(bytes);
  assert.equal(large.getWorksheet('成绩名单').rowCount, 5001);
  assert.equal(large.getWorksheet('成绩名单').getCell('A2').value, '00000000');
  writeFileSync(
    'artifacts/m2-reports/export-limit-results.json',
    JSON.stringify(
      { rows: 5000, bytes: bytes.length, durationMs: Math.round(performance.now() - started) },
      null,
      2,
    ),
  );
  await assert.rejects(
    processFile(
      'results',
      Buffer.from(
        JSON.stringify({ ...maxData, records: [...maxData.records, maxData.records[0]] }),
      ),
    ),
  );
  const unavailable = createDatabase({ ...t.config, database: { ...t.config.database, port: 1 } });
  try {
    await assert.rejects(
      new ReportRepository(unavailable).summary(t.people.admin!.id, t.examId, 60),
    );
  } finally {
    await unavailable.pool.end();
  }
  console.log(
    'PASS published-only statistics, filters/sort/pagination, safe XLSX/5000-row bound, CSRF/ownership/recheck, restricted runtime export and audit',
  );
} finally {
  if (roleCreated) {
    await t.db.pool.query('DROP OWNED BY ' + role);
    await t.db.pool.query('DROP ROLE ' + role);
  }
  await t.close();
}
const absent = await reportFixture({ allAbsent: true });
try {
  const r = (
    await absent.request(
      '/reports/exams/' + absent.examId,
      'GET',
      undefined,
      absent.people.teacher!.cookie,
    )
  ).json();
  assert.equal(r.statistics.presentCount, 0);
  assert.equal(r.statistics.average, null);
  assert.equal(r.statistics.passRate, null);
  assert.ok(
    r.questions.every(
      (q: { average: number | null; gradedCount: number }) =>
        q.average === null && q.gradedCount === 0,
    ),
  );
  console.log('PASS all-absent results use null metrics');
} finally {
  await absent.close();
}
