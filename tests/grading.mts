import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MIGRATIONS,
  migrate,
  readiness,
  gradeNextAttempt,
  grantRuntimeAccess,
  createDatabase,
} from '../packages/db/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { isolatedDatabase } from './database-fixture.mts';
import { gradingFixture } from './grading-fixture.mts';
const upgrade = await isolatedDatabase();
try {
  const original = execFileSync('git', ['show', '0bf9e93:packages/db/src/migrations.ts'], {
    encoding: 'utf8',
  });
  assert.equal(MIGRATIONS[8]!.sql, original.split('const attempts = `')[1]!.split('`;')[0]);
  await upgrade.db.pool.query(
    'CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const m of MIGRATIONS.slice(0, 9)) {
    await upgrade.db.pool.query(m.sql);
    await upgrade.db.pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
      m.version,
      m.checksum,
    ]);
  }
  await upgrade.db.pool.query('CREATE TABLE attempt_scores(id integer)');
  await assert.rejects(migrate(upgrade.db));
  assert.equal(
    (await upgrade.db.pool.query("SELECT to_regclass('exam_grading') AS t")).rows[0].t,
    null,
  );
  await upgrade.db.pool.query('DROP TABLE attempt_scores');
  await Promise.all([migrate(upgrade.db), migrate(upgrade.db)]);
  await migrate(upgrade.db);
  assert.equal(await readiness(upgrade.db), true);
  console.log('PASS V9 bytes, V10 rollback/concurrent/idempotent migration');
} finally {
  await upgrade.close();
}
const t = await gradingFixture(),
  base = `/grading/exams/${t.examId}`,
  detail = base + `/attempts/${t.attemptId}/questions/5`,
  result = `/my-exams/${t.examId}/result`;
const role = 'metaexam_test_' + randomUUID().replaceAll('-', ''),
  password = randomUUID();
let worker: ReturnType<typeof spawn> | undefined,
  roleCreated = false,
  low: ReturnType<typeof createDatabase> | undefined;
