import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { ordinary, readRelease, hashFile } from './release.mjs';

// Public trust is installation-specific; never replace it with the new package's keys.
export async function prepareUninstall({ app, data }, platform) {
  await platform.authorize();
  for (const p of [app, data, path.join(data, 'installation.json')]) await ordinary(p);
  const record = JSON.parse(await readFile(path.join(data, 'installation.json'), 'utf8'));
  if (
    record.product !== 'MetaExam' ||
    record.app !== app ||
    record.data !== data ||
    !['installed', 'configuring', 'uninstalled'].includes(record.phase)
  )
    throw new Error('UNINSTALL_OWNERSHIP');
  if (
    existsSync(path.join(data, 'upgrade-pending.json')) ||
    existsSync(path.join(data, 'runtime/maintenance.json'))
  )
    throw new Error('MAINTENANCE_REQUIRED');
  if (record.phase === 'uninstalled') {
    await readUninstallSnapshot(data, record);
    return async () => {};
  }
  const release = await readRelease(app, false);
  const id = randomUUID();
  const parent = path.join(data, 'reinstall');
  await mkdir(parent, { recursive: true });
  await ordinary(parent);
  const directory = path.join(parent, id);
  await mkdir(directory);
  await platform.secure(directory);
  const trustHash = await hashFile(path.join(app, 'public-keys.json'));
  await copyFile(path.join(app, 'public-keys.json'), path.join(directory, 'public-keys.json'));
  if ((await hashFile(path.join(directory, 'public-keys.json'))) !== trustHash)
    throw new Error('UNINSTALL_TRUST_CHANGED');
  await writeFile(path.join(directory, 'release.json'), JSON.stringify(release), { flag: 'wx' });
  const subnet = await platform.firewallSubnet?.();
  return async () => {
    const temporary = path.join(data, 'installation.' + id + '.tmp');
    await writeFile(
      temporary,
      JSON.stringify(
        {
          ...record,
          phase: 'uninstalled',
          previousPhase: record.phase,
          version: release.version,
          buildId: release.buildId,
          reinstall: { id, trustHash, subnet },
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    await rename(temporary, path.join(data, 'installation.json'));
  };
}

export async function readUninstallSnapshot(data, record) {
  if (
    !/^[a-f0-9-]{36}$/.test(record.reinstall?.id ?? '') ||
    !/^[a-f0-9]{64}$/.test(record.reinstall?.trustHash ?? '')
  )
    throw new Error('REINSTALL_RECORD_REQUIRED');
  const directory = path.join(data, 'reinstall', record.reinstall.id);
  const release = await readRelease(directory, false);
  if (
    release.buildId !== record.buildId ||
    release.version !== record.version ||
    (await hashFile(path.join(directory, 'public-keys.json'))) !== record.reinstall.trustHash
  )
    throw new Error('REINSTALL_SNAPSHOT_CHANGED');
  if (
    record.previousPhase === 'installed' &&
    !existsSync(path.join(data, 'postgres/data/PG_VERSION'))
  )
    throw new Error('DATABASE_MISSING_REQUIRES_RECOVERY');
  return { directory, release };
}
