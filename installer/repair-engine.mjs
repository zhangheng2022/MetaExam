import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { lockInstallation } from './operation-lock.mjs';
import { readUninstallSnapshot } from './uninstall-state.mjs';
import {
  ordinary,
  readRelease,
  hashFile,
  inventory,
  programParts,
  compareVersions,
} from './release.mjs';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const same = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const separate = (a, b) => {
  const relative = path.relative(a, b);
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
};
async function atomic(file, value, access) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
  await access?.(temporary);
  await rename(temporary, file);
}
async function matches(root, part, release) {
  if (!existsSync(path.join(root, part))) return false;
  const expected = Object.fromEntries(
    Object.entries(release.files)
      .filter(([name]) => name.startsWith(part + '/'))
      .map(([name, hash]) => [name.slice(part.length + 1), hash]),
  );
  return JSON.stringify(await inventory(path.join(root, part))) === JSON.stringify(expected);
}
const excluded = (name) =>
  name === 'repairs' || name === 'upgrade-pending.json' || name.startsWith('install-repair.lock');
async function dataFiles(data) {
  const files = {};
  for (const entry of await readdir(data, { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const file = path.join(data, entry.name);
    await ordinary(file);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(await inventory(file)))
        files[entry.name + '/' + name] = hash;
    } else files[entry.name] = await hashFile(file);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

/** Repair only an owned, incomplete installation; platform effects remain injectable. */
export async function repair({ app, data, source }, platform) {
  [app, data, source] = [app, data, source].map((p) => path.resolve(p));
  await platform.authorize();
  for (const directory of [data, source]) await ordinary(directory);
  if (
    !separate(app, data) ||
    !separate(data, app) ||
    !separate(app, source) ||
    !separate(source, app)
  )
    throw new Error('REPAIR_UNSAFE_PATH');
  if (!separate(data, source) || !separate(source, data)) throw new Error('REPAIR_UNSAFE_PATH');
  if (path.parse(app).root.toLowerCase() !== path.parse(data).root.toLowerCase())
    throw new Error('REPAIR_SAME_VOLUME_REQUIRED');
  const release = await readRelease(source);
  const recordFile = path.join(data, 'installation.json');
  await ordinary(recordFile);
  const record = await json(recordFile);
  if (record.product !== 'MetaExam' || !same(record.app, app) || !same(record.data, data))
    throw new Error('REPAIR_OWNERSHIP');
  const pending = path.join(data, 'upgrade-pending.json');
  const reinstalling = record.phase === 'uninstalled';
  const snapshot = reinstalling ? await readUninstallSnapshot(data, record) : undefined;
  if (reinstalling && !existsSync(app)) {
    await ordinary(path.dirname(app));
    await mkdir(app);
  }
  await ordinary(app);
  const trustRoot = snapshot?.directory ?? app;
  if (!['configuring', 'uninstalled'].includes(record.phase) && !existsSync(pending))
    throw new Error('REPAIR_NOT_INCOMPLETE');
  if (existsSync(path.join(data, 'runtime/maintenance.json')))
    throw new Error('MAINTENANCE_REQUIRED');
  await platform.validate();
  const unlock = await lockInstallation(data);
  let state,
    work,
    stopped = false;
  try {
    if (existsSync(pending)) {
      await ordinary(pending);
      state = await json(pending);
      if (
        state.kind !== 'install-repair' ||
        state.format !== 1 ||
        !/^[a-f0-9-]{36}$/.test(state.id) ||
        state.buildId !== release.buildId ||
        !same(state.app, app) ||
        !same(state.data, data)
      )
        throw new Error('REPAIR_SAME_PACKAGE_REQUIRED');
      work = path.join(data, 'repairs', state.id);
      await ordinary(work);
      if (!['backup', 'switching', 'configuring', 'completed'].includes(state.phase))
        throw new Error('REPAIR_STATE_INVALID');
      state.resumed = true;
    } else {
      const old = snapshot?.release ?? (await readRelease(app, false));
      if (
        !['configuring', 'uninstalled'].includes(record.phase) ||
        compareVersions(release.version, old.version) < 0
      )
        throw new Error('REPAIR_NOT_INCOMPLETE');
      if (JSON.stringify(old.migrations) !== JSON.stringify(release.migrations))
        throw new Error('REPAIR_SCHEMA_MISMATCH');
      // No runtime replacement or database downgrade during incomplete-install repair.
      for (const [name, hash] of Object.entries(release.files)) {
        if (!/^(runtime|postgres|vendor)\//.test(name)) continue;
        if (!reinstalling) await ordinary(path.join(app, name));
        if (
          reinstalling ? old.files[name] !== hash : (await hashFile(path.join(app, name))) !== hash
        )
          throw new Error('REPAIR_RUNTIME_MISMATCH');
      }
      const preserve = ['config.json', 'secrets/database.dpapi', 'secrets/owner.dpapi'];
      const preserved = {};
      for (const name of preserve) preserved[name] = await hashFile(path.join(data, name));
      preserved['public-keys.json'] = await hashFile(path.join(trustRoot, 'public-keys.json'));
      let required = 256 * 1024 * 1024;
      for (const name of Object.keys(release.files))
        required += (await stat(path.join(source, name))).size * 3;
      const space = await statfs(data);
      if (space.bavail * space.bsize < required) throw new Error('REPAIR_SPACE_REQUIRED');
      const id = randomUUID();
      await mkdir(path.join(data, 'repairs'), { recursive: true });
      await ordinary(path.join(data, 'repairs'));
      work = path.join(data, 'repairs', id);
      await mkdir(work);
      await platform.secure(work);
      await cp(source, path.join(work, 'candidate'), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await readRelease(path.join(work, 'candidate'));
      await mkdir(path.join(work, 'previous'));
      await writeFile(path.join(work, 'previous/release.json'), JSON.stringify(old));
      state = {
        format: 1,
        kind: 'install-repair',
        id,
        app,
        data,
        buildId: release.buildId,
        version: release.version,
        phase: 'backup',
        preserved,
        createdAt: new Date().toISOString(),
      };
      await atomic(pending, state, platform.pendingAccess);
    }
    const checkpoint = async (phase) => {
      state.phase = phase;
      await atomic(pending, state, platform.pendingAccess);
      await platform.checkpoint?.(phase);
    };
    await readRelease(path.join(work, 'candidate'));
    for (const [name, hash] of Object.entries(state.preserved)) {
      if (
        (await hashFile(path.join(name === 'public-keys.json' ? trustRoot : data, name))) !== hash
      )
        throw new Error('REPAIR_CONFIGURATION_CHANGED');
    }
    stopped = true;
    await platform.stop();
    if (state.phase === 'backup') {
      const backup = path.join(work, 'data-backup');
      if (existsSync(backup)) {
        await ordinary(backup);
        await rename(backup, path.join(work, 'incomplete-backup-' + randomUUID()));
      }
      await mkdir(backup);
      const before = await dataFiles(data);
      let size = 256 * 1024 * 1024;
      for (const name of Object.keys(before)) size += (await stat(path.join(data, name))).size;
      const space = await statfs(data);
      if (space.bavail * space.bsize < size) throw new Error('REPAIR_SPACE_REQUIRED');
      for (const entry of await readdir(data)) {
        if (!excluded(entry))
          await cp(path.join(data, entry), path.join(backup, entry), {
            recursive: true,
            force: false,
            errorOnExist: true,
          });
      }
      const actual = await inventory(backup);
      if (
        JSON.stringify(before) !== JSON.stringify(actual) ||
        JSON.stringify(before) !== JSON.stringify(await dataFiles(data))
      )
        throw new Error('REPAIR_BACKUP_CHANGED');
      state.backupFiles = before;
      await checkpoint('switching');
    }
    if (
      !state.backupFiles ||
      JSON.stringify(await inventory(path.join(work, 'data-backup'))) !==
        JSON.stringify(state.backupFiles)
    )
      throw new Error('REPAIR_BACKUP_INVALID');
    // A removed installation reconstructs only the pinned runtime; data stays in place.
    if (reinstalling) {
      const trust = path.join(app, 'public-keys.json');
      if (existsSync(trust) && (await hashFile(trust)) !== state.preserved['public-keys.json'])
        throw new Error('REPAIR_CONFIGURATION_CHANGED');
      if (!existsSync(trust))
        await cp(path.join(trustRoot, 'public-keys.json'), trust, {
          errorOnExist: true,
          force: false,
        });
    }
    for (const part of [
      ...programParts,
      ...(reinstalling ? ['runtime', 'postgres', 'vendor'] : []),
    ]) {
      const live = path.join(app, part),
        previous = path.join(work, 'previous', part);
      if (existsSync(previous) && (await matches(app, part, release))) continue;
      if (existsSync(live)) {
        await ordinary(live);
        if (existsSync(previous)) throw new Error('REPAIR_PROGRAM_CHANGED');
        await rename(live, previous);
      }
      const incoming = path.join(app, '.repair-' + state.id + '-' + part);
      if (existsSync(incoming)) {
        await ordinary(incoming);
        await rename(incoming, path.join(work, 'incomplete-' + part + '-' + randomUUID()));
      }
      await cp(path.join(work, 'candidate', part), incoming, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await platform.programAccess(incoming);
      await rename(incoming, live);
      if (!(await matches(app, part, release))) throw new Error('REPAIR_PROGRAM_CHANGED');
      await platform.checkpoint?.('switched-' + part);
    }
    await atomic(path.join(app, 'release.json'), release);
    await checkpoint('configuring');
    const since = new Date().toISOString();
    await platform.configure();
    await platform.healthy(release, since);
    for (const [name, hash] of Object.entries(state.preserved)) {
      const file = path.join(name === 'public-keys.json' ? app : data, name);
      if ((await hashFile(file)) !== hash) throw new Error('REPAIR_CONFIGURATION_CHANGED');
    }
    await atomic(
      recordFile,
      {
        ...record,
        phase: 'installed',
        version: release.version,
        buildId: release.buildId,
        repairedAt: new Date().toISOString(),
      },
      platform.recordAccess,
    );
    await checkpoint('completed');
    await atomic(path.join(work, 'result.json'), state);
    await unlink(pending);
    return { version: release.version, resumed: !!state.resumed, backup: work };
  } catch (error) {
    if (stopped) await platform.stop().catch(() => {});
    throw error;
  } finally {
    await unlock();
  }
}
