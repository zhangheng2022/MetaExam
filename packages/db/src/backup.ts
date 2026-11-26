import { Pool, type PoolClient } from 'pg';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BackupInfo } from '@metaexam/contracts';
import type { RuntimeConfig } from './config';
import { APP_VERSION } from './index';
import {
  SCHEMA_VERSION,
  migrationRows,
  validateMigrations,
  grantRuntimeAccess,
} from './migrations';
import { MAINTENANCE_LOCK, maintenanceMarker } from './maintenance-gate';
import { fingerprint } from './fingerprint';

type Entry = { name: string; bytes: number; sha256: string };
type Manifest = BackupInfo & {
  format: 1;
  appVersion: string;
  installationId: string;
  deviceHash: string;
  databaseBytes: number;
  entries: Entry[];
  settings: { databasePort: number; apiPort: number; production: boolean };
  watermark: { sequence: number; time: string };
};
type Journal = {
  format: 1;
  id: string;
  database: string;
  oldOid: number;
  old: string;
  fresh: string;
  hadFiles: boolean;
  kind: 'backup' | 'restore';
};
type Options = {
  bin: string;
  key: Buffer;
  runtimeRole: string;
  secureDirectory: (directory: string) => Promise<void>;
  /** Test-only fault injection, never read from CLI/environment. */
  checkpoint?: (point: string) => void;
};
const identifier = (name: string) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error('BACKUP_CONFIGURATION');
  return '"' + name + '"';
};
const safeName = (name: string) =>
  name === 'database.dump' ||
  /^files\/(images\/[a-f0-9-]{36}\.png|imports\/[a-f0-9-]{36}\.xlsx)$/.test(name);

