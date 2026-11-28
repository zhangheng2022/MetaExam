import { serviceXml, serviceEntries, registerServiceEventSources } from './service-config.mjs';
// Executed by the elevated installer ONLY on the dedicated test machine.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  appendFileSync,
  unlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { completeInstallation } from './install-health.mjs';
import { lockInstallation } from './operation-lock.mjs';
import { prepareUninstall } from './uninstall-state.mjs';
import { ordinary } from './release.mjs';
import { windowsHttpNetwork, validateSubnet } from './http-network.mjs';
const [
  action,
  appDir,
  dataDir,
  portArg = '3000',
  subnet = 'LocalSubnet',
  databasePortArg = '55432',
] = process.argv.slice(2);
if (!appDir || !dataDir || !['install', 'repair', 'uninstall'].includes(action))
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
const network = windowsHttpNetwork(app, (script, input) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90000,
  }),
);
const marker = path.join(data, 'installation.json');
if (action === 'uninstall') {
  const { repairWindows } = await import('./repair-windows.mjs');
  const platform = repairWindows({ app, data, source: app });
  await platform.authorize();
  await platform.validate();
  const unlock = await lockInstallation(data);
  try {
    const commitUninstall = await prepareUninstall({ app, data }, platform);
    for (const id of [...services].reverse())
      if (query(id)) {
        spawnSync('sc.exe', ['stop', id], { windowsHide: true, stdio: 'ignore' });
        // Wait for STOPPED using the numeric state (independent of OS language).
        let stopped = false;
        for (let i = 0; i < 45; i++) {
          const state =
            spawnSync('sc.exe', ['query', id], { encoding: 'utf8', windowsHide: true }).stdout ??
            '';
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
    const config = JSON.parse(readFileSync(path.join(data, 'config.json'), 'utf8'));
    await network.removeFirewall(config.api.port);
    await commitUninstall();
  } finally {
    await unlock();
  }
  console.log('SERVICES_REMOVED_DATA_PRESERVED');
  process.exit(0);
}
const repairing = action === 'repair';
let savedConfig;
if (repairing) {
  const require = createRequire(path.join(app, 'server/db.cjs'));
  require('./db.cjs').requireAdministrator();
  const { repairWindows } = await import('./repair-windows.mjs');
  await repairWindows({ app, data, source: app }).validate();
  const pending = JSON.parse(readFileSync(path.join(data, 'upgrade-pending.json'), 'utf8'));
  const record = JSON.parse(readFileSync(marker, 'utf8'));
  const release = JSON.parse(readFileSync(path.join(app, 'release.json'), 'utf8'));
  if (
    pending.kind !== 'install-repair' ||
    pending.phase !== 'configuring' ||
    pending.buildId !== release.buildId ||
    pending.app !== app ||
    pending.data !== data ||
    record.product !== 'MetaExam' ||
    record.app !== app ||
    record.data !== data
  )
    throw new Error('REPAIR_COORDINATOR_REQUIRED');
  savedConfig = JSON.parse(readFileSync(path.join(data, 'config.json'), 'utf8'));
}
const port = repairing ? savedConfig.api.port : Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid application port');
const databasePort = repairing ? savedConfig.database.port : Number(databasePortArg);
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
if (owned && !repairing) throw new Error('EXISTING_INSTALLATION_USE_UPGRADE');
validateSubnet(repairing ? savedConfig.firewallSubnet : subnet);
for (const p of [port, databasePort])
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', () => reject(new Error('PORT_IN_USE: ' + p)));
    s.listen(p, '0.0.0.0', () => s.close(resolve));
  });
if (!repairing)
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
for (const sub of ['runtime', 'postgres', 'secrets', 'logs/api', 'logs/worker', 'logs/postgres'])
  mkdirSync(path.join(data, sub), { recursive: true });
if (!repairing)
  writeFileSync(
    marker,
    JSON.stringify({ product: 'MetaExam', app, data, phase: 'configuring' }, null, 2),
  );
