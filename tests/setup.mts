import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../apps/api/dist/app.js';
import { migrate, BootstrapRepository, digestToken } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
const t = await isolatedDatabase();
let app;
try {
  await migrate(t.db);
  app = await createApp(t.config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const api = app.getHttpAdapter().getInstance();
  assert.equal((await api.inject({ url: '/health/ready' })).json().schemaVersion, 8);
  const token = randomBytes(32).toString('hex');
  await new BootstrapRepository(t.db).issue(digestToken(token), new Date(Date.now() + 60000), {
    requestId: 'setup-http-test',
  });
  const payload = { username: ' Admin ', displayName: '管理员', password: 'test password phrase' };
  assert.equal(
    (
      await api.inject({
        method: 'POST',
        url: '/api/v1/setup/administrator',
        remoteAddress: '192.168.1.20',
        payload,
        headers: { authorization: 'Bearer ' + token },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await api.inject({
        method: 'POST',
        url: '/api/v1/setup/administrator',
        payload,
        headers: { authorization: 'Bearer ' + token, origin: 'https://untrusted.example' },
      })
    ).statusCode,
    403,
  );
  const r = await api.inject({
    method: 'POST',
    url: '/api/v1/setup/administrator',
    payload,
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal((await api.inject({ url: '/api/v1/setup/status' })).json().adminInitialized, true);
  assert.equal(
    (
      await api.inject({
        method: 'POST',
        url: '/api/v1/setup/administrator',
        payload,
        headers: { authorization: 'Bearer ' + token },
      })
    ).statusCode,
    409,
  );
  assert.equal((await t.db.pool.query('SELECT username FROM users')).rows[0].username, 'admin');
  const hash = (await t.db.pool.query('SELECT password_hash FROM user_credentials')).rows[0]
    .password_hash;
  assert.ok(hash.includes('scrypt'));
  console.log(
    'PASS real setup HTTP, remote/CSRF rejection, official scrypt, normalized username and replay rejection',
  );
} finally {
  await app?.close();
  await t.close();
}
