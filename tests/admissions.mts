import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { attemptFixture } from './attempts-fixture.mts';
import {
  prepareLicenseDevice,
  verifyPublicationLicense,
  transaction,
} from '../packages/db/dist/index.js';

// Real Windows hardware collection and 30 HTTP admissions against an isolated DB.
const t = await attemptFixture();
try {
  const cookies: string[] = [];
  for (let i = 0; i < 30; i++) {
    const id = randomUUID(),
      username = 'concurrent' + i;
    await t.db.pool.query('INSERT INTO users(id,username,display_name) VALUES($1,$2,$2)', [
      id,
      username,
    ]);
    await t.db.pool.query(
      'INSERT INTO user_credentials(user_id,password_hash) SELECT $1,password_hash FROM user_credentials WHERE user_id=$2',
      [id, t.people.student!.id],
    );
    await t.db.pool.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'student')", [id]);
    await t.db.pool.query('INSERT INTO class_members(class_id,student_id) VALUES($1,$2)', [
      t.classId,
      id,
    ]);
    const login = await t.request('/auth/login', 'POST', { username, password: t.password });
    assert.equal(login.statusCode, 200, login.body);
    cookies.push(String(login.headers['set-cookie']).split(';')[0]!);
  }
  await t.activate({ maxConcurrentAttempts: 30 });
  const teacher = t.people.teacher!.cookie;
  const created = await t.request(
    '/exams',
    'POST',
    { ...t.input, name: '三十人并发入场' },
    teacher,
  );
  assert.equal(created.statusCode, 201, created.body);
  const exam = created.json().id;
  const published = await t.request(
    '/exams/' + exam + '/publish',
    'POST',
    { revision: 1 },
    teacher,
  );
  assert.equal(published.statusCode, 200, published.body);
  // Test clock adjustment, isolated database only.
  const c = await t.db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE exams DISABLE TRIGGER exams_guard');
    await c.query(
      "UPDATE exams SET starts_at=clock_timestamp()-interval '1 minute',ends_at=clock_timestamp()+interval '2 hours' WHERE id=$1",
      [exam],
    );
    await c.query('ALTER TABLE exams ENABLE TRIGGER exams_guard');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  const started = performance.now();
  const endpoint = '/my-exams/' + exam + '/start';
  const replies = await Promise.all(
    cookies.map((cookie) => t.request(endpoint, 'POST', {}, cookie)),
  );
  const elapsedMs = Math.round(performance.now() - started);
  for (const r of replies) assert.equal(r.statusCode, 200, r.body);
  assert.equal(new Set(replies.map((r) => r.json().id)).size, 30);
  assert.equal(
    (await t.db.pool.query('SELECT count(*) FROM exam_attempts WHERE exam_id=$1', [exam])).rows[0]
      .count,
    '30',
  );
  const full = await t.request(endpoint, 'POST', {}, t.people.student!.cookie);
  assert.equal(full.statusCode, 409, full.body);
  const resumed = await t.request(endpoint, 'POST', {}, cookies[0]);
  assert.equal(resumed.json().id, replies[0]!.json().id);
  const detailPath = '/attempts/' + replies[0]!.json().id;
  assert.equal(
    (await t.request(detailPath, 'GET', undefined, cookies[0])).json().instructions,
    t.instructions,
  );
  await t.restart();
  assert.equal(
    (await t.request(detailPath, 'GET', undefined, cookies[0])).json().instructions,
    t.instructions,
  );
  // Preparing device evidence must not freeze a license decision: read the latest
  // signed license under the transaction lock, including sequence/entitlements.
  const device = await prepareLicenseDevice(t.db);
  await t.activate({ maxConcurrentAttempts: 7 });
  const latest = await transaction(t.db, (client) =>
    verifyPublicationLicense(t.db, client, device),
  );
  assert.equal(latest.maxConcurrentAttempts, 7);
  await assert.rejects(
    transaction(t.db, (client) =>
      verifyPublicationLicense(t.db, client, { ...device, installationId: randomUUID() }),
    ),
  );
  writeFileSync(
    'artifacts/admissions-results.json',
    JSON.stringify(
      {
        passed: true,
        concurrent: 30,
        elapsedMs,
        checks: ['capacity', 'resume', 'restart', 'frozen instructions', 'fresh locked license'],
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS 30 concurrent HTTP admissions, capacity, restart, instructions, fresh license; ' +
      elapsedMs +
      'ms',
  );
} finally {
  await t.close();
}
