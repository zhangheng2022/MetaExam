import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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
const fresh = !existsSync(path.join(pgData, 'PG_VERSION'));
if (fresh) {
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
const child = spawn(
  path.join(bin, 'postgres.exe'),
  ['-D', pgData, '-h', '127.0.0.1', '-p', String(config.database.port)],
  { stdio: 'inherit', windowsHide: true },
);
child.on('exit', (code) => process.exit(code ?? 1));
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
  if (fresh) {
    // Password is a generated hex string; no user-supplied SQL identifiers are accepted.
    if (!/^[a-f0-9]{64}$/.test(config.database.password))
      throw new Error('Unexpected generated credential');
    await db.pool.query(
      "CREATE ROLE metaexam_app LOGIN PASSWORD '" + config.database.password + "'",
    );
    await db.pool.query('CREATE DATABASE metaexam OWNER metaexam_owner');
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
      if (fresh) {
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
