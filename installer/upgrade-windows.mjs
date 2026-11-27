import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
import net from 'node:net';
import { ordinary, hashFile } from './release.mjs';
import { refreshServiceConfiguration } from './service-config.mjs';

export function run(exe, args, options = {}, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      args,
      {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = stderr.trim();
          reject(new Error(/^[A-Z_]+$/.test(code) ? code : 'UPGRADE_COMMAND_FAILED'));
        } else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
const powershell = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
);
const ps = (script, input) =>
  run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {}, input);
export async function windowsPlatform({ app, data, source }) {
  const require = createRequire(path.join(source, 'server/db.cjs'));
  const dbModule = require('./db.cjs');
  dbModule.requireAdministrator();
  const release = JSON.parse(await readFile(path.join(source, 'release.json'), 'utf8'));
  if (
    dbModule.APP_VERSION !== release.version ||
    dbModule.SCHEMA_VERSION !== release.schemaVersion ||
    JSON.stringify(dbModule.MIGRATIONS.map(({ version, checksum }) => ({ version, checksum }))) !==
      JSON.stringify(release.migrations)
  )
    throw new Error('UPGRADE_RELEASE_MISMATCH');
  process.env.METAEXAM_CONFIG = path.join(data, 'config.json');
  const runtime = dbModule.loadConfig();
  if (
    path.resolve(runtime.home).toLowerCase() !== path.join(data, 'runtime').toLowerCase() ||
    runtime.database.user !== 'metaexam_app' ||
    path.resolve(runtime.trustFile).toLowerCase() !==
      path.join(app, 'public-keys.json').toLowerCase()
  )
    throw new Error('UPGRADE_CONFIGURATION');
  const config = dbModule.loadMaintenanceConfig();
  const database = new dbModule.UpgradeDatabase(config, runtime.database.user);
  const env = {
    ...process.env,
    METAEXAM_CONFIG: path.join(data, 'config.json'),
    METAEXAM_INSTALL_ROOT: app,
  };
  const cli = async (entry, input) =>
    JSON.parse(
      await run(
        path.join(app, 'runtime/node.exe'),
        [entry, 'backup-desktop'],
        { env, timeout: 35 * 60 * 1000 },
        JSON.stringify(input),
      ),
    );
  const services = async () =>
    JSON.parse(
      await ps(
        "@('MetaExam.Api','MetaExam.Worker','MetaExam.Postgres') | ForEach-Object { Get-CimInstance Win32_Service -Filter (\"Name='\"+$_+\"'\") -ErrorAction Stop | Select-Object Name,State,PathName,StartName } | ConvertTo-Json -Compress",
      ),
    );
  return {
    database,
    authorize: async () => dbModule.requireAdministrator(),
    validateServices: async () => {
      const list = await services();
      if (!Array.isArray(list) || list.length !== 3) throw new Error('UPGRADE_SERVICE_OWNERSHIP');
      for (const s of list) {
        if (
          !['MetaExam.Api', 'MetaExam.Worker', 'MetaExam.Postgres'].includes(s.Name) ||
          s.PathName.replace(/^"|"$/g, '').toLowerCase() !==
            path.join(app, 'services', s.Name + '.exe').toLowerCase() ||
          s.StartName.toLowerCase() !== ('NT SERVICE\\' + s.Name).toLowerCase()
        )
          throw new Error('UPGRADE_SERVICE_OWNERSHIP');
        if (
          (await hashFile(path.join(app, 'services', s.Name + '.exe'))) !==
          (await hashFile(path.join(source, 'vendor/WinSW.NET462.exe')))
        )
          throw new Error('UPGRADE_RUNTIME_INCOMPATIBLE');
      }
      if (list.find((s) => s.Name === 'MetaExam.Postgres').State !== 'Running')
        throw new Error('UPGRADE_DATABASE_STOPPED');
      const running = await ps(
        '$p=[Console]::In.ReadToEnd(); @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($p,[StringComparison]::OrdinalIgnoreCase) }).Count',
        path.join(app, 'manager') + path.sep,
      );
      if (Number(running.trim()) > 0) throw new Error('UPGRADE_CLOSE_MANAGER');
    },
    baseline: async () => {
      const old = createRequire(path.join(app, 'server/db.cjs'))('./db.cjs');
      return {
        version: old.APP_VERSION,
        backup: typeof old.BackupService === 'function',
        migrations: old.MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })),
      };
    },
    payloadSize: async (root) => {
      const r = JSON.parse(await readFile(path.join(root, 'release.json'), 'utf8'));
      let total = 0;
      for (const file of Object.keys(r.files)) total += (await stat(path.join(root, file))).size;
      return total;
    },
    secure: async (directory) => {
      await ordinary(directory);
      await ps(
        "$p=[Console]::In.ReadToEnd(); $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @('S-1-5-18','S-1-5-32-544')) { $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl -ErrorAction Stop",
        directory,
      );
    },
    programAccess: async (directory) => {
      await ordinary(directory);
      await run('icacls.exe', [
        path.join(data, 'installation.json'),
        '/grant',
        'NT SERVICE\\MetaExam.Postgres:R',
      ]);
      await run('icacls.exe', [
        directory,
        '/grant',
        ...['Api', 'Worker', 'Postgres'].map((id) => 'NT SERVICE\\MetaExam.' + id + ':(OI)(CI)RX'),
        '/T',
      ]);
    },
    recordAccess: async (file) =>
      run('icacls.exe', [file, '/grant', 'NT SERVICE\\MetaExam.Postgres:R']),
    pendingAccess: async (file) => {
      await ordinary(file);
      await run('icacls.exe', [
        file,
        '/grant',
        'NT SERVICE\\MetaExam.Api:R',
        'NT SERVICE\\MetaExam.Worker:R',
      ]);
    },
    stop: async () => {
      await database.inspect();
      const api = (await services()).find((s) => s.Name === 'MetaExam.Api');
      const marker = path.join(runtime.home, 'maintenance.json');
      const pending = path.join(data, 'upgrade-pending.json');
      let gated = false;
      if (existsSync(marker) && existsSync(pending)) {
        const m = JSON.parse(await readFile(marker, 'utf8')),
          p = JSON.parse(await readFile(pending, 'utf8'));
        gated = m.format === 2 && m.kind === 'upgrade' && m.id === p.id && p.phase !== 'backup';
      }
      if (api.State === 'Running' && !gated) {
        const response = await fetch(
          (runtime.api.tlsCert ? 'https' : 'http') +
            '://127.0.0.1:' +
            runtime.api.port +
            '/api/v1/maintenance/stop',
          {
            method: 'POST',
            redirect: 'error',
            headers: { authorization: 'Bearer ' + runtime.api.managementToken },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok) throw new Error('UPGRADE_DRAIN_FAILED');
      }
      // Prevent a queued SCM recovery action from restarting the old binaries
      // between Stop-Service and the program-directory replacement.
      for (const id of ['MetaExam.Api', 'MetaExam.Worker']) {
        await run('sc.exe', ['config', id, 'start=', 'disabled']);
        await run('sc.exe', ['failure', id, 'reset=', '86400', 'actions=', '']);
      }
      await ps(
        "$ErrorActionPreference='Stop'; foreach($id in @('MetaExam.Api','MetaExam.Worker')) { $s=Get-Service -Name $id; if($s.Status -ne 'Stopped') { Stop-Service -Name $id -ErrorAction Stop; $s.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(45)) } }",
      );
      await new Promise((resolve, reject) => {
        const listener = net.createServer();
        listener.once('error', () => reject(new Error('UPGRADE_PORT_IN_USE')));
        listener.listen(runtime.api.port, '127.0.0.1', () => listener.close(resolve));
      });
    },
    backup: async (_app, directory) => {
      const marker = path.join(runtime.home, 'maintenance.json');
      if (existsSync(marker)) {
        const interrupted = JSON.parse(await readFile(marker, 'utf8'));
        if (interrupted.format !== 1 || interrupted.kind !== 'backup')
          throw new Error('MAINTENANCE_REQUIRED');
        await cli(path.join(app, 'server/cli.cjs'), { operation: 'recover' });
      }
      await mkdir(directory, { recursive: true });
      await ordinary(directory);
      return cli(path.join(app, 'server/cli.cjs'), { operation: 'create', directory });
    },
    validateBackup: async (_app, work, id) => {
      const old = path.join(work, 'previous/server/cli.cjs');
      await cli(existsSync(old) ? old : path.join(app, 'server/cli.cjs'), {
        operation: 'preview',
        directory: path.join(work, 'backups', 'MetaExam-' + id + '.mbackup'),
      });
    },
    start: async () => {
      await refreshServiceConfiguration(app, data);
      for (const id of ['MetaExam.Api', 'MetaExam.Worker']) {
        await run('sc.exe', ['config', id, 'start=', 'auto']);
        await run('sc.exe', [
          'failure',
          id,
          'reset=',
          '86400',
          'actions=',
          'restart/5000/restart/15000/restart/60000',
        ]);
      }
      await ps(
        "$ErrorActionPreference='Stop'; Start-Service MetaExam.Api,MetaExam.Worker; foreach($id in @('MetaExam.Api','MetaExam.Worker')) { (Get-Service $id).WaitForStatus('Running',[TimeSpan]::FromSeconds(45)) }",
      );
    },
    healthy: async (release, since) => {
      const url = (runtime.api.tlsCert ? 'https' : 'http') + '://127.0.0.1:' + runtime.api.port;
      for (let retry = 0; retry < 60; retry++) {
        try {
          const live = await fetch(url + '/health/live', { signal: AbortSignal.timeout(2000) });
          const ready = await fetch(url + '/health/ready', { signal: AbortSignal.timeout(2000) });
          if (
            live.ok &&
            (await live.json()).version === release.version &&
            ready.ok &&
            (await ready.json()).schemaVersion === release.schemaVersion &&
            (await database.workerReady(since))
          )
            return;
        } catch {
          /* bounded startup retry, never log credentials or request headers */
        }
        await setTimeout(1000);
      }
      throw new Error('UPGRADE_START_FAILED');
    },
  };
}
