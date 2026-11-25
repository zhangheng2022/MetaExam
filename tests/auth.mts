import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createApp } from '../apps/api/dist/app.js';
import { migrate, BootstrapRepository, digestToken } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
const t = await isolatedDatabase();
let app;
let now = Date.now();
async function start() {
  app = await createApp(t.config, () => now);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}
function request(
  url: string,
  method = 'GET',
  payload?: object,
  cookie?: string,
  extra: Record<string, string> = {},
) {
  return app!
    .getHttpAdapter()
    .getInstance()
    .inject({ url, method, payload, headers: { ...(cookie ? { cookie } : {}), ...extra } });
}
const login = (password = 'a strong test password', cookie?: string, username = 'admin') =>
  request('/api/v1/auth/login', 'POST', { username, password }, cookie);
const cookieOf = (r: { headers: Record<string, unknown> }) =>
  String(r.headers['set-cookie']).split(';')[0]!;
try {
  await migrate(t.db);
  await start();
  const token = randomBytes(32).toString('hex');
  await new BootstrapRepository(t.db).issue(digestToken(token), new Date(Date.now() + 60000), {
    requestId: 'auth-test',
  });
  assert.equal(
    (
      await request(
        '/api/v1/setup/administrator',
        'POST',
        { username: 'admin', displayName: '测试管理员', password: 'a strong test password' },
        undefined,
        { authorization: 'Bearer ' + token },
      )
    ).statusCode,
    201,
  );
  assert.equal((await request('/api/v1/auth/me')).statusCode, 401);
  assert.equal((await request('/api/v1/admin/overview')).statusCode, 401);
  const wrong = await login('wrong password'),
    unknown = await login('wrong password', undefined, 'unknown');
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.equal(wrong.json().message, unknown.json().message);
  assert.equal(
    (
      await request(
        '/api/v1/auth/login',
        'POST',
        { username: 'admin', password: 'a strong test password' },
        undefined,
        { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' },
      )
    ).statusCode,
    403,
  );
  const signed = await login();
  assert.equal(signed.statusCode, 200, signed.body);
  let cookie = cookieOf(signed);
  assert.match(String(signed.headers['set-cookie']), /HttpOnly/i);
  assert.match(String(signed.headers['set-cookie']), /SameSite=Lax/i);
  const user = signed.json();
  assert.deepEqual(user.roles, ['admin']);
  assert.deepEqual(Object.keys(user).sort(), [
    'displayName',
    'id',
    'mustChangePassword',
    'permissions',
    'roles',
    'username',
  ]);
  const digest = createHash('sha256').update(cookie.split('=')[1]!).digest('base64url');
  assert.equal((await t.db.pool.query('SELECT id FROM auth_sessions')).rows[0].id, digest);
  await app!.close();
  await start();
  assert.equal((await request('/api/v1/auth/me', 'GET', undefined, cookie)).statusCode, 200);
  assert.equal((await request('/api/v1/admin/overview', 'GET', undefined, cookie)).statusCode, 200);
  await t.db.pool.query("UPDATE user_roles SET role_code='student' WHERE user_id=$1", [user.id]);
  assert.equal((await request('/api/v1/admin/overview', 'GET', undefined, cookie)).statusCode, 403);
  assert.deepEqual((await request('/api/v1/auth/me', 'GET', undefined, cookie)).json().roles, [
    'student',
  ]);
  await t.db.pool.query("UPDATE user_roles SET role_code='admin' WHERE user_id=$1", [user.id]);
  const replacement = await login(undefined, cookie);
  assert.equal(replacement.statusCode, 200);
  assert.equal((await request('/api/v1/auth/me', 'GET', undefined, cookie)).statusCode, 401);
  cookie = cookieOf(replacement);
  assert.equal(
    (
      await request(
        '/api/v1/diagnostics/jobs',
        'POST',
        { businessKey: 'denied', message: 'test' },
        cookie,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request('/api/v1/auth/logout', 'POST', undefined, cookie, {
        'sec-fetch-site': 'cross-site',
        origin: 'https://foreign.example',
      })
    ).statusCode,
    403,
  );
  assert.equal((await request('/api/v1/auth/logout', 'POST', undefined, cookie)).statusCode, 204);
  assert.equal((await request('/api/v1/auth/logout', 'POST', undefined, cookie)).statusCode, 204);
  assert.equal((await request('/api/v1/auth/me', 'GET', undefined, cookie)).statusCode, 401);
  cookie = cookieOf(await login());
  now += 30 * 60 * 1000;
  assert.equal((await request('/api/v1/auth/me', 'GET', undefined, cookie)).statusCode, 401);
  cookie = cookieOf(await login());
  for (let i = 0; i < 16; i++) {
    now += 29 * 60 * 1000;
    assert.equal((await request('/api/v1/auth/me', 'GET', undefined, cookie)).statusCode, 200);
  }
  now += 16 * 60 * 1000;
  assert.equal((await request('/api/v1/auth/me', 'GET', undefined, cookie)).statusCode, 401);
  await t.db.pool.query('DELETE FROM auth_throttle_buckets');
  cookie = cookieOf(await login());
  const second = cookieOf(await login());
  const change = await request(
    '/api/v1/auth/change-password',
    'POST',
    { oldPassword: 'a strong test password', newPassword: 'a changed password phrase' },
    cookie,
  );
  assert.equal(change.statusCode, 204, change.body);
  for (const c of [cookie, second])
    assert.equal((await request('/api/v1/auth/me', 'GET', undefined, c)).statusCode, 401);
  assert.equal((await login()).statusCode, 401);
  cookie = cookieOf(await login('a changed password phrase'));
  await t.db.pool.query('UPDATE users SET enabled=false WHERE id=$1', [user.id]);
  assert.equal((await request('/api/v1/auth/me', 'GET', undefined, cookie)).statusCode, 401);
  assert.equal((await login('a changed password phrase')).statusCode, 401);
  await t.db.pool.query('UPDATE users SET enabled=true WHERE id=$1', [user.id]);
  await t.db.pool.query('DELETE FROM auth_throttle_buckets');
  for (let i = 0; i < 10; i++) assert.equal((await login('wrong password')).statusCode, 401);
  await app!.close();
  await start();
  assert.equal((await login()).statusCode, 429);
  await t.db.pool.query('DELETE FROM auth_throttle_buckets');
  cookie = cookieOf(await login('a changed password phrase'));
  // Simulate an unavailable pool in this isolated API; never stop the development PostgreSQL process.
  await app!.close();
  app = await createApp({ ...t.config, database: { ...t.config.database, port: 1 } });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const unavailable = await request('/api/v1/auth/me', 'GET', undefined, cookie);
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.equal(unavailable.headers['set-cookie'], undefined);
  const events = JSON.stringify((await t.db.pool.query('SELECT * FROM audit_events')).rows);
  assert.ok(
    !events.includes('password phrase') && !events.includes(token) && !events.includes(cookie),
  );
  console.log(
    'PASS official sessions: real login, hash-only store, restart, role/disable changes, CSRF, fixation, logout, idle/absolute clocks, all-session revocation, persistent throttle, DB failure 503',
  );
} finally {
  await app?.close();
  await t.close();
}