try {
  const teacher = t.people.teacher!.cookie,
    student = t.people.student!.cookie,
    admin = t.people.admin!.cookie;
  assert.equal((await t.request(base, 'GET', undefined, '')).statusCode, 401);
  assert.equal((await t.request(base, 'GET', undefined, student)).statusCode, 403);
  const hidden = (await t.request(result, 'GET', undefined, student)).json();
  assert.equal(hidden.state, 'unpublished');
  assert.equal(hidden.totalScore, null);
  assert.deepEqual(hidden.items, []);
  assert.equal((await t.request(base, 'GET', undefined, t.people.other!.cookie)).statusCode, 404);
  // Inject a failure in the fifth score to prove no partial grading survives.
  await t.db.pool.query(
    "CREATE FUNCTION fail_grade_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.position=5 THEN RAISE EXCEPTION 'TEST_GRADE_FAILURE'; END IF; RETURN NEW; END; $$; CREATE TRIGGER fail_grade_test BEFORE INSERT ON attempt_scores FOR EACH ROW EXECUTE FUNCTION fail_grade_test()",
  );
  await assert.rejects(gradeNextAttempt(t.db), /TEST_GRADE_FAILURE/);
  assert.equal((await t.db.pool.query('SELECT * FROM attempt_scores')).rowCount, 0);
  assert.equal((await t.db.pool.query('SELECT * FROM exam_grading')).rowCount, 0);
  await t.db.pool.query(
    'DROP TRIGGER fail_grade_test ON attempt_scores; DROP FUNCTION fail_grade_test()',
  );
  await t.db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  roleCreated = true;
  await grantRuntimeAccess(t.db.pool, role, t.config.database.database);
  const config = { ...t.config, database: { ...t.config.database, user: role, password } };
  low = createDatabase(config);
  await assert.rejects(low.pool.query('CREATE TABLE denied(id int)'), /permission denied/);
  const file = path.join(t.config.home, 'grading-worker.json');
  writeFileSync(file, JSON.stringify(config));
  worker = spawn(process.execPath, ['apps/worker/dist/main.js'], {
    env: { ...process.env, METAEXAM_CONFIG: file },
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let i = 0; i < 100; i++) {
    if ((await t.db.pool.query('SELECT * FROM attempt_scores')).rowCount === 5) break;
    await delay(100);
  }
  assert.equal((await t.db.pool.query('SELECT * FROM attempt_scores')).rowCount, 5);
  const scores = (
    await t.db.pool.query('SELECT score_units FROM attempt_scores ORDER BY position')
  ).rows.map((r) => r.score_units);
  assert.deepEqual(scores, [4, 4, 4, 4, null]);
  assert.equal(await gradeNextAttempt(t.db), false);
  // Review remains possible after current license becomes invalid.
  await t.db.pool.query("UPDATE license_state SET raw='invalid'");
  const sheet = await t.request(detail, 'GET', undefined, teacher);
  assert.equal(sheet.statusCode, 200, sheet.body);
  assert.ok(sheet.body.includes('秘密简答参考答案') && sheet.body.includes('考生的人工评分答案'));
  const image = base + `/attempts/${t.attemptId}/images/${t.imageId}`;
  assert.equal((await t.request(image, 'GET', undefined, teacher)).statusCode, 200);
  assert.equal((await t.request(image, 'GET', undefined, student)).statusCode, 403);
  assert.equal(
    (await t.request(base + `/attempts/${randomUUID()}/questions/1`, 'GET', undefined, teacher))
      .statusCode,
    404,
  );
  const bad = await t.app.inject({
    method: 'PUT',
    url: '/api/v1' + detail,
    headers: { cookie: teacher, origin: 'https://bad.invalid' },
    payload: { revision: 1, score: 1, comment: '' },
  });
  assert.equal(bad.statusCode, 403);
  for (const score of [-1, 2.5, 0.25])
    assert.equal(
      (await t.request(detail, 'PUT', { revision: 1, score, comment: '' }, teacher)).statusCode,
      400,
    );
  assert.equal(
    (
      await t.request(
        detail.replace(/\/5$/, '/1'),
        'PUT',
        { revision: 1, score: 1, comment: '' },
        teacher,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (await t.request(base + '/publish', 'POST', { revision: 1 }, teacher)).statusCode,
    409,
  );
  const changes = await Promise.all([
    t.request(detail, 'PUT', { revision: 1, score: 1.5, comment: '解释较完整' }, teacher),
    t.request(detail, 'PUT', { revision: 1, score: 1, comment: '另一个评分' }, admin),
  ]);
  assert.deepEqual(changes.map((r) => r.statusCode).sort(), [200, 409]);
  const current = (await t.request(detail, 'GET', undefined, teacher)).json().items[0];
  assert.equal(current.revision, 2);
  const updated = await t.request(
    detail,
    'PUT',
    { revision: 2, score: 1.5, comment: '解释较完整' },
    teacher,
  );
  assert.equal(updated.statusCode, 200);
  // Real low-privilege API exercises manual write grants, then publication.
  const runtime = await createApp(config);
  await runtime.init();
  await runtime.getHttpAdapter().getInstance().ready();
  try {
    const write = await runtime.inject({
      method: 'PUT',
      url: '/api/v1' + detail,
      headers: { cookie: teacher },
      payload: { revision: 3, score: 1.5, comment: '解释较完整' },
    });
    assert.equal(write.statusCode, 200, write.body);
  } finally {
    await runtime.close();
  }
  await t.finish();
  let overview = (await t.request(base, 'GET', undefined, teacher)).json();
  assert.equal(overview.readyCount, 1);
  assert.equal(overview.absentCount, 1);
  assert.equal(overview.canPublish, true);
  assert.equal(
    (await t.request(base + '/publish', 'POST', { revision: overview.revision - 1 }, teacher))
      .statusCode,
    409,
  );
  const races = await Promise.all([
    t.request(base + '/publish', 'POST', { revision: overview.revision }, teacher),
    t.request(detail, 'PUT', { revision: 4, score: 1.5, comment: '解释较完整' }, teacher),
  ]);
  assert.deepEqual(races.map((r) => r.statusCode).sort(), [200, 409]);
  overview = (await t.request(base, 'GET', undefined, teacher)).json();
  const pub = await t.request(base + '/publish', 'POST', { revision: overview.revision }, teacher);
  assert.equal(pub.statusCode, 200, pub.body);
  assert.equal(
    (await t.request(base + '/publish', 'POST', { revision: 0 }, teacher)).statusCode,
    200,
  );
  assert.equal(
    (await t.request(detail, 'PUT', { revision: 5, score: 1, comment: '' }, teacher)).statusCode,
    409,
  );
  for (const sql of [
    "UPDATE attempt_scores SET score_units=0,revision=revision+1 WHERE mode='manual'",
    'DELETE FROM attempt_scores',
    'UPDATE exam_grading SET published_at=null,published_by=null,revision=revision+1',
    'DELETE FROM exam_grading',
  ])
    await assert.rejects(low.pool.query(sql), /GRADES_IMMUTABLE/);
  const visible = await t.request(result, 'GET', undefined, student);
  assert.equal(visible.statusCode, 200);
  assert.equal(visible.json().totalScore, 9.5);
  assert.equal(visible.json().items[4].comment, '解释较完整');
  for (const secret of [
    'referenceAnswer',
    '秘密',
    '考生的人工评分答案',
    'paperVersionId',
    'username',
  ])
    assert.ok(!visible.body.includes(secret));
  assert.equal((await t.request(result, 'GET', undefined, t.second.cookie)).json().state, 'absent');
  const restarted = await createApp(t.config);
  await restarted.init();
  await restarted.getHttpAdapter().getInstance().ready();
  try {
    const r = await restarted.inject({
      method: 'GET',
      url: '/api/v1' + result,
      headers: { cookie: student },
    });
    assert.equal(r.json().totalScore, 9.5);
  } finally {
    await restarted.close();
  }
  const assignments = (
    await t.db.pool.query('DELETE FROM teaching_assignments WHERE teacher_id=$1 RETURNING *', [
      t.people.teacher!.id,
    ])
  ).rows;
  assert.ok(assignments.length > 0);
  assert.equal((await t.request(base, 'GET', undefined, teacher)).statusCode, 404);
  assert.equal((await t.request(base, 'GET', undefined, admin)).statusCode, 200);
  const audits = JSON.stringify(
    (await t.db.pool.query("SELECT details FROM audit_events WHERE event LIKE 'grading.%'")).rows,
  );
  assert.ok(
    !audits.includes('秘密') &&
      !audits.includes('考生的人工评分答案') &&
      !audits.includes('解释较完整'),
  );
  console.log(
    'PASS real restricted Worker grading, rollback/retry, five types, revision races, ownership/CSRF, immutable release, absent result, redaction and restart',
  );
} finally {
  if (worker?.pid && worker.exitCode === null)
    execFileSync('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  await low?.pool.end();
  if (roleCreated) {
    await t.db.pool.query('DROP OWNED BY ' + role);
    await t.db.pool.query('DROP ROLE ' + role);
  }
  await t.close();
}

const pendingFixture = await gradingFixture();
try {
  const t = pendingFixture,
    teacher = t.people.teacher!.cookie;
  const entered = await t.request(`/my-exams/${t.examId}/start`, 'POST', {}, t.second.cookie);
  assert.equal(entered.statusCode, 200, entered.body);
  await gradeNextAttempt(t.db);
  await t.finish();
  const base = `/grading/exams/${t.examId}`;
  assert.equal(
    (await t.request(base + '/publish', 'POST', { revision: 1 }, teacher)).statusCode,
    409,
  );
  assert.equal(
    (
      await t.request(
        base + `/attempts/${t.attemptId}/questions/5`,
        'PUT',
        { revision: 1, score: 0, comment: '' },
        teacher,
      )
    ).statusCode,
    200,
  );
  const state = (await t.request(base, 'GET', undefined, teacher)).json();
  assert.equal(state.pendingCount, 0);
  assert.equal(state.activeCount, 1);
  assert.equal(state.canPublish, false);
  assert.equal(
    (await t.request(base + '/publish', 'POST', { revision: state.revision }, teacher)).statusCode,
    409,
  );
  await assert.rejects(
    t.db.pool.query(
      'UPDATE exam_grading SET published_at=clock_timestamp(),published_by=$1,revision=revision+1',
      [t.people.teacher!.id],
    ),
    /GRADING_NOT_READY/,
  );
  console.log('PASS unfinished grading and active attempts prevent release after exam end');
} finally {
  await pendingFixture.close();
}
