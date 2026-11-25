import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { examFixture } from './exams-fixture.mts';
import { isolatedDatabase } from './database-fixture.mts';
import { MIGRATIONS, migrate, readiness, grantRuntimeAccess } from '../packages/db/dist/index.js';
import { examPhase, validExamWindow } from '../packages/domain/dist/index.js';
const upgrade = await isolatedDatabase();
try {
  const original = execFileSync('git', ['show', '8df5c27:packages/db/src/migrations.ts'], {
    encoding: 'utf8',
  });
  assert.equal(MIGRATIONS[6]!.sql, original.split('const papers = `')[1]!.split('`;')[0]);
  await upgrade.db.pool.query(
    'CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const m of MIGRATIONS.slice(0, 7)) {
    await upgrade.db.pool.query(m.sql);
    await upgrade.db.pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
      m.version,
      m.checksum,
    ]);
  }
  await upgrade.db.pool.query('CREATE TABLE exam_roster(id integer)');
  await assert.rejects(migrate(upgrade.db));
  assert.equal((await upgrade.db.pool.query("SELECT to_regclass('exams') AS t")).rows[0].t, null);
  assert.equal(
    (await upgrade.db.pool.query('SELECT max(version) FROM schema_migrations')).rows[0].max,
    7,
  );
  await upgrade.db.pool.query('DROP TABLE exam_roster');
  await Promise.all([migrate(upgrade.db), migrate(upgrade.db)]);
  await migrate(upgrade.db);
  assert.equal(await readiness(upgrade.db), true);
  console.log('PASS V7 bytes, V8 rollback, concurrent migration and readiness');
} finally {
  await upgrade.close();
}
const t = await examFixture();
const role = 'metaexam_test_' + randomUUID().replaceAll('-', '');
let roleCreated = false;
try {
  const { admin, teacher, other, student } = t.people;
  const req = (url: string, method = 'GET', body?: object, cookie = teacher!.cookie) =>
    t.request(url, method, body, cookie);
  const create = async (body = { ...t.input }, cookie = teacher!.cookie) => {
    const r = await req('/exams', 'POST', body, cookie);
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  };
  const id = await create(),
    url = '/exams/' + id;
  assert.equal((await req('/exams', 'GET', undefined, '')).statusCode, 401);
  assert.equal((await req(url, 'GET', undefined, student!.cookie)).statusCode, 403);
  assert.equal((await req(url, 'GET', undefined, other!.cookie)).statusCode, 404);
  assert.equal((await req(url, 'GET', undefined, admin!.cookie)).statusCode, 200);
  assert.equal((await req('/my-exams', 'GET', undefined, student!.cookie)).json().total, 0);
  assert.equal((await req(url + '/roster')).json().total, 1);
  assert.equal((await req('/exams', 'POST', { ...t.input, durationMinutes: 481 })).statusCode, 400);
  assert.equal(
    (await req('/exams', 'POST', { ...t.input, endsAt: t.input.startsAt })).json().code,
    'EXAM_TIME_INVALID',
  );
  assert.equal(
    (await req('/exams', 'POST', { ...t.input, paperVersionId: randomUUID() })).json().code,
    'EXAM_PAPER_INVALID',
  );
  assert.equal(
    (await req('/exams', 'POST', { ...t.input, classIds: [randomUUID()] })).json().code,
    'EXAM_CLASSES_INVALID',
  );
  const second = await t.create('/admin/organizations/classes', { code: 'TWO', name: '二班' });
  assert.equal(
    (await req('/exams', 'POST', { ...t.input, classIds: [second] })).json().code,
    'EXAM_CLASSES_INVALID',
  );
  await t.db.pool.query(
    'INSERT INTO teaching_assignments(teacher_id,course_id,class_id) VALUES($1,$2,$3)',
    [teacher!.id, t.courseId, second],
  );
  await t.db.pool.query('INSERT INTO class_members(class_id,student_id) VALUES($1,$2)', [
    second,
    student!.id,
  ]);
  const dedup = await create({ ...t.input, classIds: [t.classId, second] });
  assert.equal((await req('/exams/' + dedup)).json().rosterCount, 1);
  // Optimistic concurrency and transactional replacement.
  const saves = await Promise.all([
    req(url, 'PATCH', { ...t.input, revision: 1 }),
    req(url, 'PATCH', { ...t.input, revision: 1 }),
  ]);
  assert.deepEqual(saves.map((r) => r.statusCode).sort(), [200, 409]);
  let revision = 2;
  const publish = () => req(url + '/publish', 'POST', { revision });
  assert.equal((await publish()).json().code, 'EXAM_LICENSE_INVALID');
  await t.activate({ features: ['question.core'] });
  assert.equal((await publish()).json().code, 'EXAM_FEATURE_MISSING');
  await t.activate({ expiresAt: new Date(Date.now() + 1800000).toISOString() });
  assert.equal((await publish()).json().code, 'EXAM_LICENSE_WINDOW');
  const valid = await t.activate();
  // Tampering and expiry are rejected by local verification; no network involved.
  await t.db.pool.query("UPDATE license_state SET raw=replace(raw,'EXAM','TAMPER') WHERE id=1");
  const tamper = JSON.parse(valid);
  tamper.signature = 'A'.repeat(86);
  await t.db.pool.query('UPDATE license_state SET raw=$1 WHERE id=1', [JSON.stringify(tamper)]);
  assert.equal((await publish()).json().code, 'EXAM_LICENSE_INVALID');
  await t.db.pool.query('UPDATE license_state SET raw=$1 WHERE id=1', [valid]);
  for (const overrides of [
    { expiresAt: new Date(Date.now() - 10000).toISOString() },
    { notBefore: new Date(Date.now() + 60000).toISOString() },
    { deviceHash: '0'.repeat(64) },
  ]) {
    const raw = await t.activate(overrides, false);
    await t.db.pool.query('UPDATE license_state SET raw=$1 WHERE id=1', [raw]);
    assert.equal((await publish()).json().code, 'EXAM_LICENSE_INVALID');
  }
  await t.db.pool.query('UPDATE license_state SET raw=$1 WHERE id=1', [valid]);
  const trusted = (await t.db.pool.query('SELECT last_trusted_at FROM license_state WHERE id=1'))
    .rows[0].last_trusted_at;
  await t.db.pool.query(
    "UPDATE license_state SET last_trusted_at=now()+interval '1 hour' WHERE id=1",
  );
  assert.equal((await publish()).json().code, 'EXAM_LICENSE_INVALID');
  await t.db.pool.query('UPDATE license_state SET last_trusted_at=$1 WHERE id=1', [trusted]);
  await t.db.pool.query('UPDATE users SET display_name=$2 WHERE id=$1', [student!.id, '新姓名']);
  assert.equal((await publish()).json().code, 'EXAM_ROSTER_STALE');
  assert.equal((await req(url, 'PATCH', { ...t.input, revision })).statusCode, 200);
  revision++;
  // More roster members than concurrency is legal: publication does not allocate seats.
  const student2 = await t.create('/admin/users', {
    username: 'student2',
    displayName: '第二学生',
    roles: ['student'],
    password: t.password,
  });
  await t.db.pool.query('INSERT INTO class_members(class_id,student_id) VALUES($1,$2)', [
    t.classId,
    student2,
  ]);
  assert.equal((await publish()).json().code, 'EXAM_ROSTER_STALE');
  assert.equal((await req(url, 'PATCH', { ...t.input, revision })).statusCode, 200);
  revision++;
  const csrf = await t.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      url: '/api/v1' + url + '/publish',
      method: 'POST',
      headers: { cookie: teacher!.cookie, origin: 'https://hostile.invalid' },
      payload: { revision },
    });
  assert.equal(csrf.statusCode, 403);
  // Inject late failure: status, snapshot and audit must roll back together.
  await t.db.pool.query(
    `CREATE FUNCTION fail_exam_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='published' THEN RAISE EXCEPTION 'TEST'; END IF;RETURN NEW;END;$$;CREATE TRIGGER z_test BEFORE UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION fail_exam_test()`,
  );
  assert.equal((await publish()).statusCode, 503);
  assert.equal((await req(url)).json().status, 'draft');
  await t.db.pool.query('DROP TRIGGER z_test ON exams;DROP FUNCTION fail_exam_test()');
  const pubs = await Promise.all([publish(), publish()]);
  for (const r of pubs) assert.equal(r.statusCode, 200, r.body);
  const detail = (await req(url)).json();
  assert.equal(detail.publicationCapacity, 1);
  assert.equal(detail.rosterCount, 2);
  assert.equal(detail.paperVersionId, t.input.paperVersionId);
  assert.equal(detail.phase, 'scheduled');
  assert.equal(
    (await req(url, 'PATCH', { ...t.input, revision: detail.revision })).json().code,
    'EXAM_IMMUTABLE',
  );
  await assert.rejects(
    t.db.pool.query('UPDATE exams SET name=$2 WHERE id=$1', [id, 'changed']),
    /EXAM_IMMUTABLE/,
  );
  await assert.rejects(
    t.db.pool.query('DELETE FROM exam_roster WHERE exam_id=$1', [id]),
    /EXAM_IMMUTABLE/,
  );
  await assert.rejects(
    t.db.pool.query('UPDATE exam_classes SET name=$2 WHERE exam_id=$1', [id, 'changed']),
    /EXAM_IMMUTABLE/,
  );
  const mine = await req('/my-exams', 'GET', undefined, student!.cookie);
  assert.equal(mine.json().total, 1);
  assert.deepEqual(
    Object.keys(mine.json().items[0]).sort(),
    [
      'id',
      'name',
      'courseName',
      'startsAt',
      'endsAt',
      'durationMinutes',
      'phase',
      'cancellationReason',
      'itemCount',
      'totalScore',
      'attemptId',
      'attemptStatus',
    ].sort(),
  );
  assert.ok(
    !mine.body.includes('答案') &&
      !mine.body.includes('paperVersionId') &&
      !mine.body.includes(student2),
  );
  // Membership and display-name changes after publication do not rewrite the roster.
  await t.db.pool.query('DELETE FROM class_members WHERE student_id=$1', [student!.id]);
  await t.db.pool.query('UPDATE users SET display_name=$2 WHERE id=$1', [student!.id, '再次修改']);
  assert.equal((await req('/my-exams', 'GET', undefined, student!.cookie)).json().total, 1);
  assert.ok((await req(url + '/roster')).body.includes('新姓名'));
  await t.restart();
  assert.equal((await req(url)).json().status, 'published');
  assert.equal(
    (await req(url + '/cancel', 'POST', { revision: detail.revision, reason: '学校调整安排' }))
      .statusCode,
    200,
  );
  assert.equal(
    (await req('/my-exams', 'GET', undefined, student!.cookie)).json().items[0].cancellationReason,
    '学校调整安排',
  );
  assert.equal(
    (await req(url + '/publish', 'POST', { revision: detail.revision + 1 })).json().code,
    'EXAM_IMMUTABLE',
  );
  const empty = await create({ ...t.input, classIds: [second] });
  assert.equal(
    (await req('/exams/' + empty + '/publish', 'POST', { revision: 1 })).json().code,
    'EXAM_ROSTER_EMPTY',
  );
  const past = await create({
    ...t.input,
    startsAt: new Date(Date.now() - 3600000).toISOString(),
    endsAt: new Date(Date.now() + 3600000).toISOString(),
  });
  assert.equal(
    (await req('/exams/' + past + '/publish', 'POST', { revision: 1 })).json().code,
    'EXAM_START_PASSED',
  );
  await t.db.pool.query('DELETE FROM teaching_assignments WHERE teacher_id=$1', [teacher!.id]);
  assert.equal((await req('/exams/' + dedup)).statusCode, 404);
  assert.equal((await req('/exams/' + dedup, 'GET', undefined, admin!.cookie)).statusCode, 200);
  await t.db.pool.query('UPDATE users SET enabled=false WHERE id=$1', [student!.id]);
  assert.equal((await req('/my-exams', 'GET', undefined, student!.cookie)).statusCode, 401);
  await t.db.pool.query('CREATE ROLE ' + role + ' NOLOGIN');
  roleCreated = true;
  await grantRuntimeAccess(t.db.pool, role, t.config.database.database);
  const c = await t.db.pool.connect();
  try {
    await c.query('SET ROLE ' + role);
    assert.equal((await c.query('SELECT * FROM exams WHERE id=$1', [id])).rowCount, 1);
    await c.query('UPDATE exams SET name=$2 WHERE id=$1', [empty, '低权限可编辑草稿']);
    await c.query('BEGIN');
    try {
      const low = randomUUID();
      await c.query(
        'INSERT INTO exams(id,owner_id,course_id,paper_version_id,name,starts_at,ends_at,duration_minutes) SELECT $2,owner_id,course_id,paper_version_id,name,starts_at,ends_at,duration_minutes FROM exams WHERE id=$1',
        [empty, low],
      );
      await c.query(
        'INSERT INTO exam_classes SELECT $2,class_id,name FROM exam_classes WHERE exam_id=$1',
        [empty, low],
      );
      await c.query(
        'INSERT INTO exam_roster SELECT $2,user_id,username,display_name FROM exam_roster WHERE exam_id=$1',
        [id, low],
      );
      await c.query(
        "UPDATE exams SET status='published',published_at=now(),license_id='role-test',license_sequence=1,publication_capacity=1 WHERE id=$1",
        [low],
      );
      await c.query(
        "UPDATE exams SET status='cancelled',cancelled_at=now(),cancellation_reason='权限验证' WHERE id=$1",
        [low],
      );
      assert.equal(
        (await c.query('SELECT status FROM exams WHERE id=$1', [low])).rows[0].status,
        'cancelled',
      );
    } finally {
      await c.query('ROLLBACK');
    }
    await assert.rejects(
      c.query('UPDATE exam_roster SET display_name=$2 WHERE exam_id=$1', [id, 'overwrite']),
      /EXAM_IMMUTABLE/,
    );
    await assert.rejects(c.query('CREATE TABLE denied(id int)'), /permission denied/);
    await c.query('RESET ROLE');
  } finally {
    c.release();
  }
  const audits = (
    await t.db.pool.query("SELECT details FROM audit_events WHERE event LIKE 'exam.%'")
  ).rows;
  assert.ok(!JSON.stringify(audits).includes('答案'));
  assert.ok(!JSON.stringify(audits).includes('新姓名'));
  const s = '2030-01-01T00:00:00Z',
    e = '2030-01-01T01:00:00Z';
  assert.equal(examPhase('published', s, e, Date.parse(s) - 1), 'scheduled');
  assert.equal(examPhase('published', s, e, Date.parse(s)), 'in_progress');
  assert.equal(examPhase('published', s, e, Date.parse(e)), 'ended');
  assert.equal(examPhase('cancelled', s, e, Date.parse(s)), 'cancelled');
  assert.equal(validExamWindow(s, e, 61), false);
  console.log(
    'PASS exam drafts/roster dedup+staleness/ownership, local license feature+window+tamper, publication rollback+idempotence, SQL immutability, student redaction, cancel, restart, role and time boundaries',
  );
} finally {
  if (roleCreated) {
    await t.db.pool.query('DROP OWNED BY ' + role);
    await t.db.pool.query('DROP ROLE ' + role);
  }
  await t.close();
}