const node = path.join(app, 'runtime/node.exe'),
  configPath = path.join(data, 'config.json');
mkdirSync(path.join(app, 'services'), { recursive: true });
await ordinary(path.join(app, 'services'));
registerServiceEventSources();
for (const [id, entry, log] of serviceEntries(data)) {
  const xml = serviceXml(app, data, id, entry, log);
  const exe = path.join(app, 'services', id + '.exe');
  copyFileSync(path.join(app, 'vendor/WinSW.NET462.exe'), exe);
  writeFileSync(path.join(app, 'services', id + '.xml'), xml);
  if (repairing && query(id)) sc('config', id, 'start=', 'auto');
  else sc('create', id, 'binPath=', '"' + exe + '"', 'start=', 'auto', 'obj=', 'NT SERVICE\\' + id);
  sc('sidtype', id, 'unrestricted');
  sc('failure', id, 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/restart/60000');
  run('icacls.exe', [data, '/grant', 'NT SERVICE\\' + id + ':RX']);
  run('icacls.exe', [app, '/grant', 'NT SERVICE\\' + id + ':(OI)(CI)RX']);
  run('icacls.exe', [log, '/grant', 'NT SERVICE\\' + id + ':(OI)(CI)M']);
}
sc('config', 'MetaExam.Api', 'depend=', 'MetaExam.Postgres');
sc('config', 'MetaExam.Worker', 'depend=', 'MetaExam.Postgres');
run('icacls.exe', [marker, '/grant', 'NT SERVICE\\MetaExam.Postgres:R']);
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
if (!repairing) {
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
      host: '0.0.0.0',
      port,
      webDir: path.join(app, 'web'),
      managementToken: randomBytes(32).toString('hex'),
    },
    trustFile: path.join(app, 'public-keys.json'),
    production: true,
    leaseSeconds: 30,
    firewallSubnet: subnet,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  run('icacls.exe', [configPath, '/grant', ...services.map((id) => 'NT SERVICE\\' + id + ':R')]);
  writeFileSync(path.join(data, 'public-config.json'), JSON.stringify({ api: { port } }));
  run('icacls.exe', [path.join(data, 'public-config.json'), '/grant', '*S-1-5-32-545:R']);
  run('icacls.exe', [data, '/grant', '*S-1-5-32-545:RX']);
}
await network.configureFirewall(port, repairing ? savedConfig.firewallSubnet : subnet);
const readyFile = path.join(data, 'runtime/database-ready.json');
if (existsSync(readyFile)) unlinkSync(readyFile);
sc('start', 'MetaExam.Postgres');
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
execFileSync(
  node,
  [path.join(app, 'server/cli.cjs'), repairing ? 'setup-token-if-needed' : 'setup-token'],
  {
    env: { ...process.env, METAEXAM_CONFIG: configPath },
    windowsHide: true,
    stdio: 'pipe',
  },
);
const { repairWindows } = await import('./repair-windows.mjs');
const healthPlatform = repairWindows({ app, data, source: app });
await healthPlatform.validate();
await completeInstallation({
  start: async () => {
    sc('start', 'MetaExam.Api');
    sc('start', 'MetaExam.Worker');
  },
  healthy: async (since) =>
    healthPlatform.healthy(JSON.parse(readFileSync(path.join(app, 'release.json'), 'utf8')), since),
  commit: async () => {
    if (!repairing)
      writeFileSync(
        marker,
        JSON.stringify(
          {
            product: 'MetaExam',
            app,
            data,
            phase: 'installed',
            version: JSON.parse(readFileSync(path.join(app, 'release.json'), 'utf8')).version,
            buildId: JSON.parse(readFileSync(path.join(app, 'release.json'), 'utf8')).buildId,
          },
          null,
          2,
        ),
      );
  },
});
console.log('INSTALL_CONFIGURED: complete the independent acceptance checklist');
