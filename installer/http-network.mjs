import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { ordinary, hashFile } from './release.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
export function validateSubnet(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.length)
    throw new Error('HTTP_SUBNET_INVALID');
  const address = (text) => {
    const [ip, prefix, extra] = text.split('/');
    const family = isIP(ip);
    return (
      family &&
      extra === undefined &&
      (prefix === undefined ||
        (/^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)))
    );
  };
  for (const item of value.split(',')) {
    const entry = item.trim();
    if (entry === 'LocalSubnet') continue;
    const range = entry.split('-');
    if (range.length === 1 && address(entry)) continue;
    if (range.length === 2 && isIP(range[0]) && isIP(range[0]) === isIP(range[1])) continue;
    throw new Error('HTTP_SUBNET_INVALID');
  }
  return value;
}

export function httpConfiguration(raw, subnet) {
  if (!raw.api || !Number.isInteger(raw.api.port) || raw.api.port < 1 || raw.api.port > 65535)
    throw new Error('HTTP_CONFIGURATION_INVALID');
  const api = { ...raw.api, host: '0.0.0.0' };
  delete api.tlsCert;
  delete api.tlsKey;
  return { ...raw, api, production: true, firewallSubnet: validateSubnet(subnet) };
}

async function atomic(file, text, access) {
  if (existsSync(file)) await ordinary(file);
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, text, { flag: 'wx' });
  await access?.(temporary, file);
  await rename(temporary, file);
}

async function readTransition(data, work) {
  const file = path.join(work, 'http-network.json');
  if (!existsSync(file)) return undefined;
  await ordinary(file);
  const journal = JSON.parse(await readFile(file, 'utf8'));
  if (
    journal.format !== 1 ||
    typeof journal.configBefore !== 'string' ||
    !(journal.publicBefore === null || typeof journal.publicBefore === 'string')
  )
    throw new Error('HTTP_TRANSITION_INVALID');
  const after = JSON.stringify(
    httpConfiguration(JSON.parse(journal.configBefore), journal.subnet),
    null,
    2,
  );
  const publicAfter = JSON.stringify({ api: { port: JSON.parse(after).api.port } });
  if (
    digest(journal.configBefore) !== journal.beforeHash ||
    digest(after) !== journal.afterHash ||
    (journal.publicBefore === null ? null : digest(journal.publicBefore)) !==
      journal.publicBeforeHash ||
    digest(publicAfter) !== journal.publicAfterHash
  )
    throw new Error('HTTP_TRANSITION_INVALID');
  const current = await hashFile(path.join(data, 'config.json'));
  const publicFile = path.join(data, 'public-config.json');
  const currentPublic = existsSync(publicFile) ? await hashFile(publicFile) : null;
  if (
    ![journal.beforeHash, journal.afterHash].includes(current) ||
    ![journal.publicBeforeHash, journal.publicAfterHash].includes(currentPublic)
  )
    throw new Error('HTTP_CONFIGURATION_CHANGED');
  const original = path.join(work, 'http-config-before.json');
  if ((await hashFile(original)) !== journal.beforeHash) throw new Error('HTTP_TRANSITION_INVALID');
  return { ...journal, after, publicAfter, original };
}

/** Validate an interrupted conversion before treating the original config as preserved. */
export async function originalConfigurationHash(data, work) {
  return (await readTransition(data, work))?.beforeHash ?? hashFile(path.join(data, 'config.json'));
}

/** Old backup CLIs still need their original TLS/production configuration on resume. */
export async function backupConfiguration(data, work) {
  return (await readTransition(data, work))?.original ?? path.join(data, 'config.json');
}

