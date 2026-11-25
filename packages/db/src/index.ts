import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyLicense, LicenseError } from '@metaexam/domain';
import type { LicenseSummary } from '@metaexam/contracts';
import { instanceInfo } from './schema';
import { loadConfig, type RuntimeConfig } from './config';
export { loadConfig, type RuntimeConfig };
export const APP_VERSION = '0.1.0';
export const MIGRATION = `
CREATE TABLE instance_info(id integer PRIMARY KEY CHECK(id=1), installation_id uuid NOT NULL UNIQUE, device_hash text NOT NULL, fingerprint_mode text NOT NULL);
CREATE TABLE license_state(id integer PRIMARY KEY CHECK(id=1), highest_sequence bigint NOT NULL DEFAULT 0, digest text, raw text, last_trusted_at timestamptz NOT NULL DEFAULT now());
INSERT INTO license_state(id) VALUES (1);
CREATE TABLE license_history(id uuid PRIMARY KEY, sequence bigint NOT NULL UNIQUE, digest text NOT NULL, raw text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE jobs(id uuid PRIMARY KEY, business_key text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind='diagnostic.echo'), payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')), attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz, result jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
CREATE INDEX jobs_claim_idx ON jobs(status,lease_until,created_at);
CREATE TABLE worker_heartbeat(id integer PRIMARY KEY CHECK(id=1), seen_at timestamptz NOT NULL);
`;
export function createDatabase(config = loadConfig()) {
  const pool = new Pool({
    ...config.database,
    max: 10,
    connectionTimeoutMillis: 2500,
    idleTimeoutMillis: 10000,
  });
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
  await transaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(184426)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const checksum = createHash('sha256').update(MIGRATION).digest('hex');
    const existing = await c.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE version=1',
    );
    if (existing.rows.length) {
      if (existing.rows[0]!.checksum !== checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      return;
    }
    await c.query(MIGRATION);
    await c.query('INSERT INTO schema_migrations(version,checksum) VALUES(1,$1)', [checksum]);
  });
}
export async function readiness(db: Database): Promise<boolean> {
  try {
    const result = await db.pool.query<{ version: number; checksum: string }>(
      'SELECT version,checksum FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    return (
      result.rows[0]?.version === 1 &&
      result.rows[0]?.checksum === createHash('sha256').update(MIGRATION).digest('hex')
    );
  } catch {
    return false;
  }
}
export function fingerprint(installationId: string): { hash: string; mode: string } {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED_FOR_DEVICE_BINDING');
  const script =
    "$ErrorActionPreference='Stop'; $a=''; $b=''; try {$a=(Get-CimInstance Win32_ComputerSystemProduct).UUID} catch {}; try {$b=(Get-CimInstance Win32_BaseBoard).SerialNumber} catch {}; @{uuid=$a;board=$b;guid=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid}|ConvertTo-Json -Compress";
  const v = JSON.parse(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    }),
  ) as Record<string, string>;
  const clean = (s?: string) => (s ?? '').trim().toUpperCase();
  const valid = (s: string) =>
    s.length > 3 && !/DEFAULT|UNKNOWN|TO BE FILLED|NOT SPECIFIED|^0+(-0+)*$|^F+(-F+)*$/.test(s);
  const a = clean(v.uuid),
    b = clean(v.board),
    g = clean(v.guid);
  const mode = valid(a) && valid(b) ? 'smbios' : 'machine-guid';
  if (mode === 'machine-guid' && !valid(g)) throw new Error('NO_STABLE_DEVICE_ID');
  return {
    mode,
    hash: createHash('sha256')
      .update(JSON.stringify([1, installationId, mode, mode === 'smbios' ? [a, b] : [g]]))
      .digest('hex'),
  };
}
export async function ensureInstance(db: Database) {
  const rows = await db.orm.select().from(instanceInfo);
  if (rows[0]) return rows[0];
  const id = randomUUID(),
    fp = fingerprint(id);
  await db.pool.query('INSERT INTO instance_info VALUES(1,$1,$2,$3) ON CONFLICT(id) DO NOTHING', [
    id,
    fp.hash,
    fp.mode,
  ]);
  return (await db.orm.select().from(instanceInfo))[0]!;
}
export async function licenseRequest(db: Database) {
  const inst = await ensureInstance(db),
    actual = fingerprint(inst.installationId);
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
async function context(db: Database, state: State) {
  const inst = await ensureInstance(db),
    fp = fingerprint(inst.installationId),
    wm = watermark(db.config);
  return {
    installationId: inst.installationId,
    deviceHash: fp.hash,
    appVersion: APP_VERSION,
    highestSequence: Math.max(Number(state.highest_sequence), wm.sequence),
    currentDigest: state.digest,
    lastTrustedAt: new Date(Math.max(state.last_trusted_at.getTime(), Date.parse(wm.time))),
  };
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
  const s = (await db.pool.query<State>('SELECT * FROM license_state WHERE id=1')).rows[0]!;
  return verifyLicense(raw, publicKeys(db.config), await context(db, s));
}
export async function importLicense(db: Database, raw: string) {
  // Collect machine information before taking the short-lived state lock.
  await ensureInstance(db);
  const imported = await transaction(db, async (c) => {
    const s = (await c.query<State>('SELECT * FROM license_state WHERE id=1 FOR UPDATE')).rows[0]!;
    const verified = verifyLicense(raw, publicKeys(db.config), await context(db, s));
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
    const v = verifyLicense(s.raw, publicKeys(db.config), await context(db, s));
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
  const claimed = await db.pool.query<{
    id: string;
    payload: { message: string };
    lease_token: string;
  }>(
    "WITH next AS (SELECT id FROM jobs WHERE (status='pending' OR (status='running' AND lease_until<now())) AND attempts<3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs j SET status='running',attempts=attempts+1,lease_token=$1,lease_until=now()+$2*interval '1 second' FROM next WHERE j.id=next.id RETURNING j.id,j.payload,j.lease_token",
    [randomUUID(), db.config.leaseSeconds],
  );
  const job = claimed.rows[0];
  if (!job) return false;
  await db.pool.query(
    "UPDATE jobs SET status='completed',result=$1,completed_at=now(),lease_until=NULL WHERE id=$2 AND lease_token=$3 AND status='running'",
    [JSON.stringify({ echo: job.payload.message }), job.id, job.lease_token],
  );
  return true;
}
