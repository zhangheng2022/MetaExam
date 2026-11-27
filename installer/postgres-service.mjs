import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureApplicationDatabase } from './bootstrap-database.mjs';
import { installPostgresShutdown, startPostgres } from './postgres-shutdown.mjs';
const app = process.env.METAEXAM_INSTALL_ROOT,
  data = process.env.METAEXAM_DATA_ROOT;
if (!app || !data) throw new Error('SERVICE_CONFIGURATION_REQUIRED');
const require = createRequire(path.join(app, 'server/db.cjs'));
const { Pool } = require('pg');
const {
  createDatabase,
  migrate,
  ensureInstance,
  loadConfig,
  readiness,
  grantRuntimeAccess,
} = require(path.join(app, 'server/db.cjs'));
const config = loadConfig(),
  pgData = path.join(data, 'postgres/data'),
  bin = path.join(app, 'postgres/bin');
function decrypt(file) {
  const script =
    'Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)))';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: readFileSync(file, 'utf8'),
    encoding: 'utf8',
    windowsHide: true,
  });
}
const ownerPassword = decrypt(path.join(data, 'secrets/owner.dpapi'));
const record = JSON.parse(readFileSync(path.join(data, 'installation.json'), 'utf8'));
const configuring =
  record.product === 'MetaExam' &&
  record.phase === 'configuring' &&
  path.resolve(record.app).toLowerCase() === path.resolve(app).toLowerCase() &&
  path.resolve(record.data).toLowerCase() === path.resolve(data).toLowerCase();
const fresh = !existsSync(path.join(pgData, 'PG_VERSION'));
if (fresh) {
  if (!configuring) throw new Error('DATABASE_MISSING_REQUIRES_RECOVERY');
  if (existsSync(pgData))
    throw new Error('Refusing to initialize a nonempty or partial database directory');
  const file = path.join(data, 'postgres/init-pass.txt');
  writeFileSync(file, ownerPassword, { mode: 0o600 });
  try {
    execFileSync(
      path.join(bin, 'initdb.exe'),
      [
        '-D',
        pgData,
        '-U',
        'metaexam_owner',
        '--encoding=UTF8',
        '--locale=C',
        '--auth=scram-sha-256',
        '--pwfile=' + file,
      ],
      { stdio: 'inherit', windowsHide: true },
    );
  } finally {
    unlinkSync(file);
  }
}
const child = startPostgres(bin, pgData, config.database.port);
child.on('exit', (code) => process.exit(code ?? 1));
installPostgresShutdown(child, bin, pgData);
// The PostgreSQL supervisor must remain available for interrupted-restore recovery.
const db = {
  pool: new Pool({
    ...config.database,
    database: 'postgres',
    user: 'metaexam_owner',
    password: ownerPassword,
  }),
};
try {
  let connected = false;
  for (let i = 0; i < 60; i++) {
    try {
      await db.pool.query('SELECT 1');
      connected = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!connected) throw new Error('PostgreSQL did not become ready');
  if (configuring) {
    await ensureApplicationDatabase(db.pool, config.database.password);
    const runtime = new Pool(config.database);
    try {
      await runtime.query('SELECT 1');
    } finally {
      await runtime.end();
    }
  }
  await db.pool.end();
  if (existsSync(path.join(config.home, 'maintenance.json'))) {
    console.log('MAINTENANCE_RECOVERY_REQUIRED');
  } else {
    const owner = createDatabase({
      ...config,
      database: { ...config.database, user: 'metaexam_owner', password: ownerPassword },
    });
    try {
      if (configuring) {
        await migrate(owner);
        await ensureInstance(owner);
      }
      if (!(await readiness(owner))) throw new Error('Explicit schema migration required');
      await grantRuntimeAccess(owner.pool);
      writeFileSync(
        path.join(data, 'runtime/database-ready.json'),
        JSON.stringify({ readyAt: new Date().toISOString() }),
      );
    } finally {
      await owner.pool.end();
    }
  }
} catch {
  child.kill();
  throw new Error('DATABASE_BOOTSTRAP_FAILED: see service log');
}