/** Called only after stop + backup, inside the installation lock and pending gate. */
export async function migrateHttpNetwork({ data, work }, operations) {
  await ordinary(work);
  let transition = await readTransition(data, work);
  if (!transition) {
    const file = path.join(data, 'config.json');
    await ordinary(file);
    const configBefore = await readFile(file, 'utf8');
    const raw = JSON.parse(configBefore);
    const record = JSON.parse(await readFile(path.join(data, 'installation.json'), 'utf8'));
    const subnet =
      raw.firewallSubnet ??
      record.reinstall?.subnet ??
      (await operations.firewallSubnet?.(raw.api.port)) ??
      'LocalSubnet';
    const after = JSON.stringify(httpConfiguration(raw, subnet), null, 2);
    const publicFile = path.join(data, 'public-config.json');
    if (existsSync(publicFile)) await ordinary(publicFile);
    const publicBefore = existsSync(publicFile) ? await readFile(publicFile, 'utf8') : null;
    const publicAfter = JSON.stringify({ api: { port: raw.api.port } });
    const original = path.join(work, 'http-config-before.json');
    if (existsSync(original)) {
      if ((await hashFile(original)) !== digest(configBefore))
        throw new Error('HTTP_CONFIGURATION_CHANGED');
    } else await atomic(original, configBefore);
    await atomic(
      path.join(work, 'http-network.json'),
      JSON.stringify(
        {
          format: 1,
          configBefore,
          publicBefore,
          subnet,
          beforeHash: digest(configBefore),
          afterHash: digest(after),
          publicBeforeHash: publicBefore === null ? null : digest(publicBefore),
          publicAfterHash: digest(publicAfter),
        },
        null,
        2,
      ),
    );
    await operations.checkpoint?.('http-prepared');
    transition = await readTransition(data, work);
  }
  await atomic(path.join(data, 'config.json'), transition.after, operations.configAccess);
  await operations.checkpoint?.('http-config');
  await atomic(
    path.join(data, 'public-config.json'),
    transition.publicAfter,
    operations.publicAccess,
  );
  await operations.checkpoint?.('http-public-config');
  await operations.configureFirewall(JSON.parse(transition.after).api.port, transition.subnet);
  await operations.checkpoint?.('http-firewall');
  await readTransition(data, work);
}

/** Fixed PowerShell scripts receive data through stdin, never interpolated commands. */
export function windowsHttpNetwork(app, ps) {
  const program = path.join(app, 'runtime/node.exe');
  const select =
    "$v=[Console]::In.ReadToEnd() | ConvertFrom-Json; $rules=@(Get-NetFirewallRule -ErrorAction Stop | Where-Object { $_.DisplayName -in @('MetaExam HTTPS','MetaExam HTTP') -and ($_ | Get-NetFirewallApplicationFilter).Program -eq $v.program -and ($_ | Get-NetFirewallPortFilter).LocalPort -eq [string]$v.port -and ($_ | Get-NetFirewallPortFilter).Protocol -eq 'TCP' -and $_.Direction -eq 'Inbound' })";
  const input = (port, subnet) => JSON.stringify({ program, port, subnet });
  return {
    firewallSubnet: async (port) =>
      (
        await ps(
          "$ErrorActionPreference='Stop'; " +
            select +
            "; $addresses=@($rules | Get-NetFirewallAddressFilter | ForEach-Object { $_.RemoteAddress } | Select-Object -Unique); [Console]::Write(($addresses -join ','))",
          input(port),
        )
      ).trim() || undefined,
    configureFirewall: async (port, subnet) => {
      validateSubnet(subnet);
      await ps(
        "$ErrorActionPreference='Stop'; " +
          select +
          "; $rules | Remove-NetFirewallRule -ErrorAction Stop; New-NetFirewallRule -DisplayName 'MetaExam HTTP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $v.port -RemoteAddress ($v.subnet -split ',' | ForEach-Object { $_.Trim() }) -Profile Private,Domain -Program $v.program -ErrorAction Stop | Out-Null",
        input(port, subnet),
      );
    },
    removeFirewall: async (port) =>
      ps(
        "$ErrorActionPreference='Stop'; " +
          select +
          '; $rules | Remove-NetFirewallRule -ErrorAction Stop',
        input(port),
      ),
    configAccess: async (temporary, original) =>
      ps(
        "$ErrorActionPreference='Stop'; $v=[Console]::In.ReadToEnd() | ConvertFrom-Json; Set-Acl -LiteralPath $v.temporary -AclObject (Get-Acl -LiteralPath $v.original)",
        JSON.stringify({ temporary, original }),
      ),
    publicAccess: async (temporary, original) =>
      ps(
        "$ErrorActionPreference='Stop'; $v=[Console]::In.ReadToEnd() | ConvertFrom-Json; if(Test-Path -LiteralPath $v.original) { Set-Acl -LiteralPath $v.temporary -AclObject (Get-Acl -LiteralPath $v.original) } else { $a=Get-Acl -LiteralPath $v.temporary; $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Read','Allow')); Set-Acl -LiteralPath $v.temporary -AclObject $a }",
        JSON.stringify({ temporary, original }),
      ),
  };
}
