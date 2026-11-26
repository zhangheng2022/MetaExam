import { Pool, type PoolClient } from 'pg';
import type { RuntimeConfig } from './config';
import { migrateConnection } from './index';
import { grantRuntimeAccess, migrationRows, validateMigrations } from './migrations';
import { MAINTENANCE_LOCK } from './maintenance-gate';
import { setTimeout } from 'node:timers/promises';

/** Only the elevated offline installer uses these management connections. */
export class UpgradeDatabase {
  private control?: PoolClient;
  private target?: PoolClient;
  private readonly controls: Pool;
  private readonly targets: Pool;
  constructor(
    private readonly config: RuntimeConfig,
    private readonly runtimeRole: string,
  ) {
    this.controls = new Pool({
      ...config.database,
      database: 'postgres',
      max: 2,
      connectionTimeoutMillis: 5000,
    });
    this.targets = new Pool({ ...config.database, max: 2, connectionTimeoutMillis: 5000 });
    this.controls.on('error', () => {});
    this.targets.on('error', () => {});
  }
  async lock() {
    this.control = await this.controls.connect();
    const r = await this.control.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(184429,hashtext($1)) AS locked',
      [this.config.database.database],
    );
    if (!r.rows[0]?.locked) throw new Error('UPGRADE_BUSY');
  }
  async inspect() {
    const c = await this.targets.connect();
    try {
      const rows = await migrationRows(c);
      validateMigrations(rows, false);
      if (!rows.length) throw new Error('UPGRADE_SCHEMA_INVALID');
      const active = await c.query(
        "SELECT 1 FROM exams WHERE status='published' AND starts_at<=clock_timestamp() AND ends_at>clock_timestamp() UNION ALL SELECT 1 FROM exam_attempts WHERE status='active' AND deadline_at>clock_timestamp() LIMIT 1",
      );
      if (active.rowCount) throw new Error('EXAMS_ACTIVE');
      return rows;
    } finally {
      c.release(true);
    }
  }
  async enter() {
    if (!this.control) throw new Error('UPGRADE_LOCK_REQUIRED');
    const r = await this.control.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(184428,hashtext($1)) AS locked',
      [this.config.database.database],
    );
    if (!r.rows[0]?.locked) throw new Error('UPGRADE_BUSY');
    this.target = await this.targets.connect();
    for (let attempt = 0; attempt < 40; attempt++) {
      const lock = await this.target.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [MAINTENANCE_LOCK],
      );
      if (lock.rows[0]?.locked) {
        const others = await this.target.query(
          'SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
        );
        if (!others.rowCount) return;
      }
      await setTimeout(100);
    }
    throw new Error('SERVICES_RUNNING');
  }
  async migrate() {
    if (!this.target) throw new Error('UPGRADE_LOCK_REQUIRED');
    await migrateConnection(this.target);
    validateMigrations(await migrationRows(this.target), true);
    if (this.runtimeRole !== this.config.database.user)
      await grantRuntimeAccess(this.target, this.runtimeRole, this.config.database.database);
    await this.target.query('DELETE FROM worker_heartbeat');
  }
  async allowRuntime() {
    this.target?.release(true);
    this.target = undefined;
  }
  async workerReady(since: string) {
    const r = await this.targets.query(
      'SELECT 1 FROM worker_heartbeat WHERE id=1 AND seen_at>=$1',
      [since],
    );
    return !!r.rowCount;
  }
  async close() {
    await this.allowRuntime();
    // Destroying the control connection releases both session locks, including on failure.
    this.control?.release(true);
    this.control = undefined;
    await this.targets.end();
    await this.controls.end();
  }
}