export async function ordinaryPath(file: string) {
  const full = path.resolve(file);
  let current = full;
  while (true) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('BACKUP_UNSAFE_PATH');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return full;
}
async function digest(file: string): Promise<Entry> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('BACKUP_UNSAFE_PATH');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  if (bytes !== stat.size) throw new Error('BACKUP_CHANGED');
  return { name: '', bytes, sha256: hash.digest('hex') };
}
function summary(m: Manifest): BackupInfo {
  return {
    id: m.id,
    createdAt: m.createdAt,
    schemaVersion: m.schemaVersion,
    fileCount: m.fileCount,
    bytes: m.bytes,
  };
}
export class BackupService {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly options: Options,
  ) {
    identifier(config.database.database);
    identifier(options.runtimeRole);
    if (options.key.length !== 32) throw new Error('BACKUP_CONFIGURATION');
  }
  private pool(database = this.config.database.database) {
    const pool = new Pool({
      ...this.config.database,
      database,
      max: 2,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', () => {});
    return pool;
  }
  private sign(payload: string) {
    return createHmac('sha256', this.options.key).update(payload).digest('hex');
  }
  private async space(directory: string, bytes: number) {
    const available = await statfs(directory);
    if (available.bavail * available.bsize < bytes + 64 * 1024 * 1024)
      throw new Error('BACKUP_SPACE_REQUIRED');
  }
  private async pg(tool: 'pg_dump' | 'pg_restore', database: string, args: string[]) {
    await new Promise<void>((resolve, reject) => {
      execFile(
        path.join(this.options.bin, tool + (process.platform === 'win32' ? '.exe' : '')),
        [
          '--no-password',
          '--host',
          this.config.database.host,
          '--port',
          String(this.config.database.port),
          '--username',
          this.config.database.user,
          '--dbname',
          database,
          ...args,
        ],
        {
          windowsHide: true,
          timeout: 30 * 60 * 1000,
          maxBuffer: 1024 * 1024,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('PG')),
            ),
            PGPASSWORD: this.config.database.password,
            PGOPTIONS: '-c statement_timeout=0',
            PGAPPNAME: 'metaexam-maintenance',
          },
        },
        (error) => (error ? reject(new Error('BACKUP_DATABASE_TOOL_FAILED')) : resolve()),
      );
    });
  }
  private async current(c: PoolClient) {
    const version = Number((await c.query('SHOW server_version_num')).rows[0]?.server_version_num);
    if (version < 180000 || version >= 190000) throw new Error('BACKUP_INCOMPATIBLE');
    validateMigrations(await migrationRows(c), true);
    const instance = (
      await c.query<{ installation_id: string }>(
        'SELECT installation_id FROM instance_info WHERE id=1',
      )
    ).rows[0];
    if (!instance) throw new Error('BACKUP_INSTANCE_REQUIRED');
    const active = await c.query(
      "SELECT 1 FROM exams WHERE status='published' AND starts_at<=clock_timestamp() AND ends_at>clock_timestamp() UNION ALL SELECT 1 FROM exam_attempts WHERE status='active' AND deadline_at>clock_timestamp() LIMIT 1",
    );
    if (active.rowCount) throw new Error('EXAMS_ACTIVE');
    return instance.installation_id;
  }
  private async open(kind: Journal['kind']) {
    await ordinaryPath(this.config.home);
    const controller = this.pool('postgres');
    const control = await controller.connect();
    const locked = await control.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(184428,hashtext($1)) AS locked',
      [this.config.database.database],
    );
    const finish = async () => {
      control.release(true);
      await controller.end();
    };
    if (!locked.rows[0]?.locked) {
      await finish();
      throw new Error('OPERATION_BUSY');
    }
    const id = randomUUID();
    const journal: Journal = {
      format: 1,
      id,
      database: this.config.database.database,
      oldOid: 0,
      old: 'metaexam_old_' + id.replaceAll('-', ''),
      fresh: 'metaexam_restore_' + id.replaceAll('-', ''),
      hadFiles: existsSync(path.join(this.config.home, 'files')),
      kind,
    };
    const file = maintenanceMarker(this.config.home);
    try {
      await writeFile(file, JSON.stringify(journal), { flag: 'wx' });
    } catch (error) {
      await finish();
      throw new Error('MAINTENANCE_REQUIRED', { cause: error });
    }
    const pool = this.pool();
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      let exclusive = false;
      for (let retry = 0; retry < 30; retry++) {
        const result = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [MAINTENANCE_LOCK],
        );
        if (result.rows[0]?.locked) {
          exclusive = true;
          break;
        }
        await delay(100);
      }
      if (!exclusive) throw new Error('SERVICES_RUNNING');
      for (let retry = 0; ; retry++) {
        const others = await client.query(
          'SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
        );
        if (!others.rowCount) break;
        if (retry >= 30) throw new Error('SERVICES_RUNNING');
        await delay(100);
      }
      journal.oldOid = (
        await client.query<{ oid: number }>(
          'SELECT oid FROM pg_database WHERE datname=current_database()',
        )
      ).rows[0]!.oid;
      const next = file + '.' + id + '.tmp';
      await writeFile(next, JSON.stringify(journal), { flag: 'wx' });
      await rename(next, file);
      return {
        journal,
        client,
        finish,
        close: async () => {
          client!.release(true);
          await pool.end();
        },
      };
    } catch (error) {
      client?.release(true);
      await pool.end();
      await unlink(file);
      await finish();
      throw error;
    }
  }
  private workspace(j: Journal) {
    return path.join(this.config.home, 'restore-' + j.id);
  }
  private async files(root: string) {
    const entries: Entry[] = [];
    if (existsSync(path.join(root, 'files'))) {
      await ordinaryPath(path.join(root, 'files'));
      if (
        (await readdir(path.join(root, 'files'))).some(
          (name) => !['images', 'imports'].includes(name),
        )
      )
        throw new Error('BACKUP_UNSAFE_PATH');
    }
    for (const kind of ['images', 'imports']) {
      const folder = path.join(root, 'files', kind);
      if (!existsSync(folder)) continue;
      await ordinaryPath(folder);
      for (const name of await readdir(folder)) {
        if (name.endsWith('.tmp')) continue;
        const relative = 'files/' + kind + '/' + name;
        if (!safeName(relative)) throw new Error('BACKUP_UNSAFE_PATH');
        entries.push({ ...(await digest(path.join(root, relative))), name: relative });
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }
  private async checkReferences(c: PoolClient, entries: Entry[]) {
    const map = new Map(entries.map((e) => [e.name, e]));
    const images = await c.query<{ id: string; digest: string }>(
      'SELECT id,digest FROM question_attachments',
    );
    const imports = await c.query<{ id: string; digest: string }>(
      'SELECT id,source_digest AS digest FROM question_imports',
    );
    for (const [kind, rows, ext] of [
      ['images', images.rows, 'png'],
      ['imports', imports.rows, 'xlsx'],
    ] as const)
      for (const row of rows)
        if (map.get(`files/${kind}/${row.id}.${ext}`)?.sha256 !== row.digest)
          throw new Error('BACKUP_ATTACHMENT_MISSING');
  }
  async create(parent: string): Promise<BackupInfo> {
    await ordinaryPath(parent);
    const relative = path.relative(this.config.home, path.resolve(parent));
    if (
      !relative ||
      (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    )
      throw new Error('BACKUP_UNSAFE_PATH');
    const operation = await this.open('backup');
    try {
      const installationId = await this.current(operation.client);
      const databaseBytes = Number(
        (await operation.client.query('SELECT pg_database_size(current_database()) AS bytes'))
          .rows[0].bytes,
      );
      const device = await fingerprint(installationId);
      const folder = path.join(parent, 'MetaExam-' + operation.journal.id + '.mbackup');
      await mkdir(folder);
      await this.options.secureDirectory(folder);
      // Files cannot change while all runtime connections are excluded.
      const files = await this.files(this.config.home);
      await this.checkReferences(operation.client, files);
      await this.space(parent, databaseBytes * 2 + files.reduce((n, e) => n + e.bytes, 0));
      for (const e of files) {
        const target = path.join(folder, e.name);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(this.config.home, e.name), target, 1);
      }
      await this.pg('pg_dump', this.config.database.database, [
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--file',
        path.join(folder, 'database.dump'),
      ]);
      const entries = [
        { ...(await digest(path.join(folder, 'database.dump'))), name: 'database.dump' },
        ...files,
      ];
      const manifest: Manifest = {
        format: 1,
        id: operation.journal.id,
        createdAt: new Date().toISOString(),
        appVersion: APP_VERSION,
        schemaVersion: SCHEMA_VERSION,
        installationId,
        deviceHash: device.hash,
        databaseBytes,
        fileCount: files.length,
        bytes: entries.reduce((n, e) => n + e.bytes, 0),
        entries,
        settings: {
          databasePort: this.config.database.port,
          apiPort: this.config.api.port,
          production: this.config.production,
        },
        watermark: await this.watermark(),
      };
      const payload = JSON.stringify(manifest);
      await writeFile(
        path.join(folder, 'manifest.json'),
        JSON.stringify({ payload, mac: this.sign(payload) }),
        { flag: 'wx' },
      );
      await this.validate(folder);
      await operation.client.query(
        "INSERT INTO audit_events(id,event,outcome,request_id,details) VALUES($1,'maintenance.backup','success',$2,$3)",
        [
          operation.journal.id,
          operation.journal.id,
          { backupId: manifest.id, fileCount: manifest.fileCount },
        ],
      );
      return summary(manifest);
    } finally {
      try {
        await operation.close();
        await unlink(maintenanceMarker(this.config.home));
      } finally {
        await operation.finish();
      }
    }
  }
  private async watermark(): Promise<{ sequence: number; time: string }> {
    const file = path.join(this.config.home, 'license-watermark.json');
    if (!existsSync(file)) return { sequence: 0, time: new Date(0).toISOString() };
    await ordinaryPath(file);
    const value = JSON.parse(await readFile(file, 'utf8')) as { sequence: number; time: string };
    if (
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 ||
      !Number.isFinite(Date.parse(value.time))
    )
      throw new Error('BACKUP_INVALID');
    return value;
  }
  private async validate(folder: string): Promise<Manifest> {
    await ordinaryPath(folder);
    const file = path.join(folder, 'manifest.json');
    await ordinaryPath(file);
    if ((await lstat(file)).size > 16 * 1024 * 1024) throw new Error('BACKUP_INVALID');
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { payload: string; mac: string };
    if (
      typeof envelope.payload !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.mac ?? '') ||
      !timingSafeEqual(
        Buffer.from(envelope.mac, 'hex'),
        Buffer.from(this.sign(envelope.payload), 'hex'),
      )
    )
      throw new Error('BACKUP_UNTRUSTED');
    const m = JSON.parse(envelope.payload) as Manifest;
    if (
      m.format !== 1 ||
      m.appVersion !== APP_VERSION ||
      m.schemaVersion !== SCHEMA_VERSION ||
      !Number.isSafeInteger(m.databaseBytes) ||
      m.databaseBytes < 0 ||
      !Number.isSafeInteger(m.bytes) ||
      m.bytes < 0 ||
      !Array.isArray(m.entries) ||
      m.entries.length > 100001 ||
      m.entries[0]?.name !== 'database.dump' ||
      new Set(m.entries.map((e) => e.name)).size !== m.entries.length
    )
      throw new Error('BACKUP_INCOMPATIBLE');
    for (const e of m.entries) {
      if (!safeName(e.name)) throw new Error('BACKUP_UNSAFE_PATH');
      await ordinaryPath(path.join(folder, e.name));
      const actual = await digest(path.join(folder, e.name));
      if (actual.sha256 !== e.sha256 || actual.bytes !== e.bytes) throw new Error('BACKUP_CHANGED');
    }
    return m;
  }
  async preview(folder: string): Promise<BackupInfo> {
    const m = await this.validate(folder);
    const pool = this.pool();
    try {
      const row = (await pool.query('SELECT installation_id FROM instance_info WHERE id=1'))
        .rows[0] as { installation_id?: string } | undefined;
      if (row?.installation_id !== m.installationId) throw new Error('BACKUP_WRONG_INSTANCE');
      if ((await fingerprint(m.installationId)).hash !== m.deviceHash)
        throw new Error('BACKUP_WRONG_DEVICE');
      return summary(m);
    } finally {
      await pool.end();
    }
  }
  async restore(folder: string, expectedId: string): Promise<{ restored: true }> {
    const manifest = await this.validate(folder);
    if (manifest.id !== expectedId) throw new Error('BACKUP_CHANGED');
    const op = await this.open('restore');
    const j = op.journal;
    let closed = false;
    const admin = this.pool('postgres');
    try {
      if ((await this.current(op.client)) !== manifest.installationId)
        throw new Error('BACKUP_WRONG_INSTANCE');
      if ((await fingerprint(manifest.installationId)).hash !== manifest.deviceHash)
        throw new Error('BACKUP_WRONG_DEVICE');
      await this.files(this.config.home);
      const dataDirectory = (await op.client.query('SHOW data_directory')).rows[0]
        .data_directory as string;
      const required = manifest.databaseBytes * 2 + manifest.bytes * 2;
      await this.space(this.config.home, required);
      await this.space(dataDirectory, required);
      const work = this.workspace(j);
      await mkdir(work); // Inherit runtime ACLs: restored files must remain readable by services.
      for (const e of manifest.entries) {
        const target = path.join(work, e.name);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(folder, e.name), target, 1);
        const copied = await digest(target);
        if (copied.sha256 !== e.sha256 || copied.bytes !== e.bytes)
          throw new Error('BACKUP_CHANGED');
      }
      await mkdir(path.join(work, 'files'), { recursive: true });
      await admin.query('CREATE DATABASE ' + identifier(j.fresh) + ' TEMPLATE template0');
      await this.pg('pg_restore', j.fresh, [
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
        path.join(work, 'database.dump'),
      ]);
      const candidate = this.pool(j.fresh);
      const c = await candidate.connect();
      try {
        if ((await this.current(c)) !== manifest.installationId)
          throw new Error('BACKUP_WRONG_INSTANCE');
        await this.checkReferences(c, manifest.entries);
        const before = (
          await op.client.query('SELECT completed_at FROM bootstrap_state WHERE id=1')
        ).rows[0] as { completed_at: Date | null };
        const after = (await c.query('SELECT completed_at FROM bootstrap_state WHERE id=1'))
          .rows[0] as { completed_at: Date | null };
        if (before.completed_at && !after.completed_at)
          throw new Error('BACKUP_INITIALIZATION_ROLLBACK');
        await this.preserveLicense(op.client, c);
        const watermark = await this.watermark();
        await c.query(
          'UPDATE license_state SET highest_sequence=GREATEST(highest_sequence,$1,$2),last_trusted_at=GREATEST(last_trusted_at,$3,$4) WHERE id=1',
          [
            manifest.watermark.sequence,
            watermark.sequence,
            manifest.watermark.time,
            watermark.time,
          ],
        );
        await c.query(
          'DELETE FROM auth_sessions; DELETE FROM worker_heartbeat; UPDATE bootstrap_state SET token_hash=NULL,expires_at=NULL',
        );
        await c.query(
          "INSERT INTO audit_events(id,event,outcome,request_id,details) VALUES($1,'maintenance.restore','success',$2,$3)",
          [j.id, j.id, { backupId: manifest.id }],
        );
        if (this.options.runtimeRole !== this.config.database.user)
          await grantRuntimeAccess(c, this.options.runtimeRole, j.fresh);
      } finally {
        c.release();
        await candidate.end();
      }
      this.options.checkpoint?.('validated');
      await op.close();
      closed = true;
      // The durable marker excludes new runtime connections across both rename operations.
      await admin.query(
        'ALTER DATABASE ' + identifier(j.database) + ' RENAME TO ' + identifier(j.old),
      );
      this.options.checkpoint?.('old-renamed');
      await admin.query(
        'ALTER DATABASE ' + identifier(j.fresh) + ' RENAME TO ' + identifier(j.database),
      );
      this.options.checkpoint?.('database-swapped');
      const liveFiles = path.join(this.config.home, 'files');
      if (existsSync(liveFiles)) await rename(liveFiles, path.join(work, 'previous-files'));
      this.options.checkpoint?.('files-moved');
      await rename(path.join(work, 'files'), liveFiles);
      this.options.checkpoint?.('files-swapped');
      await writeFile(
        path.join(work, 'receipt.json'),
        JSON.stringify({ ...j, backupId: manifest.id, completedAt: new Date().toISOString() }),
      );
      await unlink(maintenanceMarker(this.config.home));
      return { restored: true };
    } catch (error) {
      if (!closed) {
        await op.close();
        closed = true;
      }
      try {
        await this.rollback(j, admin);
      } catch (recoveryError) {
        throw new Error('RESTORE_RECOVERY_REQUIRED', { cause: recoveryError });
      }
      throw error;
    } finally {
      if (!closed) await op.close();
      await admin.end();
      await op.finish();
    }
  }
  private async preserveLicense(source: PoolClient, target: PoolClient) {
    const current = (await source.query('SELECT * FROM license_state WHERE id=1')).rows[0] as {
      highest_sequence: string;
      digest: string | null;
      raw: string | null;
      last_trusted_at: Date;
    };
    const history = await source.query('SELECT * FROM license_history');
    // Keep the live license; an older backup must never lower either high-water mark.
    await target.query(
      'UPDATE license_state SET highest_sequence=GREATEST(highest_sequence,$1),digest=$2,raw=$3,last_trusted_at=GREATEST(last_trusted_at,$4) WHERE id=1',
      [current.highest_sequence, current.digest, current.raw, current.last_trusted_at],
    );
    await target.query('DELETE FROM license_history');
    for (const h of history.rows as {
      id: string;
      sequence: string;
      digest: string;
      raw: string;
      imported_at: Date;
    }[])
      await target.query(
        'INSERT INTO license_history(id,sequence,digest,raw,imported_at) VALUES($1,$2,$3,$4,$5)',
        [h.id, h.sequence, h.digest, h.raw, h.imported_at],
      );
    // license-watermark.json, trust keys and all machine credentials remain untouched.
  }
  private async rollback(j: Journal, admin: Pool) {
    const work = this.workspace(j);
    // A failed mkdir or a damaged journal must not redirect recovery through a junction.
    for (const directory of [
      work,
      path.join(work, 'previous-files'),
      path.join(this.config.home, 'files'),
    ])
      if (existsSync(directory)) await ordinaryPath(directory);
    const original = (
      await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE oid=$1', [
        j.oldOid,
      ])
    ).rows[0];
    if (!original || ![j.database, j.old].includes(original.datname))
      throw new Error('RESTORE_RECOVERY_REQUIRED');
    if (original.datname === j.old) {
      const live = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [j.database]))
        .rowCount;
      if (live)
        await admin.query(
          'ALTER DATABASE ' + identifier(j.database) + ' RENAME TO ' + identifier(j.fresh),
        );
      await admin.query(
        'ALTER DATABASE ' + identifier(j.old) + ' RENAME TO ' + identifier(j.database),
      );
    }
    const prior = path.join(work, 'previous-files');
    if (existsSync(prior)) {
      const live = path.join(this.config.home, 'files');
      if (existsSync(live)) await rename(live, path.join(work, 'rejected-files'));
      await rename(prior, live);
    } else if (
      !j.hadFiles &&
      existsSync(path.join(work, 'database.dump')) &&
      !existsSync(path.join(work, 'files')) &&
      existsSync(path.join(this.config.home, 'files'))
    ) {
      await rename(path.join(this.config.home, 'files'), path.join(work, 'rejected-files'));
    }
    await unlink(maintenanceMarker(this.config.home));
  }
  async recover(): Promise<{ recovered: boolean }> {
    const file = maintenanceMarker(this.config.home);
    const admin = this.pool('postgres');
    const control = await admin.connect();
    try {
      const lock = await control.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(184428,hashtext($1)) AS locked',
        [this.config.database.database],
      );
      if (!lock.rows[0]?.locked) throw new Error('OPERATION_BUSY');
      // Read only after acquiring the lock: an earlier snapshot can belong to an
      // operation which has since completed, and must never roll it back.
      if (!existsSync(file)) return { recovered: false };
      await ordinaryPath(file);
      const j = JSON.parse(await readFile(file, 'utf8')) as Journal;
      if (
        j.format !== 1 ||
        !/^[a-f0-9-]{36}$/.test(j.id) ||
        j.database !== this.config.database.database ||
        !['backup', 'restore'].includes(j.kind) ||
        typeof j.hadFiles !== 'boolean' ||
        !Number.isInteger(j.oldOid) ||
        j.oldOid < 0 ||
        j.old !== 'metaexam_old_' + j.id.replaceAll('-', '') ||
        j.fresh !== 'metaexam_restore_' + j.id.replaceAll('-', '')
      )
        throw new Error('RESTORE_RECOVERY_REQUIRED');
      // An active command owns the marker: never recover over a live backup/restore.
      const activity = await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=ANY($1)', [
        [j.database, j.old, j.fresh],
      ]);
      if (activity.rowCount) throw new Error('SERVICES_RUNNING');
      if (j.kind === 'backup' || !j.oldOid) await unlink(file);
      else await this.rollback(j, admin);
      return { recovered: true };
    } finally {
      control.release(true);
      await admin.end();
    }
  }
}
