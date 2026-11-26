import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  existsSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  BackupService,
  createDatabase,
  BootstrapRepository,
  digestToken,
  importLicense,
  licenseStatus,
  grantRuntimeAccess,
} from '../packages/db/dist/index.js';
import { licenseManagerFixture } from './license-manager-fixture.mts';
const { Pool } = createRequire(path.resolve('packages/db/package.json'))('pg');
const t = await licenseManagerFixture();
const output = mkdtempSync(path.join(tmpdir(), 'MetaExam-backup-test-'));
const key = randomBytes(32),
  bin = path.resolve('.tools/pgsql/bin');
const runtimeRole = 'backup_test_' + randomUUID().replaceAll('-', '');
const runtimePassword = randomBytes(32).toString('hex');
const options = { key, bin, runtimeRole, secureDirectory: async () => {} };
const service = new BackupService(t.config, options);
const owner = new Pool({ ...t.config.database, database: 'postgres' });
const db = () => createDatabase(t.config);
async function readName() {
  const current = db();
  try {
    return (
      await current.pool.query("SELECT display_name FROM users WHERE username='backup_admin'")
    ).rows[0]?.display_name;
  } finally {
    await current.pool.end();
  }
}
try {
  await owner.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'`);
  await grantRuntimeAccess(t.db.pool, runtimeRole, t.config.database.database);
  const bootstrap = new BootstrapRepository(t.db),
    token = randomBytes(32).toString('hex');
  await bootstrap.issue(digestToken(token), new Date(Date.now() + 60000), {
    requestId: 'backup-test',
  });
  await bootstrap.create(
    { username: 'backup_admin', displayName: '备份时姓名', password: 'unused' },
    token,
    'test-only',
    { requestId: 'backup-test' },
  );
  const user = (await t.db.pool.query("SELECT id FROM users WHERE username='backup_admin'")).rows[0]
    .id;
  const course = randomUUID(),
    bank = randomUUID(),
    image = randomUUID(),
    question = randomUUID(),
    version = randomUUID();
  await t.db.pool.query("INSERT INTO courses(id,code,name) VALUES($1,'backup','备份课程')", [
    course,
  ]);
  await t.db.pool.query(
    "INSERT INTO question_banks(id,name,course_id,owner_id,visibility) VALUES($1,'历史图片题库',$2,$3,'public')",
    [bank, course, user],
  );
  const sharp = createRequire(path.resolve('packages/db/package.json'))('sharp');
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#1677ff' } })
    .png()
    .toBuffer();
  mkdirSync(path.join(t.config.home, 'files/images'), { recursive: true });
  const imageFile = path.join(t.config.home, 'files/images', image + '.png');
  writeFileSync(imageFile, bytes);
  await t.db.pool.query(
    'INSERT INTO question_attachments(id,bank_id,actor_id,digest,width,height,bytes) VALUES($1,$2,$3,$4,1,1,$5)',
    [image, bank, user, createHash('sha256').update(bytes).digest('hex'), bytes.length],
  );
  const c = await t.db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('INSERT INTO questions(id,bank_id) VALUES($1,$2)', [question, bank]);
    await c.query(
      "INSERT INTO question_versions(id,question_id,version,content,author_id) VALUES($1,$2,1,'{}',$3)",
      [version, question, user],
    );
    await c.query('INSERT INTO question_version_attachments VALUES($1,$2)', [version, image]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  await t.db.pool.query(
    "INSERT INTO auth_sessions VALUES('hashed-test-session',$1,now(),now(),now()+interval '1 hour','{}')",
    [user],
  );
  await importLicense(t.db, t.issue(1));
  await assert.rejects(service.create(output), /SERVICES_RUNNING/);
  assert.ok(!existsSync(path.join(t.config.home, 'maintenance.json')));
  await t.db.pool.end();
  const info = await service.create(output);
  const folder = path.join(output, 'MetaExam-' + info.id + '.mbackup');
  assert.equal(info.fileCount, 1);
  assert.deepEqual(await service.preview(folder), info);
  const concurrent = await Promise.allSettled([service.create(output), service.create(output)]);
  assert.equal(concurrent.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(
    concurrent.filter(
      (value) => value.status === 'rejected' && value.reason.message === 'OPERATION_BUSY',
    ).length,
    1,
  );
  const controller = await owner.connect();
  try {
    await controller.query('SELECT pg_advisory_lock(184428,hashtext($1))', [
      t.config.database.database,
    ]);
    await assert.rejects(service.recover(), /OPERATION_BUSY/);
  } finally {
    controller.release(true);
  }
  const linked = path.join(output, 'linked-backup');
  symlinkSync(folder, linked, 'junction');
  await assert.rejects(service.preview(linked), /BACKUP_UNSAFE_PATH/);
  unlinkSync(linked);
  console.log('PASS offline database + historical attachment backup and authenticated preview');

  const imageInBackup = path.join(folder, 'files/images', image + '.png');
  writeFileSync(imageInBackup, 'changed');
  await assert.rejects(service.restore(folder, info.id), /BACKUP_CHANGED/);
  assert.equal(await readName(), '备份时姓名');
  writeFileSync(imageInBackup, bytes);
  await assert.rejects(
    new BackupService(t.config, { ...options, key: randomBytes(32) }).preview(folder),
    /BACKUP_UNTRUSTED/,
  );
  await assert.rejects(service.restore(folder, randomUUID()), /BACKUP_CHANGED/);
  console.log(
    'PASS corrupted content, wrong local key and replaced selection rejected without data changes',
  );
  const manifestFile = path.join(folder, 'manifest.json');
  const originalManifest = readFileSync(manifestFile, 'utf8');
  const changeManifest = (change: object) => {
    const payload = JSON.stringify({
      ...JSON.parse(JSON.parse(originalManifest).payload),
      ...change,
    });
    writeFileSync(
      manifestFile,
      JSON.stringify({ payload, mac: createHmac('sha256', key).update(payload).digest('hex') }),
    );
  };
  changeManifest({ schemaVersion: 999 });
  await assert.rejects(service.preview(folder), /BACKUP_INCOMPATIBLE/);
  changeManifest({ installationId: randomUUID() });
  await assert.rejects(service.preview(folder), /BACKUP_WRONG_INSTANCE/);
  changeManifest({ deviceHash: 'wrong-device' });
  await assert.rejects(service.preview(folder), /BACKUP_WRONG_DEVICE/);
  changeManifest({ databaseBytes: Math.floor(Number.MAX_SAFE_INTEGER / 4) });
  await assert.rejects(service.restore(folder, info.id), /BACKUP_SPACE_REQUIRED/);
  writeFileSync(manifestFile, originalManifest);
  console.log(
    'PASS incompatible version, different instance/device and insufficient space rejected',
  );

  const changed = db();
  try {
    await changed.pool.query("UPDATE users SET display_name='恢复前姓名' WHERE id=$1", [user]);
    await importLicense(changed, t.issue(2));
  } finally {
    await changed.pool.end();
  }
  const watermark = readFileSync(path.join(t.config.home, 'license-watermark.json'), 'utf8');
  const extra = path.join(t.config.home, 'files/images', randomUUID() + '.png');
  writeFileSync(extra, 'new data');
  for (const point of [
    'validated',
    'old-renamed',
    'database-swapped',
    'files-moved',
    'files-swapped',
  ]) {
    await assert.rejects(
      new BackupService(t.config, {
        ...options,
        checkpoint: (p) => {
          if (p === point) throw new Error('INJECTED_FAILURE');
        },
      }).restore(folder, info.id),
      /INJECTED_FAILURE/,
    );
    assert.equal(await readName(), '恢复前姓名');
    assert.equal(readFileSync(extra, 'utf8'), 'new data');
    assert.deepEqual(readFileSync(imageFile), bytes);
    assert.ok(!existsSync(path.join(t.config.home, 'maintenance.json')));
  }
  console.log('PASS each database/files switch failure restores original data and attachments');

  const crash = spawnSync(process.execPath, ['--import', 'tsx', 'tests/backup-crash.mts'], {
    encoding: 'utf8',
    windowsHide: true,
    input: JSON.stringify({ config: t.config, bin, key: key.toString('hex'), folder, id: info.id }),
    timeout: 60000,
  });
  assert.equal(crash.status, 77, crash.stderr);
  const blocked = db();
  try {
    await assert.rejects(blocked.pool.query('SELECT 1'), /MAINTENANCE_REQUIRED/);
  } finally {
    await blocked.pool.end();
  }
  assert.deepEqual(await service.recover(), { recovered: true });
  assert.equal(await readName(), '恢复前姓名');
  assert.equal(readFileSync(extra, 'utf8'), 'new data');
  console.log('PASS process crash blocks runtime reconnect and explicit recovery rolls back');

  assert.deepEqual(await service.restore(folder, info.id), { restored: true });
  assert.equal(await readName(), '备份时姓名');
  assert.equal(existsSync(extra), false);
  assert.deepEqual(readFileSync(imageFile), bytes);
  assert.equal(readFileSync(path.join(t.config.home, 'license-watermark.json'), 'utf8'), watermark);
  const restored = db();
  try {
    assert.equal(
      (await restored.pool.query('SELECT count(*)::int AS n FROM auth_sessions')).rows[0].n,
      0,
    );
    assert.equal(
      Number(
        (await restored.pool.query('SELECT highest_sequence FROM license_state')).rows[0]
          .highest_sequence,
      ),
      2,
    );
    assert.equal((await licenseStatus(restored)).state, 'valid');
    await assert.rejects(
      importLicense(restored, t.issue(1)),
      (error) => (error as { code?: string }).code === 'STALE_SEQUENCE',
    );
    assert.equal(
      (await restored.pool.query('SELECT count(*)::int AS n FROM question_version_attachments'))
        .rows[0].n,
      1,
    );
  } finally {
    await restored.pool.end();
  }
  assert.deepEqual(await service.recover(), { recovered: false });
  const restricted = createDatabase({
    ...t.config,
    database: { ...t.config.database, user: runtimeRole, password: runtimePassword },
  });
  try {
    assert.equal(
      (await restricted.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,
      1,
    );
    await assert.rejects(
      restricted.pool.query('CREATE TABLE forbidden_backup_test(id int)'),
      /permission denied/,
    );
    await assert.rejects(
      restricted.pool.query('DELETE FROM question_versions'),
      /permission denied/,
    );
  } finally {
    await restricted.pool.end();
  }
  console.log(
    'PASS restore retains current signed license/high-water mark, invalidates sessions and preserves historical references',
  );
  const cli = spawnSync(process.execPath, ['apps/worker/dist/cli.js', 'backup-desktop'], {
    encoding: 'utf8',
    windowsHide: true,
    input: '{"operation":"recover"}',
    env: { ...process.env, METAEXAM_CONFIG: 'missing-test-config' },
  });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr.trim(), 'ADMINISTRATOR_REQUIRED');
  console.log('PASS production maintenance CLI rejects unelevated access before configuration');
} finally {
  for (const name of readdirSync(t.config.home)) {
    const match = /^restore-([a-f0-9-]{36})$/.exec(name);
    if (!match) continue;
    const suffix = match[1]!.replaceAll('-', '');
    assert.match(suffix, /^[a-f0-9]{32}$/);
    for (const prefix of ['metaexam_old_', 'metaexam_restore_'])
      await owner.query('DROP DATABASE IF EXISTS ' + prefix + suffix + ' WITH (FORCE)');
  }
  await t.close();
  await owner.query('DROP ROLE IF EXISTS ' + runtimeRole);
  await owner.end();
  if (
    path.dirname(output) === path.resolve(tmpdir()) &&
    path.basename(output).startsWith('MetaExam-backup-test-')
  )
    rmSync(output, { recursive: true, force: true });
}
