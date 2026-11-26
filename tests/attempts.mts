import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { attemptFixture } from './attempts-fixture.mts';
import { isolatedDatabase } from './database-fixture.mts';
import { MIGRATIONS, migrate, readiness, grantRuntimeAccess } from '../packages/db/dist/index.js';
import type { CandidateQuestion, CandidateAnswer } from '../packages/contracts/dist/index.js';
const upgrade = await isolatedDatabase();
try {
  const original = execFileSync('git', ['show', '2b2c423:packages/db/src/migrations.ts'], {
    encoding: 'utf8',
  });
  assert.equal(MIGRATIONS[7]!.sql, original.split('const exams = `')[1]!.split('`;')[0]);
  await upgrade.db.pool.query(
    'CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const m of MIGRATIONS.slice(0, 8)) {
    await upgrade.db.pool.query(m.sql);
    await upgrade.db.pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
      m.version,
      m.checksum,
    ]);
  }
  await upgrade.db.pool.query('CREATE TABLE attempt_answers(id integer)');
  await assert.rejects(migrate(upgrade.db));
  assert.equal(
    (await upgrade.db.pool.query("SELECT to_regclass('exam_attempts') AS t")).rows[0].t,
    null,
  );
  await upgrade.db.pool.query('DROP TABLE attempt_answers');
  await Promise.all([migrate(upgrade.db), migrate(upgrade.db)]);
  await migrate(upgrade.db);
  assert.equal(await readiness(upgrade.db), true);
  console.log('PASS V8 preservation, V9 rollback/concurrent retry');
} finally {
  await upgrade.close();
}
const t = await attemptFixture();
let worker: ReturnType<typeof spawn> | undefined;
const role = 'metaexam_test_' + randomUUID().replaceAll('-', '');
let roleCreated = false;
try {
  const start = '/my-exams/' + t.examId + '/start',
    first = t.people.student!,
    teacher = t.people.teacher!;
  assert.equal((await t.request(start, 'POST', {}, '')).statusCode, 401);
  assert.equal((await t.request(start, 'POST', {}, teacher.cookie)).statusCode, 403);
  assert.equal(
    (await t.request(start, 'POST', {}, first.cookie)).json().code,
    'ATTEMPT_TIME_WINDOW',
  );
  await t.open();
  assert.equal(
    (
      await t.request(
        start,
        'POST',
        { licenseId: 'forged', deadlineAt: '2099-01-01T00:00:00Z' },
        first.cookie,
      )
    ).statusCode,
    400,
  );
  const csrf = await t.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      url: '/api/v1' + start,
      method: 'POST',
      headers: { cookie: first.cookie, origin: 'https://invalid.example' },
      payload: {},
    });
  assert.equal(csrf.statusCode, 403);
  const people = [first, t.second];
  const started = await Promise.all(people.map((p) => t.request(start, 'POST', {}, p.cookie)));
  assert.deepEqual(started.map((r) => r.statusCode).sort(), [200, 409]);
  const wi = started.findIndex((r) => r.statusCode === 200),
    winner = people[wi]!,
    loser = people[1 - wi]!,
    id = started[wi]!.json().id as string,
    base = '/attempts/' + id;
  const req = (url: string, method = 'GET', body?: object, cookie = winner.cookie) =>
    t.request(url, method, body, cookie);
  const repeat = await Promise.all([req(start, 'POST', {}), req(start, 'POST', {})]);
  for (const r of repeat) assert.equal(r.json().id, id);
  assert.equal((await t.db.pool.query('SELECT count(*) FROM exam_attempts')).rows[0].count, '1');
  assert.equal((await req(base, 'GET', undefined, loser.cookie)).statusCode, 404);
  assert.equal((await req(base + '/questions/1', 'GET', undefined, loser.cookie)).statusCode, 404);
  const detail = (await req(base)).json();
  assert.equal(detail.instructions, t.instructions);
  assert.equal((await req(base + '/images/' + t.imageId)).headers['content-type'], 'image/png');
  assert.equal(
    (await req(base + '/images/' + t.imageId, 'GET', undefined, loser.cookie)).statusCode,
    404,
  );
  assert.equal((await req(base + '/images/' + randomUUID())).statusCode, 404);
  assert.equal(
    (await req(`/question-banks/${t.bank}/attachments/${t.imageId}/content`)).statusCode,
    403,
  );
  assert.equal(detail.items.length, 5);
  assert.ok(Date.parse(detail.deadlineAt) <= Date.parse(detail.startedAt) + 3600000);
  const stop = await t.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      url: '/api/v1/maintenance/stop',
      method: 'POST',
      headers: { authorization: 'Bearer ' + t.config.api.managementToken },
    });
  assert.equal(stop.statusCode, 409);
  let globalRevision = 0;
  for (let position = 1; position <= 5; position++) {
    const route = base + '/questions/' + position,
      r = await req(route);
    assert.equal(r.statusCode, 200, r.body);
    const q = r.json() as CandidateQuestion;
    assert.ok(
      !r.body.includes('秘密') &&
        !r.body.includes('referenceAnswer') &&
        !r.body.includes('explanation') &&
        !r.body.includes('caseSensitive'),
    );
    const answer: CandidateAnswer =
      q.content.type === 'boolean'
        ? { type: 'boolean', value: false }
        : q.content.type === 'single'
          ? { type: 'single', optionId: t.a }
          : q.content.type === 'multiple'
            ? { type: 'multiple', optionIds: [t.a, t.b] }
            : q.content.type === 'blank'
              ? { type: 'blank', values: [{ id: t.blank, value: '我的填空' }] }
              : { type: 'essay', text: '我的简答' };
    assert.equal(
      (
        await req(route, 'PUT', {
          revision: 0,
          mutationId: randomUUID(),
          answer: { type: 'single', optionId: randomUUID() },
        })
      ).statusCode,
      400,
    );
    const body = { revision: 0, mutationId: randomUUID(), answer };
    const saved = await req(route, 'PUT', body);
    assert.equal(saved.statusCode, 200, saved.body);
    globalRevision = saved.json().attemptRevision;
    assert.equal((await req(route, 'PUT', body)).json().revision, 1);
    assert.equal(
      (await req(route, 'PUT', { ...body, answer: null })).json().code,
      'ANSWER_MUTATION_REUSED',
    );
    assert.equal(
      (await req(route, 'PUT', { ...body, mutationId: randomUUID() })).json().code,
      'ANSWER_CONFLICT',
    );
    assert.deepEqual((await req(route)).json().answer, answer);
  }
  const races = await Promise.all([
    req(base + '/questions/1', 'PUT', {
      revision: 1,
      mutationId: randomUUID(),
      answer: { type: 'boolean', value: true },
    }),
    req(base + '/questions/1', 'PUT', { revision: 1, mutationId: randomUUID(), answer: null }),
  ]);
  assert.deepEqual(races.map((r) => r.statusCode).sort(), [200, 409]);
  globalRevision++;
  const expired = await t.activate({ expiresAt: new Date(Date.now() - 1000).toISOString() }, false);
  await t.db.pool.query('UPDATE license_state SET raw=$1 WHERE id=1', [expired]);
  assert.equal((await req(start, 'POST', {})).json().id, id);
  assert.equal((await req(base + '/questions/2')).statusCode, 200);
  assert.equal((await req(start, 'POST', {}, loser.cookie)).json().code, 'EXAM_LICENSE_INVALID');
  assert.equal(
    (
      await req(base + '/questions/5', 'PUT', {
        revision: 1,
        mutationId: randomUUID(),
        answer: { type: 'essay', text: '到期后继续已授权作答' },
      })
    ).statusCode,
    200,
  );
  globalRevision++;
  await t.restart();
  assert.equal((await req(base)).json().revision, globalRevision);
  assert.equal(
    (await req(base + '/submit', 'POST', { revision: 0 })).json().code,
    'ANSWER_CONFLICT',
  );
  const submits = await Promise.all([
    req(base + '/submit', 'POST', { revision: globalRevision }),
    req(base + '/submit', 'POST', { revision: globalRevision }),
  ]);
  for (const r of submits) assert.equal(r.statusCode, 200, r.body);
  assert.equal((await req(base)).json().status, 'submitted');
  assert.equal((await req(base + '/images/' + t.imageId)).statusCode, 409);
  assert.equal((await req(base + '/questions/1')).json().code, 'ATTEMPT_CLOSED');
  assert.equal((await req(start, 'POST', {})).json().id, id);
  await assert.rejects(
    t.db.pool.query(
      "UPDATE exam_attempts SET deadline_at=deadline_at+interval '1 hour' WHERE id=$1",
      [id],
    ),
    /ATTEMPT_IMMUTABLE/,
  );
  await assert.rejects(
    t.db.pool.query('UPDATE attempt_answers SET answer=null WHERE attempt_id=$1', [id]),
    /ATTEMPT_CLOSED/,
  );
  await t.activate();
  const next = await req(start, 'POST', {}, loser.cookie);
  assert.equal(next.statusCode, 200, next.body);
  const nextId = next.json().id as string;
  await t.db.pool.query('CREATE ROLE ' + role + ' NOLOGIN');
  roleCreated = true;
  await grantRuntimeAccess(t.db.pool, role, t.config.database.database);
  // Exercise the real runtime grants and triggers, then roll back to keep timeout fixture intact.
  const writer = await t.db.pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('SET LOCAL ROLE ' + role);
    await writer.query(
      'INSERT INTO attempt_answers(attempt_id,position,answer,revision,mutation_id,saved_at) VALUES($1,1,$2,1,$3,clock_timestamp())',
      [nextId, JSON.stringify({ type: 'boolean', value: true }), randomUUID()],
    );
    await writer.query(
      'UPDATE attempt_answers SET answer=$2,revision=2,mutation_id=$3 WHERE attempt_id=$1',
      [nextId, JSON.stringify({ type: 'boolean', value: false }), randomUUID()],
    );
    await writer.query('UPDATE exam_attempts SET revision=revision+1 WHERE id=$1', [nextId]);
    await writer.query(
      "UPDATE exam_attempts SET status='submitted',submit_reason='manual',submitted_at=clock_timestamp() WHERE id=$1",
      [nextId],
    );
    assert.equal(
      (await writer.query('SELECT status FROM exam_attempts WHERE id=$1', [nextId])).rows[0].status,
      'submitted',
    );
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
  // Simulate elapsed server deadline in this isolated DB, then run the real Worker.
  const c = await t.db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE exam_attempts DISABLE TRIGGER exam_attempts_guard');
    await c.query(
      "UPDATE exam_attempts SET started_at=clock_timestamp()-interval '10 seconds',deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [nextId],
    );
    await c.query('ALTER TABLE exam_attempts ENABLE TRIGGER exam_attempts_guard');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  const configFile = path.join(t.config.home, 'worker.json');
  writeFileSync(configFile, JSON.stringify(t.config));
  worker = spawn(process.execPath, ['apps/worker/dist/main.js'], {
    env: { ...process.env, METAEXAM_CONFIG: configFile },
    stdio: 'ignore',
    windowsHide: true,
  });
  let closed = false;
  for (let i = 0; i < 60; i++) {
    closed =
      (await t.db.pool.query('SELECT status FROM exam_attempts WHERE id=$1', [nextId])).rows[0]
        .status === 'submitted';
    if (closed) break;
    await delay(100);
  }
  assert.equal(closed, true);
  const receipt = (await req('/attempts/' + nextId, 'GET', undefined, loser.cookie)).json();
  assert.equal(receipt.submitReason, 'timeout');
  assert.equal(
    (
      await req(
        '/attempts/' + nextId + '/questions/1',
        'PUT',
        { revision: 0, mutationId: randomUUID(), answer: null },
        loser.cookie,
      )
    ).statusCode,
    409,
  );
  const low = await t.db.pool.connect();
  try {
    await low.query('SET ROLE ' + role);
    assert.equal((await low.query('SELECT * FROM exam_attempts')).rowCount, 2);
    await assert.rejects(low.query('CREATE TABLE denied(id int)'), /permission denied/);
    await assert.rejects(low.query('DELETE FROM exam_attempts'), /ATTEMPT_IMMUTABLE/);
    await low.query('RESET ROLE');
  } finally {
    low.release();
  }
  const audits = JSON.stringify(
    (await t.db.pool.query("SELECT details FROM audit_events WHERE event LIKE 'attempt.%'")).rows,
  );
  assert.ok(!audits.includes('我的') && !audits.includes('到期后'));
  console.log(
    'PASS concurrent capacity/idempotent admission, five sanitized question/answer types, ownership/CSRF, mutation retry/conflicts, local expiry continuation, restart, immutable submission, real Worker timeout and restricted role',
  );
} finally {
  if (worker?.pid && worker.exitCode === null)
    execFileSync('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  if (roleCreated) {
    await t.db.pool.query('DROP OWNED BY ' + role);
    await t.db.pool.query('DROP ROLE ' + role);
  }
  await t.close();
}
