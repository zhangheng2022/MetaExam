import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../apps/api/dist/app.js';
import {
  migrate,
  BootstrapRepository,
  digestToken,
  MIGRATIONS,
  readiness,
} from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
const t = await isolatedDatabase();
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  // Upgrade a real V3 database with an existing administrator and organization.
  await t.db.pool.query(
    'CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const migration of MIGRATIONS.slice(0, 3)) {
    await t.db.pool.query(migration.sql);
    await t.db.pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
      migration.version,
      migration.checksum,
    ]);
  }
  await t.db.pool.query(
    "INSERT INTO classes(id,code,name) VALUES('10000000-0000-4000-8000-000000000001','old','原有班级')",
  );
  await Promise.all([migrate(t.db), migrate(t.db)]);
  assert.ok(await readiness(t.db));
  assert.equal(
    (await t.db.pool.query("SELECT name,revision FROM classes WHERE code='old'")).rows[0].revision,
    1,
  );
  app = await createApp({ ...t.config, auth: { accountLimit: 100, ipLimit: 500 } });
  await app.init();
  const api = app.getHttpAdapter().getInstance();
  await api.ready();
  const request = (url: string, method = 'GET', payload?: object, cookie?: string) =>
    api.inject({ url: '/api/v1' + url, method, payload, headers: cookie ? { cookie } : {} });
  const token = randomBytes(32).toString('hex');
  await new BootstrapRepository(t.db).issue(digestToken(token), new Date(Date.now() + 60000), {
    requestId: 'management',
  });
  assert.equal(
    (
      await api.inject({
        url: '/api/v1/setup/administrator',
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
        payload: { username: 'admin', displayName: '管理员', password: 'admin password phrase' },
      })
    ).statusCode,
    201,
  );
  const login = async (username: string, password: string) => {
    const r = await request('/auth/login', 'POST', { username, password });
    assert.equal(r.statusCode, 200, r.body);
    return { cookie: String(r.headers['set-cookie']).split(';')[0]!, user: r.json() };
  };
  let admin = await login('admin', 'admin password phrase');
  const create = async (username: string, roles: string[]) => {
    const r = await request(
      '/admin/users',
      'POST',
      { username, displayName: username, roles, password: 'temporary password phrase' },
      admin.cookie,
    );
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  };
  const teacherId = await create('teacher', ['teacher']);
  const studentId = await create('student', ['student']);
  await create('outsider', ['student']);
  const otherAdminId = await create('admin2', ['admin']);
  const force = await login('teacher', 'temporary password phrase');
  assert.equal(force.user.mustChangePassword, true);
  assert.equal((await request('/teaching/me', 'GET', undefined, force.cookie)).statusCode, 403);
  const activate = async (username: string) => {
    const temp = await login(username, 'temporary password phrase');
    assert.equal(
      (
        await request(
          '/auth/change-password',
          'POST',
          { oldPassword: 'temporary password phrase', newPassword: 'personal password phrase' },
          temp.cookie,
        )
      ).statusCode,
      204,
    );
    assert.equal((await request('/auth/me', 'GET', undefined, temp.cookie)).statusCode, 401);
    return login(username, 'personal password phrase');
  };
  const teacher = await activate('teacher'),
    student = await activate('student'),
    outsider = await activate('outsider'),
    admin2 = await activate('admin2');
  assert.equal((await request('/admin/users')).statusCode, 401);
  for (const endpoint of [
    '/admin/users',
    '/admin/organizations/classes',
    '/admin/assignments',
    '/admin/audit-events',
  ])
    assert.equal((await request(endpoint, 'GET', undefined, teacher.cookie)).statusCode, 403);
  assert.equal(
    (await request('/admin/users?pageSize=101', 'GET', undefined, admin.cookie)).statusCode,
    400,
  );
  assert.equal(
    (
      await request(
        '/admin/users',
        'POST',
        {
          username: 'TEACHER',
          displayName: '重复',
          roles: ['teacher'],
          password: 'temporary password phrase',
        },
        admin.cookie,
      )
    ).statusCode,
    409,
  );
  const makeOrg = async (kind: string, code: string) => {
    const r = await request(
      '/admin/organizations/' + kind,
      'POST',
      { code, name: code },
      admin.cookie,
    );
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  };
  const classId = await makeOrg('classes', 'class1'),
    courseId = await makeOrg('courses', 'math');
  const assignment = { teacherId, courseId, classId };
  for (let i = 0; i < 2; i++) {
    assert.equal(
      (await request('/admin/classes/' + classId + '/members', 'POST', { studentId }, admin.cookie))
        .statusCode,
      204,
    );
    assert.equal(
      (await request('/admin/assignments', 'POST', assignment, admin.cookie)).statusCode,
      204,
    );
  }
  assert.equal((await t.db.pool.query('SELECT count(*) FROM class_members')).rows[0].count, '1');
  assert.equal(
    (
      await request(
        '/admin/assignments',
        'POST',
        { ...assignment, teacherId: studentId },
        admin.cookie,
      )
    ).statusCode,
    409,
  );
  const mine = (
    await request('/teaching/me?userId=' + studentId, 'GET', undefined, outsider.cookie)
  ).json();
  assert.deepEqual(mine, { classes: [], assignments: [] });
  assert.equal(
    (await request('/teaching/me', 'GET', undefined, student.cookie)).json().classes.length,
    1,
  );
  assert.equal(
    (await request('/teaching/me', 'GET', undefined, teacher.cookie)).json().assignments.length,
    1,
  );
  const userRow = async (id: string) =>
    (await request('/admin/users?pageSize=100', 'GET', undefined, admin.cookie))
      .json()
      .items.find((u: { id: string }) => u.id === id);
  const edit = (
    u: { id: string; displayName: string; enabled: boolean; roles: string[]; revision: number },
    values: object,
    cookie = admin.cookie,
  ) =>
    request(
      '/admin/users/' + u.id,
      'PATCH',
      {
        displayName: u.displayName,
        enabled: u.enabled,
        roles: u.roles,
        revision: u.revision,
        ...values,
      },
      cookie,
    );
  assert.equal(
    (await edit(await userRow(teacherId), { roles: ['student'] })).json().code,
    'ROLE_IN_USE',
  );
  assert.equal(
    (await edit(await userRow(admin.user.id), { enabled: false })).json().code,
    'SELF_DISABLE',
  );
  const teacherRow = await userRow(teacherId);
  assert.equal((await edit(teacherRow, { displayName: '新姓名' })).statusCode, 204);
  assert.equal(
    (await edit(teacherRow, { displayName: '旧版本覆盖' })).json().code,
    'EDIT_CONFLICT',
  );
  const beforeReset = await userRow(teacherId);
  assert.equal(
    (
      await request(
        '/admin/users/' + teacherId + '/reset-password',
        'POST',
        { password: 'reset password phrase', revision: beforeReset.revision },
        admin.cookie,
      )
    ).statusCode,
    204,
  );
  assert.equal((await request('/auth/me', 'GET', undefined, teacher.cookie)).statusCode, 401);
  assert.equal((await login('teacher', 'reset password phrase')).user.mustChangePassword, true);
  assert.equal((await edit(await userRow(studentId), { enabled: false })).statusCode, 204);
  assert.equal((await request('/auth/me', 'GET', undefined, student.cookie)).statusCode, 401);
  assert.equal(
    (await request('/admin/classes/' + classId + '/members', 'GET', undefined, admin.cookie)).json()
      .total,
    1,
  );
  assert.equal(
    (await request('/admin/classes/' + classId + '/members', 'POST', { studentId }, admin.cookie))
      .statusCode,
    409,
  );
  // Concurrent self-demotions must leave one administrator, even across different sessions.
  const adminRow = await userRow(admin.user.id),
    admin2Row = await userRow(otherAdminId);
  const demotions = await Promise.all([
    edit(adminRow, { roles: ['teacher'] }, admin.cookie),
    edit(admin2Row, { roles: ['teacher'] }, admin2.cookie),
  ]);
  assert.deepEqual(demotions.map((r) => r.statusCode).sort(), [204, 409]);
  assert.equal(demotions.find((r) => r.statusCode === 409)!.json().code, 'LAST_ADMIN');
  admin = demotions[0].statusCode === 204 ? admin2 : admin;
  const logs = await request(
    '/admin/audit-events?q=user.password.reset',
    'GET',
    undefined,
    admin.cookie,
  );
  assert.equal(logs.statusCode, 200);
  assert.ok(logs.json().items.some((e: { targetId: string }) => e.targetId === teacherId));
  const serialized = JSON.stringify((await t.db.pool.query('SELECT * FROM audit_events')).rows);
  for (const secret of [
    'temporary password phrase',
    'reset password phrase',
    'password_hash',
    admin.cookie,
  ])
    assert.ok(!serialized.includes(secret));
  assert.equal(
    (await request('/admin/assignments', 'DELETE', assignment, admin.cookie)).statusCode,
    204,
  );
  assert.equal(
    (await request('/admin/assignments', 'DELETE', assignment, admin.cookie)).statusCode,
    204,
  );
  await app.close();
  app = await createApp(t.config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  assert.equal(
    (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({ url: '/api/v1/admin/users', headers: { cookie: admin.cookie } })
    ).statusCode,
    200,
  );
  console.log(
    'PASS V3 upgrade, management permissions, forced change/reset/disable, isolated teaching, duplicate/conflict/role invariants, concurrent last-admin protection, sanitized audit and restart',
  );
} finally {
  await app?.close();
  await t.close();
}
