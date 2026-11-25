import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  migrate,
  BootstrapRepository,
  AccountsRepository,
  digestToken,
  consumeAuthQuota,
} from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
const t = await isolatedDatabase();
try {
  await migrate(t.db);
  const setup = new BootstrapRepository(t.db),
    accounts = new AccountsRepository(t.db);
  const token = randomBytes(32).toString('hex'),
    ctx = { requestId: 'identity-test', ip: '127.0.0.1' };
  const input = {
    username: 'administrator',
    displayName: '测试管理员',
    password: 'not-persisted-password',
  };
  await setup.issue(digestToken(token), new Date(Date.now() - 1), ctx);
  await assert.rejects(setup.create(input, token, 'test-only-hash', ctx), /TOKEN_INVALID/);
  await setup.issue(digestToken(token), new Date(Date.now() + 60000), ctx);
  await assert.rejects(setup.create(input, 'wrong', 'test-only-hash', ctx), /TOKEN_INVALID/);
  await assert.rejects(
    setup.create({ ...input, username: 'InvalidCase' }, token, 'test-only-hash', ctx),
  );
  assert.equal(
    (await t.db.pool.query('SELECT token_hash FROM bootstrap_state')).rows[0].token_hash,
    digestToken(token),
  );
  const attempts = await Promise.allSettled([
    setup.create(input, token, 'test-only-hash', ctx),
    setup.create(input, token, 'test-only-hash', ctx),
  ]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await setup.initialized(), true);
  await assert.rejects(setup.issue(digestToken(token), new Date(), ctx), /ALREADY_INITIALIZED/);
  const credentials = (await accounts.credentials('administrator'))!;
  assert.deepEqual((await accounts.current(credentials.id))?.roles, ['admin']);
  assert.ok((await accounts.current(credentials.id))?.permissions.includes('admin.overview'));
  await accounts.changePassword(credentials.id, 1, 'new-test-only-hash', ctx);
  await assert.rejects(
    accounts.changePassword(credentials.id, 1, 'stale', ctx),
    /CREDENTIALS_CHANGED/,
  );
  await consumeAuthQuota(t.db, 'administrator', '127.0.0.1', { account: 1, ip: 60 });
  await assert.rejects(
    consumeAuthQuota(t.db, 'administrator', '127.0.0.1', { account: 1, ip: 60 }),
    /RATE_LIMITED/,
  );
  assert.equal((await t.db.pool.query('SELECT count(*) FROM users')).rows[0].count, '1');
  const audits = JSON.stringify((await t.db.pool.query('SELECT * FROM audit_events')).rows);
  assert.ok(!audits.includes(token) && !audits.includes('test-only-hash'));
  console.log(
    'PASS setup expiry/replay/concurrency, account permissions, versioned password, persistent quota, redacted audit',
  );
} finally {
  await t.close();
}
