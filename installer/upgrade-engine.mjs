import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ordinary,
  readRelease,
  compareVersions,
  hashFile,
  programParts,
  inventory,
} from './release.mjs';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
async function atomic(file, value, access) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
  await access?.(temp);
  await rename(temp, file);
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function separate(a, b) {
  const relative = path.relative(path.resolve(a), path.resolve(b));
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}
async function matches(root, part, release) {
  const folder = path.join(root, part);
  if (!existsSync(folder)) return false;
  const actual = await inventory(folder);
  const expected = Object.fromEntries(
    Object.entries(release.files)
      .filter(([name]) => name.startsWith(part + '/'))
      .map(([name, hash]) => [name.slice(part.length + 1), hash]),
  );
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Platform operations are injected; tests use ordinary processes, never Windows services. */
export async function upgrade({ app, data, source }, platform) {
  app = path.resolve(app);
  data = path.resolve(data);
  source = path.resolve(source);
  await ordinary(app);
  await ordinary(data);
  await ordinary(source);
  if (path.parse(app).root.toLowerCase() !== path.parse(data).root.toLowerCase())
    throw new Error('UPGRADE_SAME_VOLUME_REQUIRED');
  if (
    !separate(app, data) ||
    !separate(data, app) ||
    !separate(app, source) ||
    !separate(source, app)
  )
    throw new Error('UPGRADE_UNSAFE_PATH');
  const installationFile = path.join(data, 'installation.json');
  await ordinary(installationFile);
  const installation = await json(installationFile);
  if (
    installation.product !== 'MetaExam' ||
    installation.phase !== 'installed' ||
    !same(installation.app, app) ||
    !same(installation.data, data)
  )
    throw new Error('UPGRADE_OWNERSHIP');
  const release = await readRelease(source);
  await platform.authorize();
  await platform.validateServices(app);
  try {
    await platform.database.lock();
  } catch (error) {
    await platform.database.close();
    throw error;
  }
  const pendingFile = path.join(data, 'upgrade-pending.json');
  const marker = path.join(data, 'runtime/maintenance.json');
  let state, work;
  let stopped = false;
  try {
    // Keep the exact existing Node/PostgreSQL/WinSW runtime in this release line.
    for (const [name, hash] of Object.entries(release.files)) {
      if (!name.startsWith('runtime/') && !name.startsWith('postgres/')) continue;
      await ordinary(path.join(app, name));
      if ((await hashFile(path.join(app, name))) !== hash)
        throw new Error('UPGRADE_RUNTIME_INCOMPATIBLE');
    }
    if (existsSync(pendingFile)) {
      await ordinary(pendingFile);
      state = await json(pendingFile);
      if (
        state.format !== 1 ||
        !/^[a-f0-9-]{36}$/.test(state.id) ||
        state.buildId !== release.buildId ||
        !same(state.app, app) ||
        !same(state.data, data)
      )
        throw new Error('UPGRADE_RESUME_PACKAGE_REQUIRED');
      work = path.join(data, 'upgrades', state.id);
      await ordinary(work);
      if (!['backup', 'switching', 'migrating', 'starting', 'completed'].includes(state.phase))
        throw new Error('UPGRADE_STATE_INVALID');
      state.resumed = true;
    } else {
      if (existsSync(marker)) throw new Error('MAINTENANCE_REQUIRED');
      if (compareVersions(release.version, installation.version) <= 0)
        throw new Error('UPGRADE_NOT_NEWER');
      if (compareVersions(installation.version, release.minimumVersion) < 0)
        throw new Error('UPGRADE_BASELINE_UNSUPPORTED');
      const baseline = await platform.baseline(app);
      if (baseline.version !== installation.version || baseline.backup !== true)
        throw new Error('UPGRADE_BASELINE_UNSUPPORTED');
      if (
        baseline.migrations.length > release.migrations.length ||
        baseline.migrations.some(
          (m, i) => m.checksum !== release.migrations[i]?.checksum || m.version !== i + 1,
        )
      )
        throw new Error('UPGRADE_MIGRATION_INCOMPATIBLE');
      await platform.database.inspect();
      const id = randomUUID();
      work = path.join(data, 'upgrades', id);
      await mkdir(path.join(data, 'upgrades'), { recursive: true });
      await ordinary(path.join(data, 'upgrades'));
      const required = (await platform.payloadSize(source)) * 3 + 256 * 1024 * 1024;
      for (const dir of [app, data]) {
        const space = await statfs(dir);
        if (space.bavail * space.bsize < required) throw new Error('UPGRADE_SPACE_REQUIRED');
      }
      await mkdir(work);
      await platform.secure(work);
      await cp(source, path.join(work, 'candidate'), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await readRelease(path.join(work, 'candidate'));
      await mkdir(path.join(work, 'previous'));
      state = {
        format: 1,
        id,
        app,
        data,
        buildId: release.buildId,
        oldVersion: installation.version,
        version: release.version,
        phase: 'backup',
        backup: null,
        createdAt: new Date().toISOString(),
      };
      await atomic(pendingFile, state, platform.pendingAccess);
    }
    const checkpoint = async (phase) => {
      state.phase = phase;
      await atomic(pendingFile, state, platform.pendingAccess);
      await platform.checkpoint?.(phase);
    };
    await readRelease(path.join(work, 'candidate'));
    await platform.stop();
    stopped = true;
    if (state.phase === 'backup') {
      state.backup = await platform.backup(app, path.join(work, 'backups'));
      await checkpoint('switching');
    }
    if (!state.backup || !/^[a-f0-9-]{36}$/.test(state.backup.id))
      throw new Error('UPGRADE_BACKUP_REQUIRED');
    await platform.validateBackup(app, work, state.backup.id);
    if (existsSync(marker)) {
      await ordinary(marker);
      const existing = await json(marker);
      if (existing.format !== 2 || existing.kind !== 'upgrade' || existing.id !== state.id)
        throw new Error('MAINTENANCE_REQUIRED');
    } else
      await writeFile(
        marker,
        JSON.stringify({ format: 2, kind: 'upgrade', id: state.id, buildId: release.buildId }),
        { flag: 'wx' },
      );
    await platform.database.enter();
    await platform.database.inspect();
    // Always finish interrupted component switches before touching the schema.
    for (const part of programParts) {
      const live = path.join(app, part),
        previous = path.join(work, 'previous', part);
      if (existsSync(previous) && (await matches(app, part, release))) continue;
      if (existsSync(live)) {
        await ordinary(live);
        if (existsSync(previous)) throw new Error('UPGRADE_PROGRAM_CHANGED');
        await rename(live, previous);
      }
      const incoming = path.join(app, '.upgrade-' + state.id + '-' + part);
      if (existsSync(incoming)) {
        // Never delete an interrupted staging tree; quarantine it and copy anew.
        await ordinary(incoming);
        await rename(incoming, path.join(work, 'incomplete-' + part + '-' + randomUUID()));
      }
      await cp(path.join(work, 'candidate', part), incoming, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await platform.programAccess(incoming);
      await rename(incoming, live);
      if (!(await matches(app, part, release))) throw new Error('UPGRADE_PROGRAM_CHANGED');
      await platform.checkpoint?.('switched-' + part);
    }
    await checkpoint('migrating');
    await platform.database.migrate();
    await checkpoint('starting');
    await platform.database.allowRuntime();
    await unlink(marker);
    const since = new Date().toISOString();
    await platform.start();
    await platform.healthy(release, since);
    await atomic(path.join(app, 'release.json'), release);
    await atomic(
      installationFile,
      {
        ...installation,
        version: release.version,
        buildId: release.buildId,
        upgradedAt: new Date().toISOString(),
      },
      platform.recordAccess,
    );
    delete state.errorCode;
    await checkpoint('completed');
    await atomic(path.join(work, 'result.json'), state);
    await unlink(pendingFile);
    return { version: release.version, backup: state.backup, resumed: !!state.resumed };
  } catch (error) {
    if (stopped && state && state.phase !== 'backup') {
      // Fail closed even if startup already accepted requests; never roll back data or binaries.
      if (!existsSync(marker))
        await writeFile(
          marker,
          JSON.stringify({ format: 2, kind: 'upgrade', id: state.id, buildId: release.buildId }),
          { flag: 'wx' },
        );
      await platform.stop().catch(() => {});
      state.errorCode =
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'UPGRADE_FAILED';
      await atomic(pendingFile, state, platform.pendingAccess);
    }
    throw error;
  } finally {
    await platform.database.close();
  }
}
