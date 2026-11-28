import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireAdministrator } from './bootstrap';
export interface RuntimeConfig {
  home: string;
  database: { host: string; port: number; database: string; user: string; password: string };
  api: {
    host: string;
    port: number;
    webPort?: number;
    webDir: string;
    managementToken: string;
  };
  trustFile: string;
  production: boolean;
  leaseSeconds: number;
  auth?: { hashConcurrency?: number; hashQueue?: number; accountLimit?: number; ipLimit?: number };
}
export function loadConfig(): RuntimeConfig {
  return readConfig(false);
}

/** Only elevated installation maintenance may read a pre-HTTP configuration. */
export function loadInstallationConfig(): RuntimeConfig {
  requireAdministrator();
  return readConfig(true);
}

function readConfig(legacyTransport: boolean): RuntimeConfig {
  const home = path.resolve(process.env.METAEXAM_HOME ?? '.local');
  const file = process.env.METAEXAM_CONFIG ?? path.join(home, 'config.json');
  if (!existsSync(file)) throw new Error('CONFIG_MISSING: run the local bootstrap first');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RuntimeConfig & { passwordDpapi?: string };
  if (!legacyTransport && ('tlsCert' in raw.api || 'tlsKey' in raw.api))
    throw new Error('HTTP_CONFIGURATION_UPGRADE_REQUIRED');
  raw.home = path.resolve(raw.home ?? home);
  if (raw.passwordDpapi) {
    const script =
      'Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)))';
    raw.database.password = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { input: readFileSync(raw.passwordDpapi, 'utf8'), encoding: 'utf8', windowsHide: true },
    ).trim();
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(raw.database.host))
    throw new Error('Database must be local');
  for (const port of [raw.database.port, raw.api.port])
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (!raw.api.managementToken || raw.api.managementToken.length < 32)
    throw new Error('Invalid management token');
  if (!['127.0.0.1', 'localhost', '::1'].includes(raw.api.host) && !raw.production)
    throw new Error('LAN binding requires production mode');
  raw.leaseSeconds = Math.max(2, Math.min(raw.leaseSeconds ?? 30, 300));
  return raw;
}

/** Explicit elevated maintenance only; API/Worker never load the owner credential. */
export function loadMaintenanceConfig(): RuntimeConfig {
  const config = loadInstallationConfig();
  if (config.database.user !== 'metaexam_app') throw new Error('INSTALLED_CONFIGURATION_REQUIRED');
  const script =
    'Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)))';
  const password = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      input: readFileSync(path.join(config.home, '../secrets/owner.dpapi'), 'utf8'),
      encoding: 'utf8',
      windowsHide: true,
    },
  ).trim();
  return { ...config, database: { ...config.database, user: 'metaexam_owner', password } };
}
