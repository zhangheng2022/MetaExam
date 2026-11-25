import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../apps/api/dist/app.js';
import { migrate, BootstrapRepository, digestToken } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
export async function questionFixture() {
  const t = await isolatedDatabase();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const start = async () => {
    app = await createApp({ ...t.config, auth: { accountLimit: 100, ipLimit: 1000 } });
    await app.listen(0, '127.0.0.1');
    return app;
  };
  const request = async (url: string, method = 'GET', payload?: object, cookie?: string) =>
    app!
      .getHttpAdapter()
      .getInstance()
      .inject({ url: '/api/v1' + url, method, payload, headers: cookie ? { cookie } : {} });
  const password = 'question test password';
  try {
    await migrate(t.db);
    await start();
    const token = randomBytes(32).toString('hex');
    await new BootstrapRepository(t.db).issue(digestToken(token), new Date(Date.now() + 60000), {
      requestId: 'questions-fixture',
    });
    const setup = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        url: '/api/v1/setup/administrator',
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
        payload: { username: 'admin', displayName: '题库管理员', password },
      });
    assert.equal(setup.statusCode, 201, setup.body);
    const login = async (username: string) => {
      const r = await request('/auth/login', 'POST', { username, password });
      assert.equal(r.statusCode, 200, r.body);
      return { cookie: String(r.headers['set-cookie']).split(';')[0]!, id: r.json().id };
    };
    const admin = await login('admin');
    const create = async (url: string, payload: object) => {
      const r = await request(url, 'POST', payload, admin.cookie);
      assert.equal(r.statusCode, 201, r.body);
      return r.json().id as string;
    };
    const people: Record<string, { id: string; cookie: string }> = { admin };
    for (const [username, role] of [
      ['teacher', 'teacher'],
      ['other', 'teacher'],
      ['student', 'student'],
    ] as const) {
      const id = await create('/admin/users', {
        username,
        displayName: username,
        roles: [role],
        password,
      });
      await t.db.pool.query(
        'UPDATE user_credentials SET must_change_password=false WHERE user_id=$1',
        [id],
      );
      people[username] = { ...(await login(username)), id };
    }
    const courseId = await create('/admin/organizations/courses', { code: 'MATH', name: '数学' });
    const otherCourse = await create('/admin/organizations/courses', { code: 'SCI', name: '科学' });
    const classId = await create('/admin/organizations/classes', { code: 'ONE', name: '一年一班' });
    for (const teacher of ['teacher', 'other']) {
      const r = await request(
        '/admin/assignments',
        'POST',
        { teacherId: people[teacher]!.id, courseId, classId },
        admin.cookie,
      );
      assert.equal(r.statusCode, 204, r.body);
    }
    return {
      ...t,
      people,
      password,
      courseId,
      otherCourse,
      classId,
      request,
      create,
      get app() {
        return app!;
      },
      async restart() {
        await app!.close();
        await start();
      },
      async close() {
        await app?.close();
        await t.close();
      },
    };
  } catch (e) {
    await app?.close();
    await t.close();
    throw e;
  }
}
