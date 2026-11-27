import { Pool, type PoolClient } from 'pg';
import { enterRuntime } from './maintenance-gate';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fingerprint } from './fingerprint';
export { fingerprint } from './fingerprint';
import { verifyLicense, LicenseError } from '@metaexam/domain';
import type { LicenseSummary, LicenseDetails, LicensePayload } from '@metaexam/contracts';
import { instanceInfo } from './schema';
import { loadConfig, type RuntimeConfig } from './config';
export { loadConfig, type RuntimeConfig };
export { loadMaintenanceConfig } from './config';
export const APP_VERSION = '0.1.3';
import { MIGRATIONS, validateMigrations, migrationRows } from './migrations';
export { MIGRATION, MIGRATIONS, SCHEMA_VERSION, grantRuntimeAccess } from './migrations';
export * from './management';
export * from './questions';
export * from './imports';
export * from './files';
export * from './attachments';
export * from './papers';
export * from './exams';
export * from './attempts';
export * from './grading';
export * from './reports';
export { BackupService, ordinaryPath } from './backup';
export { UpgradeDatabase } from './upgrade';
export { upgradePending } from './maintenance-gate';
import { processImportJob } from './imports';
export function createDatabase(config = loadConfig()) {
  const options = {
    ...config.database,
    max: 10,
    connectionTimeoutMillis: 2500,
    idleTimeoutMillis: 0,
    onConnect: (client: import('pg').Client) => enterRuntime(client, config.home),
  };
  const pool = new Pool(options);
  pool.on('error', () => console.error(JSON.stringify({ event: 'database_pool_error' })));
  return { pool, orm: drizzle(pool), config };
}
export type Database = ReturnType<typeof createDatabase>;
export async function transaction<T>(
  db: Database,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const value = await action(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate(db: Database): Promise<void> {
  const c = await db.pool.connect();
  try {
    await migrateConnection(c);
  } finally {
    c.release();
  }
}
/** Caller owns the connection and, for offline upgrades, the maintenance lock. */
export async function migrateConnection(c: PoolClient): Promise<void> {
  let locked = false;
  try {
    await c.query('SELECT pg_advisory_lock(184426)');
    locked = true;
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const rows = await migrationRows(c);
    validateMigrations(rows, false);
    for (const migration of MIGRATIONS.slice(rows.length)) {
      await c.query('BEGIN');
      try {
        await c.query(migration.sql);
        await c.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
          migration.version,
          migration.checksum,
        ]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (locked) await c.query('SELECT pg_advisory_unlock(184426)');
  }
}
export async function readiness(db: Database): Promise<boolean> {
  try {
    validateMigrations(await migrationRows(db.pool), true);
    return true;
  } catch {
    return false;
  }
}
export async function ensureInstance(db: Database) {
  const rows = await db.orm.select().from(instanceInfo);
  if (rows[0]) return rows[0];
  const id = randomUUID(),
    fp = await fingerprint(id);
  await db.pool.query('INSERT INTO instance_info VALUES(1,$1,$2,$3) ON CONFLICT(id) DO NOTHING', [
    id,
    fp.hash,
    fp.mode,
  ]);
  return (await db.orm.select().from(instanceInfo))[0]!;
}
export async function licenseRequest(db: Database) {
  const inst = await ensureInstance(db),
    actual = await fingerprint(inst.installationId);
  return {
    schemaVersion: 1,
    product: 'MetaExam',
    requestId: randomUUID(),
    installationId: inst.installationId,
    fingerprintVersion: 1,
    deviceHash: actual.hash,
    fingerprintMode: actual.mode,
    appVersion: APP_VERSION,
  };
}
function publicKeys(config: RuntimeConfig) {
  const entries: unknown = JSON.parse(readFileSync(config.trustFile, 'utf8'));
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    throw new Error('INVALID_TRUST_STORE');
  return new Map(
    Object.entries(entries).map(([id, pem]) => {
      if (typeof pem !== 'string') throw new Error('INVALID_PUBLIC_KEY');
      return [id, pem];
    }),
  );
}
interface State {
  highest_sequence: string;
  digest: string | null;
  raw: string | null;
  last_trusted_at: Date;
}
function watermark(config: RuntimeConfig): { sequence: number; time: string } {
  const file = path.join(config.home, 'license-watermark.json');
  if (!existsSync(file)) return { sequence: 0, time: '1970-01-01T00:00:00Z' };
  const v = JSON.parse(readFileSync(file, 'utf8')) as { sequence: number; time: string };
  if (!Number.isSafeInteger(v.sequence) || !Number.isFinite(Date.parse(v.time)))
    throw new LicenseError('CLOCK_ANOMALY');
  return v;
}
function saveWatermark(config: RuntimeConfig, sequence: number) {
  const previous = watermark(config);
  const v = {
    sequence: Math.max(sequence, previous.sequence),
    time: new Date(Math.max(Date.now(), Date.parse(previous.time))).toISOString(),
  };
  mkdirSync(config.home, { recursive: true });
  const file = path.join(config.home, 'license-watermark.json'),
    tmp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  renameSync(tmp, file);
}
export interface LicenseDevice {
  installationId: string;
  deviceHash: string;
}
// Call before opening a business transaction: no pool connection or lock is
// held while Windows reads hardware. This is identity evidence, not a license grant.
export async function prepareLicenseDevice(db: Database): Promise<LicenseDevice> {
  const inst = await ensureInstance(db);
  return {
    installationId: inst.installationId,
    deviceHash: (await fingerprint(inst.installationId)).hash,
  };
}
function context(db: Database, state: State, device: LicenseDevice) {
  const wm = watermark(db.config);
  return {
    ...device,
    appVersion: APP_VERSION,
    highestSequence: Math.max(Number(state.highest_sequence), wm.sequence),
    currentDigest: state.digest,
    lastTrustedAt: new Date(Math.max(state.last_trusted_at.getTime(), Date.parse(wm.time))),
  };
}
async function checkedContext(db: Database, c: PoolClient, state: State, device?: LicenseDevice) {
  const inst = (
    await c.query<{ installation_id: string }>(
      'SELECT installation_id FROM instance_info WHERE id=1',
    )
  ).rows[0];
  if (!device || !inst || inst.installation_id !== device.installationId)
    throw new LicenseError('WRONG_INSTANCE');
  return context(db, state, device);
}
async function persistWatermark(db: Database) {
  // Serialize cross-process read/replace against imports and other readers.
  await transaction(db, async (c) => {
    const state = (await c.query<State>('SELECT * FROM license_state WHERE id=1 FOR UPDATE'))
      .rows[0]!;
    saveWatermark(db.config, Number(state.highest_sequence));
  });
}
export async function checkLicenseFile(db: Database, raw: string) {
  const device = await prepareLicenseDevice(db);
  const s = (await db.pool.query<State>('SELECT * FROM license_state WHERE id=1')).rows[0]!;
  return verifyLicense(raw, publicKeys(db.config), context(db, s, device));
}
export function licenseDetails(payload: LicensePayload): LicenseDetails {
  const { licenseId, sequence, notBefore, expiresAt, maxConcurrentAttempts, features } = payload;
  return { licenseId, sequence, notBefore, expiresAt, maxConcurrentAttempts, features };
}
export async function previewLicenseImport(db: Database, raw: string) {
  const device = await prepareLicenseDevice(db);
  return transaction(db, async (c) => {
    const s = (await c.query<State>('SELECT * FROM license_state WHERE id=1 FOR UPDATE')).rows[0]!;
    const ctx = await checkedContext(db, c, s, device);
    const keys = publicKeys(db.config);
    const candidate = licenseDetails(verifyLicense(raw, keys, ctx).payload);
    let current: LicenseSummary = {
      state: 'unactivated',
      expiresAt: null,
      maxConcurrentAttempts: null,
      features: [],
    };
    if (s.raw) {
      try {
        const payload = verifyLicense(s.raw, keys, ctx).payload;
        current = {
          state: 'valid',
          expiresAt: payload.expiresAt,
          maxConcurrentAttempts: payload.maxConcurrentAttempts,
          features: payload.features,
        };
      } catch (error) {
        current.state =
          error instanceof LicenseError && error.code === 'EXPIRED' ? 'expired' : 'invalid';
      }
    }
    return { candidate, current, expectedDigest: s.digest };
  });
}
export async function importLicense(
  db: Database,
  raw: string,
  preview?: { expectedDigest: string | null },
) {
  // Collect machine information before taking the short-lived state lock.
  const device = await prepareLicenseDevice(db);
  const imported = await transaction(db, async (c) => {
    const s = (await c.query<State>('SELECT * FROM license_state WHERE id=1 FOR UPDATE')).rows[0]!;
    if (preview && s.digest !== preview.expectedDigest) throw new Error('LICENSE_CHANGED');
    const verified = verifyLicense(
      raw,
      publicKeys(db.config),
      await checkedContext(db, c, s, device),
    );
    if (s.digest === verified.digest) return verified;
    await c.query('INSERT INTO license_history(id,sequence,digest,raw) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      verified.payload.sequence,
      verified.digest,
      raw,
    ]);
    await c.query(
      'UPDATE license_state SET highest_sequence=$1,digest=$2,raw=$3,last_trusted_at=GREATEST(last_trusted_at,now()) WHERE id=1',
      [verified.payload.sequence, verified.digest, raw],
    );
    return verified;
  });
  await persistWatermark(db);
  return imported;
}
// Publication keeps this lock until the surrounding exam transaction commits.
// Do not replace with licenseStatus: status catches failures and uses another connection.
export async function verifyPublicationLicense(
  db: Database,
  c: PoolClient,
  device: LicenseDevice | undefined,
) {
  const s = (await c.query<State>('SELECT * FROM license_state WHERE id=1 FOR UPDATE')).rows[0];
  if (!s?.raw) throw new LicenseError('BAD_FORMAT');
  const verified = verifyLicense(
    s.raw,
    publicKeys(db.config),
    await checkedContext(db, c, s, device),
  );
  await c.query(
    'UPDATE license_state SET last_trusted_at=GREATEST(last_trusted_at,now()) WHERE id=1',
  );
  saveWatermark(db.config, verified.payload.sequence);
  return verified.payload;
}
export async function licenseStatus(db: Database): Promise<LicenseSummary> {
  const empty: LicenseSummary = {
    state: 'unactivated',
    expiresAt: null,
    maxConcurrentAttempts: null,
    features: [],
  };
  try {
    const s = (await db.pool.query<State>('SELECT * FROM license_state WHERE id=1')).rows[0];
    if (!s?.raw) return empty;
    const device = await prepareLicenseDevice(db);
    const v = verifyLicense(s.raw, publicKeys(db.config), context(db, s, device));
    await db.pool.query(
      'UPDATE license_state SET last_trusted_at=GREATEST(last_trusted_at,now()) WHERE id=1',
    );
    await persistWatermark(db);
    return {
      state: 'valid',
      expiresAt: v.payload.expiresAt,
      maxConcurrentAttempts: v.payload.maxConcurrentAttempts,
      features: v.payload.features,
    };
  } catch (error) {
    const code = error instanceof LicenseError ? error.code : 'VERIFICATION_FAILED';
    return {
      ...empty,
      state:
        code === 'EXPIRED'
          ? 'expired'
          : code === 'NOT_YET_VALID'
            ? 'not_yet_valid'
            : code === 'CLOCK_ANOMALY'
              ? 'clock_anomaly'
              : 'invalid',
      errorCode: code,
    };
  }
}
export async function enqueue(db: Database, businessKey: string, message: string) {
  const result = await db.pool.query<{ id: string }>(
    "INSERT INTO jobs(id,business_key,kind,payload) VALUES($1,$2,'diagnostic.echo',$3) ON CONFLICT(business_key) DO UPDATE SET business_key=EXCLUDED.business_key RETURNING id",
    [randomUUID(), businessKey, JSON.stringify({ message })],
  );
  return result.rows[0]!;
}
export async function processOne(db: Database): Promise<boolean> {
  await db.pool.query(
    'INSERT INTO worker_heartbeat VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET seen_at=now()',
  );
  await db.pool.query(
    "UPDATE jobs SET status='failed',error_code='RETRIES_EXHAUSTED' WHERE status='running' AND lease_until<now() AND attempts>=3",
  );
  await db.pool.query(
    "UPDATE question_imports i SET status='failed',error_code='RETRIES_EXHAUSTED' WHERE status IN ('pending','processing','queued') AND EXISTS(SELECT 1 FROM jobs j WHERE j.payload->>'importId'=i.id::text AND j.status='failed')",
  );
  const claimed = await db.pool.query<{
    id: string;
    payload: { message?: string; importId?: string };
    lease_token: string;
    kind: string;
  }>(
    "WITH next AS (SELECT id FROM jobs WHERE (status='pending' OR (status='running' AND lease_until<now())) AND attempts<3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs j SET status='running',attempts=attempts+1,lease_token=$1,lease_until=now()+(CASE WHEN kind='diagnostic.echo' THEN $2 ELSE GREATEST($2,60) END)*interval '1 second' FROM next WHERE j.id=next.id RETURNING j.id,j.payload,j.lease_token,j.kind",
    [randomUUID(), db.config.leaseSeconds],
  );
  const job = claimed.rows[0];
  if (!job) return false;
  if (job.kind !== 'diagnostic.echo') {
    try {
      await processImportJob(db, job);
      await db.pool.query(
        "UPDATE jobs SET status='completed',completed_at=now(),lease_until=NULL,result=$1 WHERE id=$2 AND lease_token=$3 AND status='running'",
        [JSON.stringify({ importProcessed: true }), job.id, job.lease_token],
      );
    } catch (error) {
      await db.pool.query(
        "UPDATE jobs SET lease_until=now() WHERE id=$1 AND lease_token=$2 AND status='running'",
        [job.id, job.lease_token],
      );
      throw error;
    }
    return true;
  }
  await db.pool.query(
    "UPDATE jobs SET status='completed',result=$1,completed_at=now(),lease_until=NULL WHERE id=$2 AND lease_token=$3 AND status='running'",
    [JSON.stringify({ echo: job.payload.message }), job.id, job.lease_token],
  );
  return true;
}

export * from './identity';
export { issueBootstrapFile, requireAdministrator } from './bootstrap';
