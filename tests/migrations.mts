import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { migrate, MIGRATION, MIGRATIONS, readiness } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
const t = await isolatedDatabase();
try {
  const { db } = t;
  const original = execFileSync('git', ['show', 'bf11584:packages/db/src/index.ts'], {
    encoding: 'utf8',
  });
  const old = original.split('export const MIGRATION = `')[1]!.split('`;')[0]!;
  assert.equal(MIGRATION, old, 'V1 SQL bytes preserved');
  const prior = execFileSync('git', ['show', '5cb204c:packages/db/src/migrations.ts'], {
    encoding: 'utf8',
  });
  for (const [index, name] of [
    [1, 'identity'],
    [2, 'teaching'],
  ] as const) {
    const sql = prior.split('const ' + name + ' = `')[1]!.split('`;')[0]!;
    assert.equal(MIGRATIONS[index]!.sql, sql, `V${index + 1} SQL bytes preserved`);
  }
  await db.pool.query(
    'CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  await db.pool.query(MIGRATION);
  await db.pool.query('INSERT INTO schema_migrations(version,checksum) VALUES(1,$1)', [
    createHash('sha256').update(old).digest('hex'),
  ]);
  const id = randomUUID();
  await db.pool.query(
    "INSERT INTO jobs(id,business_key,kind,payload) VALUES($1,'preserved','diagnostic.echo','{}')",
    [id],
  );
  await Promise.all([migrate(db), migrate(db)]);
  await migrate(db);
  assert.ok(await readiness(db));
  assert.equal((await db.pool.query('SELECT id FROM jobs')).rows[0].id, id);
  await db.pool.query("UPDATE schema_migrations SET checksum='bad' WHERE version=2");
  assert.equal(await readiness(db), false);
  await assert.rejects(migrate(db), /CHECKSUM/);
  await db.pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=2', [
    MIGRATIONS[1]!.checksum,
  ]);
  const future = MIGRATIONS.length + 1;
  await db.pool.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,'future')", [
    future,
  ]);
  assert.equal(await readiness(db), false);
  await assert.rejects(migrate(db), /VERSION/);
  await db.pool.query('DELETE FROM schema_migrations WHERE version=2 OR version=$1', [future]);
  assert.equal(await readiness(db), false);
  await assert.rejects(migrate(db), /SEQUENCE/);
  console.log(
    'PASS V1 preservation, concurrent/idempotent upgrade, checksum/sequence/future rejection',
  );
} finally {
  await t.close();
}
const fresh = await isolatedDatabase();
try {
  await fresh.db.pool.query('CREATE TABLE auth_sessions(sentinel integer)');
  await assert.rejects(migrate(fresh.db));
  assert.deepEqual((await fresh.db.pool.query('SELECT version FROM schema_migrations')).rows, [
    { version: 1 },
  ]);
  assert.equal((await fresh.db.pool.query("SELECT to_regclass('users') AS t")).rows[0].t, null);
  await fresh.db.pool.query('DROP TABLE auth_sessions');
  await migrate(fresh.db);
  assert.ok(await readiness(fresh.db));
  assert.equal((await fresh.db.pool.query('SELECT count(*) FROM users')).rows[0].count, '0');
  console.log('PASS per-version rollback, resumable fresh migration, no seeded accounts');
} finally {
  await fresh.close();
}
