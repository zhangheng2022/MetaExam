// Executed by the elevated installer ONLY on the dedicated test machine.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  appendFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
const [
  action,
  appDir,
  dataDir,
  certFile = '',
  keyFile = '',
  portArg = '3000',
  subnet = 'LocalSubnet',
  databasePortArg = '55432',
] = process.argv.slice(2);
if (!appDir || !dataDir || !['install', 'uninstall'].includes(action))
  throw new Error('Invalid setup arguments');
const app = path.resolve(appDir),
  data = path.resolve(dataDir),
  services = ['MetaExam.Postgres', 'MetaExam.Api', 'MetaExam.Worker'];
let dataSecured = false;
process.on('uncaughtException', (error) => {
  // Preflight errors must not follow a rejected directory/junction to write logs.
  if (dataSecured) {
    mkdirSync(path.join(data, 'logs'), { recursive: true });
    appendFileSync(
      path.join(data, 'logs/setup.log'),
      new Date().toISOString() + ' ' + error.message + '\n',
    );
  } else console.error(error.message);
  process.exit(1);
});
const run = (exe, args) =>
  execFileSync(exe, args, { stdio: 'pipe', windowsHide: true, timeout: 90000 });
const sc = (...args) => run('sc.exe', args);
function query(name) {
  return spawnSync('sc.exe', ['query', name], { windowsHide: true, stdio: 'ignore' }).status === 0;
}
const marker = path.join(data, 'installation.json');
if (action === 'uninstall') {
  if (!existsSync(marker) || JSON.parse(readFileSync(marker, 'utf8')).app !== app)
    throw new Error('Installation ownership mismatch');
  for (const id of [...services].reverse())
    if (query(id)) {
      spawnSync('sc.exe', ['stop', id], { windowsHide: true, stdio: 'ignore' });
      // Wait for STOPPED using the numeric state (independent of OS language).
      let stopped = false;
      for (let i = 0; i < 45; i++) {
        const state =
          spawnSync('sc.exe', ['query', id], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
        if (/:\s+1\s+STOPPED/.test(state)) {
          stopped = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!stopped)
        throw new Error(
          'SERVICE_STOP_TIMEOUT: ' + id + '; retry removal after stopping the service',
        );
      sc('delete', id);
    }
  spawnSync('netsh.exe', ['advfirewall', 'firewall', 'delete', 'rule', 'name=MetaExam HTTPS'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  console.log('SERVICES_REMOVED_DATA_PRESERVED');
  process.exit(0);
}
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HTTPS port');
const databasePort = Number(databasePortArg);
if (
  !Number.isInteger(databasePort) ||
  databasePort < 1 ||
  databasePort > 65535 ||
  databasePort === port
)
  throw new Error('Invalid or conflicting database port');
const owned = existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).app === app;
if (services.some(query) && !owned)
  throw new Error('Existing services not owned by this installation');
if (existsSync(marker) && !owned)
  throw new Error('Data directory belongs to a different installation');
if (!owned && existsSync(path.join(data, 'postgres')))
  throw new Error('Existing database without installation record');
if (owned)
  throw new Error(
    'PHASE1_UPGRADE_REQUIRES_MANUAL_MAINTENANCE: preserve data, use the documented recovery procedure',
  );
if (!!certFile != !!keyFile)
  throw new Error('Certificate and private key must be supplied together');
for (const p of [port, databasePort])
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', () => reject(new Error('PORT_IN_USE: ' + p)));
    s.listen(p, '0.0.0.0', () => s.close(resolve));
  });
if (certFile) {
  const cert = new X509Certificate(readFileSync(certFile)),
    key = createPrivateKey(readFileSync(keyFile));
  if (!cert.checkPrivateKey(key)) throw new Error('Certificate/key mismatch');
  if (Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now())
    throw new Error('Certificate outside validity');
  if (!cert.checkIP('127.0.0.1'))
    throw new Error('Certificate must include 127.0.0.1 SAN for local management');
  createPublicKey(key);
}
run('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  path.join(app, 'maintenance/data-directory.ps1'),
  '-DataPath',
  data,
]);
dataSecured = true;
for (const sub of [
  'runtime',
  'postgres',
  'secrets',
  'certs',
  'logs/api',
  'logs/worker',
  'logs/postgres',
])
  mkdirSync(path.join(data, sub), { recursive: true });
writeFileSync(
  marker,
  JSON.stringify({ product: 'MetaExam', app, data, phase: 'configuring' }, null, 2),
);
const encode = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const node = path.join(app, 'runtime/node.exe'),
  configPath = path.join(data, 'config.json');
