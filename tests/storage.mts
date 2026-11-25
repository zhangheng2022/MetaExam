import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/dist/app.js';
import { PgSessionStore } from '../apps/api/dist/auth/session.store.js';
import { PasswordService } from '../apps/api/dist/auth/password.service.js';
import {
  migrate,
  BootstrapRepository,
  digestToken,
  grantRuntimeAccess,
  AccountsRepository,
} from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
const t = await isolatedDatabase();
let app;
const role = 'metaexam_test_' + randomUUID().replaceAll('-', '');
let roleCreated = false;
try {
  await migrate(t.db);
  const token = randomBytes(32).toString('hex'),
    ctx = { requestId: 'storage-test' };
  const bootstrap = new BootstrapRepository(t.db);
  await bootstrap.issue(digestToken(token), new Date(Date.now() + 60000), ctx);
  const id = await bootstrap.create(
    { username: 'store_admin', displayName: 'Store', password: 'never stored' },
    token,
    'test-only-hash',
    ctx,
  );
  app = await createApp({ ...t.config, auth: { hashConcurrency: 2, hashQueue: 1 } });
  await app.init();
  const store = app.get(PgSessionStore);
  const now = new Date(),
    record = {
      id: 'digest-1',
      userId: id,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
      metadata: { credentialVersion: 1 },
    };
  await store.createSession(record);
  await store.touchSession(record.id, new Date(now.getTime() + 1000));
  await store.touchSession(record.id, now);
  assert.equal((await store.getSession(record.id))?.lastActiveAt.getTime(), now.getTime() + 1000);
  assert.deepEqual(
    (await Promise.all([store.deleteSession(record.id), store.deleteSession(record.id)])).sort(),
    [false, true],
  );
  await store.touchSession(record.id, new Date());
  assert.equal(await store.getSession(record.id), undefined);
  await store.createSession({ ...record, id: 'digest-2' });
  await store.createSession({ ...record, id: 'digest-3' });
  await store.deleteUserSessions(id);
  assert.deepEqual(await store.listUserSessions(id), []);
  await new AccountsRepository(t.db).changePassword(id, 1, 'updated-test-only-hash', ctx);
  await assert.rejects(store.createSession(record), /CREDENTIALS_CHANGED/);
  const gate = app.get(PasswordService),
    release: (() => void)[] = [];
  let entered = 0;
  const action = () =>
    gate.run(() => {
      entered++;
      return new Promise<void>((resolve) => release.push(resolve));
    });
  const first = action(),
    second = action(),
    queued = action();
  await assert.rejects(action(), /RATE_LIMITED/);
  assert.equal(entered, 2);
  release.shift()!();
  await first;
  await Promise.resolve();
  assert.equal(entered, 3);
  for (const finish of release) finish();
  await Promise.all([second, queued]);
  await t.db.pool.query('CREATE ROLE ' + role + ' NOLOGIN');
  roleCreated = true;
  await grantRuntimeAccess(t.db.pool, role, t.config.database.database);
  const c = await t.db.pool.connect();
  try {
    await c.query('SET ROLE ' + role);
    assert.equal((await c.query('SELECT count(*) FROM users')).rows[0].count, '1');
    await c.query('UPDATE users SET display_name=$1 WHERE id=$2', ['Updated', id]);
    for (const table of ['question_imports', 'question_import_rows', 'question_attachments']) {
      assert.equal((await c.query('SELECT count(*) FROM ' + table)).rows[0].count, '0');
      await c.query('DELETE FROM ' + table + ' WHERE false');
    }
    assert.equal(
      (await c.query('SELECT count(*) FROM question_version_attachments')).rows[0].count,
      '0',
    );
    await assert.rejects(
      c.query('DELETE FROM question_version_attachments WHERE false'),
      (e: unknown) => (e as { code: string }).code === '42501',
    );
    await assert.rejects(
      c.query('CREATE TABLE forbidden_table(id integer)'),
      (e: unknown) => (e as { code: string }).code === '42501',
    );
    await assert.rejects(
      c.query("UPDATE schema_migrations SET checksum='tamper'"),
      (e: unknown) => (e as { code: string }).code === '42501',
    );
  } finally {
    await c.query('RESET ROLE');
    c.release();
  }
  console.log(
    'PASS session-store concurrent delete/monotonic touch/no resurrection, stale credential rejection, bounded hashing and runtime DML without DDL',
  );
} finally {
  await app?.close();
  if (roleCreated) {
    await t.db.pool.query('DROP OWNED BY ' + role);
    await t.db.pool.query('DROP ROLE ' + role);
  }
  await t.close();
}
