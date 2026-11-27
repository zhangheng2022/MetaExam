import path from 'node:path';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ordinary, hashFile } from './release.mjs';
import { run } from './upgrade-windows.mjs';
import { waitForHealthy } from './install-health.mjs';

const ids = ['MetaExam.Api', 'MetaExam.Worker', 'MetaExam.Postgres'];
export function repairWindows({ app, data, source }) {
  const require = createRequire(path.join(source, 'server/db.cjs'));
  const db = require('./db.cjs');
  const { Pool } = require('pg');
  const ps = (script, input) =>
    run(
      path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {},
      input,
    );
  const serviceList = async () =>
    JSON.parse(
      (await ps(
        "$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Service | Where-Object { $_.Name -in @('MetaExam.Api','MetaExam.Worker','MetaExam.Postgres') } | Select-Object Name,State,PathName,StartName)",
      )) || '[]',
    );
  const services = async () => {
    const result = await serviceList();
    return Array.isArray(result) ? result : [result];
  };
  let config;
  return {
    authorize: async () => db.requireAdministrator(),
    validate: async () => {
      const release = JSON.parse(await readFile(path.join(source, 'release.json'), 'utf8'));
      if (
        db.APP_VERSION !== release.version ||
        db.SCHEMA_VERSION !== release.schemaVersion ||
        JSON.stringify(db.MIGRATIONS.map(({ version, checksum }) => ({ version, checksum }))) !==
          JSON.stringify(release.migrations)
      )
        throw new Error('REPAIR_RELEASE_MISMATCH');
      for (const name of ['config.json', 'secrets/database.dpapi', 'secrets/owner.dpapi']) {
        await ordinary(path.join(data, name));
        await hashFile(path.join(data, name));
      }
      await ps(
        "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $a=Get-Acl -LiteralPath $p; if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'REPAIR_DATA_ACL' }; $mask=[Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'; foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if($r.AccessControlType -eq 'Allow' -and ($r.FileSystemRights -band $mask) -ne 0 -and $r.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'REPAIR_DATA_ACL' } }",
        data,
      );
      process.env.METAEXAM_CONFIG = path.join(data, 'config.json');
      config = db.loadConfig();
      const raw = JSON.parse(await readFile(process.env.METAEXAM_CONFIG, 'utf8'));
      const same = (a, b) =>
        typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
      if (
        !same(config.home, path.join(data, 'runtime')) ||
        !same(config.trustFile, path.join(app, 'public-keys.json')) ||
        !same(raw.passwordDpapi, path.join(data, 'secrets/database.dpapi')) ||
        config.database.user !== 'metaexam_app' ||
        config.database.database !== 'metaexam'
      )
        throw new Error('REPAIR_CONFIGURATION_REQUIRED');
      if (
        config.api.tlsCert &&
        (!same(config.api.tlsCert, path.join(data, 'certs/server.crt')) ||
          !same(config.api.tlsKey, path.join(data, 'certs/server.key')))
      )
        throw new Error('REPAIR_CONFIGURATION_REQUIRED');
      for (const s of await services()) {
        if (
          !ids.includes(s.Name) ||
          s.PathName.replace(/^"|"$/g, '').toLowerCase() !==
            path.join(app, 'services', s.Name + '.exe').toLowerCase() ||
          s.StartName.toLowerCase() !== ('NT SERVICE\\' + s.Name).toLowerCase()
        )
          throw new Error('REPAIR_SERVICE_OWNERSHIP');
        if (
          (await hashFile(path.join(app, 'services', s.Name + '.exe'))) !==
          (await hashFile(path.join(source, 'vendor/WinSW.NET462.exe')))
        )
          throw new Error('REPAIR_RUNTIME_MISMATCH');
      }
      const active = await ps(
        '$p=[Console]::In.ReadToEnd(); @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($p,[StringComparison]::OrdinalIgnoreCase) }).Count',
        path.join(app, 'manager') + path.sep,
      );
      if (Number(active.trim()) !== 0) throw new Error('REPAIR_CLOSE_MANAGER');
    },
    secure: async (folder) =>
      ps(
        "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $a=[Security.AccessControl.DirectorySecurity]::new(); $a.SetAccessRuleProtection($true,$false); foreach($sid in @('S-1-5-18','S-1-5-32-544')) { $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }; Set-Acl -LiteralPath $p -AclObject $a",
        folder,
      ),
    programAccess: async (folder) => {
      const list = await services();
      if (list.length)
        await run('icacls.exe', [
          folder,
          '/grant',
          ...list.map((s) => 'NT SERVICE\\' + s.Name + ':(OI)(CI)RX'),
          '/T',
        ]);
    },
    pendingAccess: async (file) => run('icacls.exe', [file, '/grant', '*S-1-5-32-545:R']),
    recordAccess: async (file) =>
      run('icacls.exe', [file, '/grant', 'NT SERVICE\\MetaExam.Postgres:R']),
    firewallSubnet: async () => {
      if (!config.api.tlsCert) return undefined;
      const result = await ps(
        "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $rules=@(Get-NetFirewallRule -DisplayName 'MetaExam HTTPS' -ErrorAction SilentlyContinue | Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -eq $p }); $addresses=@($rules | Get-NetFirewallAddressFilter | ForEach-Object { $_.RemoteAddress } | Select-Object -Unique); [Console]::Write(($addresses -join ','))",
        path.join(app, 'runtime/node.exe'),
      );
      return result.trim() || undefined;
    },
    stop: async () => {
      const pending = JSON.parse(await readFile(path.join(data, 'upgrade-pending.json'), 'utf8'));
      if (
        pending.phase === 'backup' &&
        existsSync(path.join(data, 'postgres/data/PG_VERSION')) &&
        (await services()).some((s) => s.Name === 'MetaExam.Api' && s.State === 'Running')
      ) {
        const response = await fetch(
          (config.api.tlsCert ? 'https' : 'http') +
            '://127.0.0.1:' +
            config.api.port +
            '/api/v1/maintenance/stop',
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            headers: { authorization: 'Bearer ' + config.api.managementToken },
          },
        );
        if (!response.ok) throw new Error('REPAIR_DRAIN_FAILED');
      }
      for (const s of await services()) {
        await run('sc.exe', ['config', s.Name, 'start=', 'disabled']);
        await run('sc.exe', ['failure', s.Name, 'reset=', '86400', 'actions=', '']);
      }
      await ps(
        "$ErrorActionPreference='Stop'; foreach($id in @('MetaExam.Api','MetaExam.Worker')) { $s=Get-Service $id -ErrorAction SilentlyContinue; if($s -and $s.Status -ne 'Stopped') { Stop-Service $id -ErrorAction Stop; $s.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60)) } }",
      );
      const postgres = (await services()).find((s) => s.Name === 'MetaExam.Postgres');
      if (
        postgres &&
        postgres.State !== 'Stopped' &&
        existsSync(path.join(data, 'postgres/data/PG_VERSION'))
      )
        await run(
          path.join(app, 'postgres/bin/pg_ctl.exe'),
          ['-D', path.join(data, 'postgres/data'), 'stop', '-m', 'fast', '-w', '-t', '60'],
          { timeout: 70000 },
        );
      await ps(
        "$ErrorActionPreference='Stop'; $s=Get-Service MetaExam.Postgres -ErrorAction SilentlyContinue; if($s -and $s.Status -ne 'Stopped') { if($s.Status -ne 'StopPending') { Stop-Service MetaExam.Postgres -ErrorAction Stop }; $s.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60)) }",
      );
    },
    configure: async () => {
      const installed = await ps(
        "$r=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64' -ErrorAction SilentlyContinue; [int]$r.Installed",
      );
      if (Number(installed.trim()) !== 1)
        await ps(
          "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $r=Start-Process -FilePath $p -ArgumentList '/install','/quiet','/norestart' -WindowStyle Hidden -Wait -PassThru; if($r.ExitCode -notin @(0,3010,1638)) { throw 'REPAIR_RUNTIME_INSTALL_FAILED' }",
          path.join(app, 'vendor/vc_redist.x64.exe'),
        );
      await run(
        path.join(app, 'runtime/node.exe'),
        ['--use-system-ca', path.join(app, 'maintenance/setup.mjs'), 'repair', app, data],
        { cwd: app, timeout: 300000 },
      );
    },
    healthy: async (release, since) => {
      const pool = new Pool({
        ...config.database,
        connectionTimeoutMillis: 2000,
        query_timeout: 2000,
      });
      const url = (config.api.tlsCert ? 'https' : 'http') + '://127.0.0.1:' + config.api.port;
      try {
        await waitForHealthy({
          url,
          release,
          workerReady: async () => {
            const heartbeat = await pool.query(
              'SELECT 1 FROM worker_heartbeat WHERE id=1 AND seen_at >= $1',
              [since],
            );
            return heartbeat.rowCount === 1;
          },
          servicesReady: async () =>
            (await services()).filter((s) => s.State === 'Running').length === 3,
        });
      } finally {
        await pool.end();
      }
    },
  };
}
