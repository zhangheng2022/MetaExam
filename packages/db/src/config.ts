import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
export interface RuntimeConfig {
  home: string;
  database: { host: string; port: number; database: string; user: string; password: string };
  api: {
    host: string;
    port: number;
    webPort?: number;
    webDir: string;
    tlsCert?: string;
    tlsKey?: string;
    managementToken: string;
  };
  trustFile: string;
  production: boolean;
  leaseSeconds: number;
  auth?: { hashConcurrency?: number; hashQueue?: number; accountLimit?: number; ipLimit?: number };
}
export function loadConfig(): RuntimeConfig {
  const home = path.resolve(process.env.METAEXAM_HOME ?? '.local');
  const file = process.env.METAEXAM_CONFIG ?? path.join(home, 'config.json');
  if (!existsSync(file)) throw new Error('CONFIG_MISSING: run the local bootstrap first');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RuntimeConfig & { passwordDpapi?: string };
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
  if (raw.production && (!raw.api.tlsCert || !raw.api.tlsKey))
    throw new Error('Production HTTPS certificate required');
  if (!['127.0.0.1', 'localhost', '::1'].includes(raw.api.host) && !raw.production)
    throw new Error('LAN binding requires production HTTPS');
  raw.leaseSeconds = Math.max(2, Math.min(raw.leaseSeconds ?? 30, 300));
  return raw;
}
