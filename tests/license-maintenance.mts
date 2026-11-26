import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import {
  createDatabase,
  grantRuntimeAccess,
  importLicense,
  previewLicenseImport,
  licenseStatus,
  licenseDetails,
} from '../packages/db/dist/index.js';
import {
  runLicenseMaintenance,
  parseLicenseMaintenanceInput,
} from '../apps/worker/dist/license-maintenance.js';
import { LicenseOperations } from '../apps/desktop/dist/license-operations.js';
import { licenseManagerFixture } from './license-manager-fixture.mts';
const t = await licenseManagerFixture();
const role = 'metaexam_license_' + randomBytes(10).toString('hex');
let runtime: ReturnType<typeof createDatabase> | undefined;
let roleCreated = false;
const raw1 = t.issue(1),
  file = path.join(t.config.home, 'selected.mlic');
let fileChoice: string | null = file,
  saveChoice: string | null = path.join(t.config.home, 'request.mreq');
let allowed = true,
  clock = Date.now();
try {
  // Use real restricted runtime DML permissions, never grant maintenance DDL.
  const password = randomBytes(20).toString('hex');
  await t.db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  roleCreated = true;
  await grantRuntimeAccess(t.db.pool, role, t.config.database.database);
  runtime = createDatabase({
    ...t.config,
    database: { ...t.config.database, user: role, password },
  });
  const db = runtime;
  await assert.rejects(db.pool.query('CREATE TABLE forbidden_license_test(id integer)'));
  const deps = {
    authorize: async () => {
      if (!allowed) throw new Error('ADMINISTRATOR_REQUIRED');
    },
    chooseOpen: async () => fileChoice,
    chooseSave: async () => saveChoice,
    request: async () => runLicenseMaintenance(db, { operation: 'request' }),
    preview: (raw: string) => previewLicenseImport(db, raw),
    import: async (raw: string, expectedDigest: string | null) =>
      licenseDetails((await importLicense(db, raw, { expectedDigest })).payload),
    now: () => clock,
  };
  const manager = new LicenseOperations(deps);
  const state = async () =>
    (await db.pool.query('SELECT digest,highest_sequence FROM license_state WHERE id=1')).rows[0];
  const preview = async () => {
    const value = await manager.preview();
    assert.equal(value.status, 'success', JSON.stringify(value));
    if (value.status !== 'success') throw new Error('PREVIEW_FAILED');
    return value.value;
  };
  allowed = false;
  assert.deepEqual(await manager.exportRequest(), {
    status: 'error',
    code: 'ADMINISTRATOR_REQUIRED',
  });
  assert.deepEqual(await manager.preview(), { status: 'error', code: 'ADMINISTRATOR_REQUIRED' });
  assert.equal(existsSync(saveChoice!), false);
  allowed = true;
  saveChoice = null;
  assert.deepEqual(await manager.exportRequest(), { status: 'cancelled' });
  saveChoice = path.join(t.config.home, 'request.mreq');
  assert.equal((await manager.exportRequest()).status, 'success');
  assert.equal(
    JSON.parse(readFileSync(saveChoice, 'utf8')).installationId,
    t.request.installationId,
  );
  const saved = readFileSync(saveChoice, 'utf8');
  assert.deepEqual(await manager.exportRequest(), { status: 'error', code: 'FILE_EXISTS' });
  assert.equal(readFileSync(saveChoice, 'utf8'), saved);
  fileChoice = null;
  assert.deepEqual(await manager.preview(), { status: 'cancelled' });
  fileChoice = file;
  writeFileSync(file, raw1);
  const first = await preview();
  assert.equal(first.current.state, 'unactivated');
  assert.equal(first.candidate.maxConcurrentAttempts, 100);
  assert.equal(
    'raw' in first || 'expectedDigest' in first || 'deviceHash' in first.candidate,
    false,
  );
  assert.equal((await state()).digest, null, 'preview does not import');
  manager.cancel(first.id);
  assert.deepEqual(await manager.confirm(first.id), { status: 'error', code: 'PREVIEW_EXPIRED' });
  const frozen = await preview();
  writeFileSync(file, t.issue(2, { maxConcurrentAttempts: 500 }));
  assert.equal((await manager.confirm(frozen.id)).status, 'success');
  assert.equal(
    (await licenseStatus(db)).maxConcurrentAttempts,
    100,
    'imports the exact previewed bytes',
  );
  assert.deepEqual(await manager.confirm(frozen.id), { status: 'error', code: 'PREVIEW_EXPIRED' });
  const old = await state();
  for (const [raw, code] of [
    ['not json', 'BAD_FORMAT'],
    [
      JSON.stringify({ ...JSON.parse(raw1), signature: Buffer.alloc(64).toString('base64url') }),
      'BAD_SIGNATURE',
    ],
    [t.issue(2, {}, 'unknown'), 'UNKNOWN_KEY'],
    [t.issue(2, { deviceHash: 'a'.repeat(64) }), 'WRONG_DEVICE'],
    [t.issue(2, { installationId: randomUUID() }), 'WRONG_INSTANCE'],
    [t.issue(2, { product: 'Other' }), 'WRONG_PRODUCT'],
    [t.issue(2, { minAppVersion: '99.0.0' }), 'VERSION_MISMATCH'],
    [t.issue(2, { expiresAt: new Date(Date.now() - 1000).toISOString() }), 'EXPIRED'],
    [t.issue(2, { notBefore: new Date(Date.now() + 60000).toISOString() }), 'NOT_YET_VALID'],
    ['x'.repeat(65537), 'FILE_TOO_LARGE'],
  ]) {
    writeFileSync(file, raw!);
    const result = await manager.preview();
    assert.deepEqual(result, { status: 'error', code });
    assert.deepEqual(await state(), old);
  }
  writeFileSync(file, t.issue(2));
  const expired = await preview();
  clock += 600001;
  assert.deepEqual(await manager.confirm(expired.id), { status: 'error', code: 'PREVIEW_EXPIRED' });
  assert.deepEqual(await state(), old);
  clock = Date.now();
  const revoked = await preview();
  allowed = false;
  assert.deepEqual(await manager.confirm(revoked.id), {
    status: 'error',
    code: 'ADMINISTRATOR_REQUIRED',
  });
  allowed = true;
  manager.cancel(revoked.id);
  const concurrent = await preview();
  await importLicense(db, t.issue(3, { maxConcurrentAttempts: 200 }));
  assert.deepEqual(await manager.confirm(concurrent.id), {
    status: 'error',
    code: 'LICENSE_CHANGED',
  });
  assert.equal((await licenseStatus(db)).maxConcurrentAttempts, 200);
  assert.deepEqual(await manager.preview(), { status: 'error', code: 'STALE_SEQUENCE' });
  const raw4 = t.issue(4);
  writeFileSync(file, raw4);
  const recheck = await preview();
  const trust = readFileSync(t.config.trustFile, 'utf8');
  writeFileSync(t.config.trustFile, '{}');
  assert.deepEqual(
    await manager.confirm(recheck.id),
    { status: 'error', code: 'UNKNOWN_KEY' },
    'confirmation re-verifies public trust',
  );
  writeFileSync(t.config.trustFile, trust);
  const pending = await preview();
  const duplicateCalls = await Promise.all([
    manager.confirm(pending.id),
    manager.confirm(pending.id),
  ]);
  assert.equal(duplicateCalls.filter((r) => r.status === 'success').length, 1);
  assert.equal(
    duplicateCalls.filter((r) => r.status === 'error' && r.code === 'OPERATION_BUSY').length,
    1,
  );
  assert.equal((await manager.confirm((await preview()).id)).status, 'success');
  assert.equal(
    (await db.pool.query('SELECT count(*) FROM license_history WHERE sequence=4')).rows[0].count,
    '1',
  );
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const navigating = new LicenseOperations({
    ...deps,
    preview: async (raw) => {
      const result = await deps.preview(raw);
      entered();
      await gate;
      return result;
    },
  });
  const late = navigating.preview();
  await started;
  navigating.clear();
  release();
  assert.deepEqual(
    await late,
    { status: 'error', code: 'PREVIEW_EXPIRED' },
    'navigation discards in-flight previews',
  );
  const deadline = Date.now() + 5000;
  writeFileSync(file, t.issue(5, { expiresAt: new Date(deadline).toISOString() }));
  const expiring = await preview();
  const beforeExpiry = await state();
  await delay(Math.max(1, deadline - Date.now() + 20));
  assert.deepEqual(await manager.confirm(expiring.id), { status: 'error', code: 'EXPIRED' });
  assert.deepEqual(
    await state(),
    beforeExpiry,
    'expiry after preview does not replace current license',
  );
  const brokenDb = createDatabase({ ...t.config, database: { ...t.config.database, port: 1 } });
  try {
    await assert.rejects(
      runLicenseMaintenance(brokenDb, {
        operation: 'import',
        raw: raw4,
        expectedDigest: beforeExpiry.digest,
      }),
      /IMPORT_RESULT_UNKNOWN/,
    );
  } finally {
    await brokenDb.pool.end();
  }
  assert.throws(() =>
    parseLicenseMaintenanceInput({ operation: 'preview', raw: raw4, path: 'C:/private' }),
  );
  assert.throws(() =>
    parseLicenseMaintenanceInput({ operation: 'import', raw: raw4, expectedDigest: 'invalid' }),
  );
  const configFile = path.join(t.config.home, 'runtime.json');
  writeFileSync(configFile, JSON.stringify(db.config));
  const run = promisify(execFile);
  const restarted = await run(process.execPath, ['apps/worker/dist/cli.js', 'license-status'], {
    env: { ...process.env, METAEXAM_CONFIG: configFile },
    windowsHide: true,
  });
  assert.equal(JSON.parse(restarted.stdout).state, 'valid');
  // The production desktop CLI must deny ordinary privileges before opening config.
  await assert.rejects(
    run(process.execPath, ['apps/worker/dist/cli.js', 'license-desktop'], {
      env: { ...process.env, METAEXAM_CONFIG: 'missing-sensitive-config' },
      windowsHide: true,
    }),
    (error: unknown) => (error as { stderr: string }).stderr.trim() === 'ADMINISTRATOR_REQUIRED',
  );
  console.log(
    'PASS isolated local-license workflow, restricted role, cancel/replay/race, revalidation, original preservation and CLI restart',
  );
} finally {
  await runtime?.pool.end();
  if (roleCreated) {
    await t.db.pool.query('DROP OWNED BY ' + role);
    await t.db.pool.query('DROP ROLE ' + role);
  }
  await t.close();
}
