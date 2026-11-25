import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
const root = path.resolve(import.meta.dirname, '..'),
  home = path.join(root, '.local'),
  bin = path.join(root, '.tools', 'pgsql', 'bin'),
  data = path.join(home, 'postgres');
const command = process.argv[2] ?? 'start';
mkdirSync(home, { recursive: true });
const user = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
execFileSync(
  'icacls.exe',
  [home, '/inheritance:r', '/grant:r', user + ':(OI)(CI)F', 'SYSTEM:(OI)(CI)F'],
  { stdio: 'ignore', windowsHide: true },
);
const pg = (name, args) =>
  execFileSync(path.join(bin, name + '.exe'), args, {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 60000,
  });
const running = () =>
  spawnSync(path.join(bin, 'pg_ctl.exe'), ['-D', data, 'status'], {
    windowsHide: true,
    stdio: 'ignore',
  }).status === 0;
if (command === 'stop') {
  if (running()) pg('pg_ctl', ['-D', data, 'stop', '-m', 'fast', '-w']);
  console.log('Local PostgreSQL stopped');
} else {
  const configFile = path.join(home, 'config.json');
  let c = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : null;
  if (!c) {
    if (existsSync(path.join(data, 'PG_VERSION')))
      throw new Error('Existing database without config; refusing to reset credentials');
    c = {
      home,
      database: {
        host: '127.0.0.1',
        port: Number(process.env.METAEXAM_PG_PORT ?? 55432),
        database: 'metaexam',
        user: 'metaexam',
        password: randomBytes(32).toString('base64url'),
      },
      api: {
        host: '127.0.0.1',
        port: Number(process.env.METAEXAM_API_PORT ?? 3000),
        webDir: path.join(root, 'apps/web/dist'),
        managementToken: randomBytes(32).toString('hex'),
      },
      trustFile: path.join(home, 'trusted-public-keys.json'),
      production: false,
      leaseSeconds: 5,
    };
    writeFileSync(configFile, JSON.stringify(c, null, 2), { mode: 0o600 });
    writeFileSync(c.trustFile, '{}\n', { flag: 'wx' });
  }
  if (!existsSync(path.join(data, 'PG_VERSION'))) {
    if (existsSync(data))
      throw new Error('Database directory already exists; inspect it before initialization');
    const pass = path.join(home, 'init-pass.txt');
    writeFileSync(pass, c.database.password, { mode: 0o600 });
    try {
      pg('initdb', [
        '-D',
        data,
        '-U',
        c.database.user,
        '--encoding=UTF8',
        '--locale=C',
        '--auth=scram-sha-256',
        '--pwfile=' + pass,
      ]);
    } finally {
      unlinkSync(pass);
    }
  }
  if (!running()) {
    await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', () => reject(new Error('DATABASE_PORT_IN_USE: ' + c.database.port)));
      s.listen(c.database.port, '127.0.0.1', () => s.close(resolve));
    });
    pg('pg_ctl', [
      '-D',
      data,
      '-l',
      path.join(home, 'postgres.log'),
      '-o',
      '-h 127.0.0.1 -p ' + c.database.port,
      '-w',
      'start',
    ]);
  }
  const result = spawnSync(
    path.join(bin, 'psql.exe'),
    [
      '-h',
      '127.0.0.1',
      '-p',
      String(c.database.port),
      '-U',
      c.database.user,
      '-d',
      'postgres',
      '-tAc',
      "SELECT 1 FROM pg_database WHERE datname='metaexam'",
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PGPASSWORD: c.database.password },
    },
  );
  if (result.status !== 0) throw new Error('DATABASE_CONNECTION_FAILED');
  if (result.stdout.trim() !== '1') {
    const created = spawnSync(
      path.join(bin, 'createdb.exe'),
      ['-h', '127.0.0.1', '-p', String(c.database.port), '-U', c.database.user, 'metaexam'],
      {
        windowsHide: true,
        env: { ...process.env, PGPASSWORD: c.database.password },
        stdio: 'pipe',
      },
    );
    if (created.status !== 0) throw new Error('DATABASE_CREATE_FAILED');
  }
  console.log(
    'Local PostgreSQL ready on 127.0.0.1:' +
      c.database.port +
      ' (ordinary process; no service registered)',
  );
}
