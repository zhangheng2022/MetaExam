import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureApplicationDatabase } from '../installer/bootstrap-database.mjs';

const require = createRequire(path.resolve('packages/db/package.json'));
const { Pool } = require('pg');
const {
  createDatabase,
  migrate,
  ensureInstance,
  grantRuntimeAccess,
  BootstrapRepository,
} = require('./dist/index.js');
const root = await mkdtemp(path.join(tmpdir(), 'MetaExam-install-bootstrap-'));
const cluster = path.join(root, 'postgres');
const password = randomBytes(32).toString('hex'),
  runtimePassword = randomBytes(32).toString('hex');
const bin = path.resolve('.tools/pgsql/bin');
const pg = (name, args) =>
  execFileSync(path.join(bin, name + '.exe'), args, {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 60000,
  });
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const p = server.address().port;
    server.close(() => resolve(p));
  });
});
let control,
  owner,
  started = false;
try {
  execFileSync(
    'icacls.exe',
    [
      root,
      '/inheritance:r',
      '/grant:r',
      process.env.USERDOMAIN + '\\' + process.env.USERNAME + ':(OI)(CI)F',
      '*S-1-5-18:(OI)(CI)F',
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
  const passFile = path.join(root, 'init-password');
  await writeFile(passFile, password);
  pg('initdb', [
    '-D',
    cluster,
    '-U',
    'metaexam_owner',
    '--encoding=UTF8',
    '--locale=C',
    '--auth=scram-sha-256',
    '--pwfile=' + passFile,
  ]);
  await rm(passFile);
  pg('pg_ctl', [
    '-D',
    cluster,
    '-l',
    path.join(root, 'postgres.log'),
    '-o',
    '-h 127.0.0.1 -p ' + port,
    'start',
    '-w',
  ]);
  started = true;
  const database = {
    host: '127.0.0.1',
    port,
    database: 'postgres',
    user: 'metaexam_owner',
    password,
  };
  control = new Pool(database);
  // Existing cluster, interrupted before role creation.
  await ensureApplicationDatabase(control, runtimePassword);
  await control.query('DROP DATABASE metaexam');
  // Interrupted after role creation, before database creation. The role/password must survive.
  const roleBefore = (
    await control.query("SELECT oid,rolpassword FROM pg_authid WHERE rolname='metaexam_app'")
  ).rows[0];
  await ensureApplicationDatabase(control, runtimePassword);
  const config = {
    home: path.join(root, 'runtime'),
    database: { ...database, database: 'metaexam' },
    api: { host: '127.0.0.1', port: 3000, managementToken: randomBytes(32).toString('hex') },
    trustFile: path.join(root, 'keys.json'),
    production: false,
    leaseSeconds: 30,
  };
  await writeFile(config.trustFile, '{}');
  owner = createDatabase(config);
  await migrate(owner);
  await ensureInstance(owner);
  await grantRuntimeAccess(owner.pool);
  // Simulate the initialized state; repair must not reopen initialization or rotate credentials.
  await owner.pool.query('UPDATE bootstrap_state SET completed_at=now() WHERE id=1');
  await owner.pool.query('CREATE TABLE repair_sentinel(value text NOT NULL)');
  await owner.pool.query("INSERT INTO repair_sentinel VALUES('keep database content')");
  const instance = (await owner.pool.query('SELECT installation_id FROM instance_info WHERE id=1'))
    .rows[0];
  const databaseBefore = (
    await control.query("SELECT oid FROM pg_database WHERE datname='metaexam'")
  ).rows[0];
  const pgVersion = await readFile(path.join(cluster, 'PG_VERSION'), 'utf8');
  // Re-enter the real bootstrap/migration path twice without initdb or recreation.
  for (let i = 0; i < 2; i++) {
    await ensureApplicationDatabase(control, runtimePassword);
    await migrate(owner);
    await ensureInstance(owner);
    await grantRuntimeAccess(owner.pool);
  }
  assert.deepEqual(
    (await control.query("SELECT oid,rolpassword FROM pg_authid WHERE rolname='metaexam_app'"))
      .rows[0],
    roleBefore,
  );
  assert.deepEqual(
    (await control.query("SELECT oid FROM pg_database WHERE datname='metaexam'")).rows[0],
    databaseBefore,
  );
  assert.deepEqual(
    (await owner.pool.query('SELECT installation_id FROM instance_info WHERE id=1')).rows[0],
    instance,
  );
  assert.equal(
    (await owner.pool.query('SELECT value FROM repair_sentinel')).rows[0].value,
    'keep database content',
  );
  assert.equal(await new BootstrapRepository(owner).initialized(), true);
  assert.equal(await readFile(path.join(cluster, 'PG_VERSION'), 'utf8'), pgVersion);
  const runtime = new Pool({ ...config.database, user: 'metaexam_app', password: runtimePassword });
  try {
    await runtime.query('SELECT 1');
  } finally {
    await runtime.end();
  }
  await control.query('ALTER ROLE metaexam_app CREATEDB');
  await assert.rejects(
    ensureApplicationDatabase(control, runtimePassword),
    /DATABASE_ROLE_OWNERSHIP/,
  );
  await control.query('ALTER ROLE metaexam_app NOCREATEDB');
  await control.query('CREATE ROLE foreign_owner');
  await control.query('ALTER DATABASE metaexam OWNER TO foreign_owner');
  await assert.rejects(ensureApplicationDatabase(control, runtimePassword), /DATABASE_OWNERSHIP/);
  // Privilege check must happen before reading even a nonexistent private config.
  for (const command of ['setup-token', 'setup-token-if-needed']) {
    const result = spawnSync(process.execPath, ['apps/worker/dist/cli.js', command], {
      env: { ...process.env, METAEXAM_CONFIG: path.join(root, 'must-not-read.json') },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ADMINISTRATOR_REQUIRED/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
  await owner.pool.end();
  owner = undefined;
  await control.end();
  control = undefined;
  pg('pg_ctl', ['-D', cluster, 'stop', '-m', 'fast', '-w']);
  started = false;
  const fixture = path.join(root, 'supervisor.mjs');
  const ended = path.join(root, 'supervisor-ended');
  const supervisorLog = path.join(root, 'supervisor-error.log');
  await writeFile(
    path.join(cluster, 'postgresql.conf'),
    `\nlogging_collector = on\nlog_directory = '${root.replaceAll('\\', '/')}'\nlog_filename = 'supervisor-error.log'\n`,
    { flag: 'a' },
  );
  await writeFile(
    fixture,
    `import { writeFileSync } from 'node:fs';
import { installPostgresShutdown, startPostgres } from ${JSON.stringify(pathToFileURL(path.resolve('installer/postgres-shutdown.mjs')).href)};
const child=startPostgres(${JSON.stringify(bin)},${JSON.stringify(cluster)},${port});
installPostgresShutdown(child,${JSON.stringify(bin)},${JSON.stringify(cluster)});
child.on('exit',code=>{writeFileSync(${JSON.stringify(ended)},String(code));process.exit(code??1)});
`,
  );
  const ps = (script, input) =>
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
  const pid = Number(
    ps(
      "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd() | ConvertFrom-Json; (Start-Process -FilePath $p.node -ArgumentList ('\"'+$p.script+'\"') -WindowStyle Hidden -PassThru).Id",
      { node: process.execPath, script: fixture },
    ).trim(),
  );
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  started = true;
  control = new Pool({ ...database, connectionTimeoutMillis: 1000 });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      await control.query('SELECT 1');
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, 'supervised PostgreSQL started');
  await control.end();
  control = undefined;
  ps(
    String.raw`$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd() | ConvertFrom-Json;
Add-Type 'using System; using System.Runtime.InteropServices; public static class RepairConsole { [DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add); }';
$a=[Reflection.Assembly]::LoadFrom($p.binary); $t=$a.GetType('WinSW.Util.ProcessHelper'); $process=[Diagnostics.Process]::GetProcessById([int]$p.pid); $null=$process.Handle; $null=$process.StartTime;
$null=[RepairConsole]::FreeConsole(); $null=[RepairConsole]::SetConsoleCtrlHandler([IntPtr]::Zero,$true);
$t.GetMethod('StopProcessTree').Invoke($null,@($process,[TimeSpan]::FromSeconds(30),$true))`,
    { binary: path.resolve('.tools/WinSW.NET462.exe'), pid },
  );
  assert.equal(await readFile(ended, 'utf8'), '0');
  const shutdownLog = await readFile(supervisorLog, 'utf8');
  assert.match(shutdownLog, /database system is shut down/);
  assert.doesNotMatch(
    shutdownLog,
    /abnormal database system shutdown|WAL was shut down unexpectedly|DATABASE_STOP_FAILED/,
  );
  const state = execFileSync(path.join(bin, 'pg_controldata.exe'), ['-D', cluster], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.match(state, /Database cluster state:\s+shut down\s/);
  started = false;
  console.log(
    'PASS isolated PostgreSQL bootstrap resume, preserved data/identity/password, privilege checks, actual WinSW Ctrl+C supervisor shutdown and clean cluster state',
  );
} finally {
  await owner?.pool.end();
  await control?.end();
  if (
    started &&
    spawnSync(path.join(bin, 'pg_ctl.exe'), ['-D', cluster, 'status'], {
      windowsHide: true,
      stdio: 'ignore',
    }).status === 0
  )
    pg('pg_ctl', ['-D', cluster, 'stop', '-m', 'fast', '-w']);
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('MetaExam-install-bootstrap-'));
  await rm(root, { recursive: true, force: true });
}