const entries = [
  ['MetaExam.Postgres', 'maintenance/postgres-service.mjs', path.join(data, 'logs/postgres')],
  ['MetaExam.Api', 'server/api.cjs', path.join(data, 'logs/api')],
  ['MetaExam.Worker', 'server/worker.cjs', path.join(data, 'logs/worker')],
];
for (const [id, entry, log] of entries) {
  const stop =
    id === 'MetaExam.Postgres'
      ? '<stopexecutable>' +
        encode(path.join(app, 'postgres/bin/pg_ctl.exe')) +
        '</stopexecutable><stoparguments>-D &quot;' +
        encode(path.join(data, 'postgres/data')) +
        '&quot; stop -m fast -w</stoparguments>'
      : '';
  const xml =
    '<service><id>' +
    id +
    '</id><name>' +
    id +
    '</name><description>MetaExam internal test service</description><executable>' +
    encode(node) +
    '</executable><arguments>--use-system-ca &quot;' +
    encode(path.join(app, entry)) +
    '&quot;</arguments><workingdirectory>' +
    encode(app) +
    '</workingdirectory><env name="METAEXAM_CONFIG" value="' +
    encode(configPath) +
    '"/><env name="METAEXAM_INSTALL_ROOT" value="' +
    encode(app) +
    '"/><env name="METAEXAM_DATA_ROOT" value="' +
    encode(data) +
    '"/><logpath>' +
    encode(log) +
    '</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log><stoptimeout>30sec</stoptimeout>' +
    stop +
    '</service>';
  const exe = path.join(app, 'services', id + '.exe');
  copyFileSync(path.join(app, 'vendor/WinSW.NET462.exe'), exe);
  writeFileSync(path.join(app, 'services', id + '.xml'), xml);
  sc('create', id, 'binPath=', '"' + exe + '"', 'start=', 'auto', 'obj=', 'NT SERVICE\\' + id);
  sc('sidtype', id, 'unrestricted');
  sc('failure', id, 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/restart/60000');
  run('icacls.exe', [data, '/grant', 'NT SERVICE\\' + id + ':RX']);
  run('icacls.exe', [app, '/grant', 'NT SERVICE\\' + id + ':(OI)(CI)RX']);
  run('icacls.exe', [log, '/grant', 'NT SERVICE\\' + id + ':(OI)(CI)M']);
}
sc('config', 'MetaExam.Api', 'depend=', 'MetaExam.Postgres');
sc('config', 'MetaExam.Worker', 'depend=', 'MetaExam.Postgres');
for (const id of services)
  run('icacls.exe', [path.join(data, 'runtime'), '/grant', 'NT SERVICE\\' + id + ':(OI)(CI)M']);
run('icacls.exe', [
  path.join(data, 'postgres'),
  '/grant',
  'NT SERVICE\\MetaExam.Postgres:(OI)(CI)M',
]);
for (const id of services)
  run('icacls.exe', [path.join(data, 'secrets'), '/grant', 'NT SERVICE\\' + id + ':RX']);
function secret(name, value, allowed) {
  const script =
    'Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)))';
  const protectedValue = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: value, encoding: 'utf8', windowsHide: true },
  );
  const file = path.join(data, 'secrets', name);
  writeFileSync(file, protectedValue);
  run('icacls.exe', [
    file,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-18:F',
    '*S-1-5-32-544:F',
    ...allowed.map((id) => 'NT SERVICE\\' + id + ':R'),
  ]);
  return file;
}
const appPassword = secret('database.dpapi', randomBytes(32).toString('hex'), services);
secret('owner.dpapi', randomBytes(32).toString('hex'), ['MetaExam.Postgres']);
const config = {
  home: path.join(data, 'runtime'),
  database: {
    host: '127.0.0.1',
    port: databasePort,
    database: 'metaexam',
    user: 'metaexam_app',
    password: '',
  },
  passwordDpapi: appPassword,
  api: {
    host: certFile ? '0.0.0.0' : '127.0.0.1',
    port,
    webDir: path.join(app, 'web'),
    managementToken: randomBytes(32).toString('hex'),
  },
  trustFile: path.join(app, 'public-keys.json'),
  production: !!certFile,
  leaseSeconds: 30,
};
if (certFile) {
  config.api.tlsCert = path.join(data, 'certs/server.crt');
  config.api.tlsKey = path.join(data, 'certs/server.key');
  copyFileSync(certFile, config.api.tlsCert);
  copyFileSync(keyFile, config.api.tlsKey);
  run('icacls.exe', [path.join(data, 'certs'), '/grant', 'NT SERVICE\\MetaExam.Api:(OI)(CI)R']);
}
writeFileSync(configPath, JSON.stringify(config, null, 2));
run('icacls.exe', [configPath, '/grant', ...services.map((id) => 'NT SERVICE\\' + id + ':R')]);
writeFileSync(
  path.join(data, 'public-config.json'),
  JSON.stringify({ api: { port, tlsCert: config.api.tlsCert } }),
);
run('icacls.exe', [path.join(data, 'public-config.json'), '/grant', '*S-1-5-32-545:R']);
run('icacls.exe', [data, '/grant', '*S-1-5-32-545:RX']);
if (certFile)
  run('netsh.exe', [
    'advfirewall',
    'firewall',
    'add',
    'rule',
    'name=MetaExam HTTPS',
    'dir=in',
    'action=allow',
    'protocol=TCP',
    'localport=' + port,
    'remoteip=' + subnet,
    'profile=private,domain',
    'program=' + node,
  ]);
sc('start', 'MetaExam.Postgres');
const readyFile = path.join(data, 'runtime/database-ready.json');
let ready = false;
for (let i = 0; i < 90; i++) {
  if (existsSync(readyFile)) {
    ready = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!ready)
  throw new Error(
    'DATABASE_INITIALIZATION_FAILED: inspect database service logs; existing data was retained',
  );
execFileSync(node, [path.join(app, 'server/cli.cjs'), 'setup-token'], {
  env: { ...process.env, METAEXAM_CONFIG: configPath },
  windowsHide: true,
  stdio: 'pipe',
});
sc('start', 'MetaExam.Api');
sc('start', 'MetaExam.Worker');
writeFileSync(
  marker,
  JSON.stringify({ product: 'MetaExam', app, data, phase: 'installed', version: '0.1.0' }, null, 2),
);
console.log('INSTALL_CONFIGURED: complete the independent acceptance checklist');
