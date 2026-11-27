import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, rename, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repair } from '../installer/repair-engine.mjs';
import { inventory, buildId, programParts } from '../installer/release.mjs';
import { prepareUninstall } from '../installer/uninstall-state.mjs';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'MetaExam-install-repair-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('MetaExam-install-repair-'));
    await rm(root, { recursive: true, force: true });
  });
  const app = path.join(root, 'app'),
    data = path.join(root, 'data'),
    source = path.join(root, 'source');
  for (const directory of [app, data, source]) await mkdir(directory);
  for (const part of [...programParts, 'runtime', 'postgres', 'vendor']) {
    await mkdir(path.join(app, part));
    await writeFile(path.join(app, part, 'content'), part + '-old');
  }
  await writeFile(path.join(app, 'public-keys.json'), 'existing customer keys');
  const makeRelease = async (directory, version) => {
    const r = {
      format: 1,
      product: 'MetaExam',
      arch: 'x64',
      postgresMajor: 18,
      version,
      minimumVersion: '0.1.0',
      schemaVersion: 1,
      migrations: [{ version: 1, checksum: 'a'.repeat(64) }],
      files: await inventory(directory),
    };
    r.buildId = buildId(r);
    await writeFile(path.join(directory, 'release.json'), JSON.stringify(r));
    return r;
  };
  await makeRelease(app, '0.1.7');
  await cp(app, source, { recursive: true });
  for (const part of programParts)
    await writeFile(path.join(source, part, 'content'), part + '-new');
  await writeFile(
    path.join(source, 'public-keys.json'),
    'new package keys must not replace old keys',
  );
  const release = await makeRelease(source, '0.1.10');
  for (const sub of ['secrets', 'postgres', 'runtime/files'])
    await mkdir(path.join(data, sub), { recursive: true });
  for (const name of [
    'config.json',
    'secrets/database.dpapi',
    'secrets/owner.dpapi',
    'postgres/PG_VERSION',
    'runtime/files/history.png',
  ])
    await writeFile(path.join(data, name), 'preserved:' + name);
  const record = { product: 'MetaExam', app, data, phase: 'configuring' };
  const marker = path.join(data, 'installation.json'),
    pending = path.join(data, 'upgrade-pending.json');
  await writeFile(marker, JSON.stringify(record));
  let starts = 0,
    stops = 0;
  const platform = {
    authorize: async () => {},
    validate: async () => {},
    secure: async () => {},
    programAccess: async () => {},
    pendingAccess: async () => {},
    stop: async () => {
      stops++;
    },
    configure: async () => {
      starts++;
      assert.equal((await json(pending)).phase, 'configuring');
      const state = await json(pending);
      assert.equal(
        await readFile(
          path.join(data, 'repairs', state.id, 'data-backup/postgres/PG_VERSION'),
          'utf8',
        ),
        'preserved:postgres/PG_VERSION',
      );
    },
    healthy: async () => {},
  };
  return {
    app,
    data,
    source,
    release,
    makeRelease,
    marker,
    record,
    pending,
    platform,
    starts: () => starts,
    stops: () => stops,
  };
}

async function removedInstallation(t) {
  const f = await fixture(t);
  await mkdir(path.join(f.data, 'postgres/data'));
  await writeFile(path.join(f.data, 'postgres/data/PG_VERSION'), '18');
  await writeFile(f.marker, JSON.stringify({ ...f.record, phase: 'installed' }));
  const complete = await prepareUninstall(f, f.platform);
  assert.equal(
    (await json(f.marker)).phase,
    'installed',
    'prepare does not claim services removed',
  );
  await complete();
  assert.equal((await json(f.marker)).phase, 'uninstalled');
  assert.equal(path.dirname(f.app), path.dirname(f.data));
  await rm(f.app, { recursive: true });
  return f;
}
test('repair rejects a runtime directory junction even when file hashes match', async (t) => {
  const f = await fixture(t);
  const runtime = path.join(f.app, 'runtime');
  const moved = path.join(path.dirname(f.app), 'linked-runtime');
  await rename(runtime, moved);
  await symlink(moved, runtime, 'junction');
  await assert.rejects(repair(f, f.platform), /UNSAFE_PATH/);
  assert.equal(f.stops(), 0);
});
test('uninstall refuses an outstanding maintenance operation and preserves the installation', async (t) => {
  const f = await fixture(t);
  await writeFile(f.pending, '{}');
  await assert.rejects(prepareUninstall(f, f.platform), /MAINTENANCE_REQUIRED/);
  assert.equal((await json(f.marker)).phase, 'configuring');
});
test('uninstall retains the existing firewall scope and is idempotent before file removal', async (t) => {
  const f = await fixture(t);
  const platform = { ...f.platform, firewallSubnet: async () => '192.168.5.0/24' };
  await (
    await prepareUninstall(f, platform)
  )();
  const record = await json(f.marker);
  assert.equal(record.reinstall.subnet, '192.168.5.0/24');
  await (
    await prepareUninstall(f, platform)
  )();
  assert.deepEqual(await json(f.marker), record);
});

test('uninstall then reinstall restores pinned programs and original trust without resetting data', async (t) => {
  const f = await removedInstallation(t);
  const result = await repair(f, f.platform);
  assert.equal((await json(f.marker)).phase, 'installed');
  assert.equal(
    await readFile(path.join(f.app, 'public-keys.json'), 'utf8'),
    'existing customer keys',
  );
  for (const part of ['runtime', 'postgres', 'vendor'])
    assert.equal(await readFile(path.join(f.app, part, 'content'), 'utf8'), part + '-old');
  assert.equal(await readFile(path.join(f.data, 'postgres/data/PG_VERSION'), 'utf8'), '18');
  assert.equal(
    await readFile(path.join(result.backup, 'data-backup/config.json'), 'utf8'),
    'preserved:config.json',
  );
});

for (const phase of [
  'switching',
  'switched-server',
  'switched-runtime',
  'configuring',
  'healthy',
]) {
  test('reinstall resumes the same package after ' + phase, async (t) => {
    const f = await removedInstallation(t);
    const fail = async (step) => {
      if (step === phase) throw new Error('INTERRUPTED');
    };
    const p = { ...f.platform, checkpoint: fail, healthy: async () => fail('healthy') };
    await assert.rejects(repair(f, p), /INTERRUPTED/);
    const result = await repair(f, f.platform);
    assert.equal(result.resumed, true);
    assert.equal((await json(f.marker)).phase, 'installed');
    assert.equal(
      await readFile(path.join(f.app, 'public-keys.json'), 'utf8'),
      'existing customer keys',
    );
  });
}

for (const defect of ['trust', 'runtime', 'database', 'downgrade', 'schema']) {
  test('reinstall rejects ' + defect + ' before service mutations', async (t) => {
    const f = await removedInstallation(t);
    const record = await json(f.marker);
    if (defect === 'trust')
      await writeFile(
        path.join(f.data, 'reinstall', record.reinstall.id, 'public-keys.json'),
        'tampered',
      );
    if (defect === 'database') await rm(path.join(f.data, 'postgres/data/PG_VERSION'));
    if (defect === 'runtime') {
      await writeFile(path.join(f.source, 'runtime/content'), 'different');
      await f.makeRelease(f.source, f.release.version);
    }
    if (defect === 'downgrade') await f.makeRelease(f.source, '0.1.1');
    if (defect === 'schema') {
      const r = await json(path.join(f.source, 'release.json'));
      r.migrations[0].checksum = 'b'.repeat(64);
      r.buildId = buildId(r);
      await writeFile(path.join(f.source, 'release.json'), JSON.stringify(r));
    }
    await assert.rejects(repair(f, f.platform));
    assert.equal(f.stops(), 0);
    assert.equal((await json(f.marker)).phase, 'uninstalled');
  });
}

test('repair preserves credentials, keys, database, attachments and previous programs', async (t) => {
  const f = await fixture(t);
  const result = await repair(f, f.platform);
  assert.equal(result.resumed, false);
  assert.equal(existsSync(f.pending), false);
  assert.equal((await json(f.marker)).phase, 'installed');
  for (const part of programParts) {
    assert.equal(await readFile(path.join(f.app, part, 'content'), 'utf8'), part + '-new');
    assert.equal(
      await readFile(path.join(result.backup, 'previous', part, 'content'), 'utf8'),
      part + '-old',
    );
  }
  for (const name of [
    'config.json',
    'secrets/database.dpapi',
    'secrets/owner.dpapi',
    'postgres/PG_VERSION',
    'runtime/files/history.png',
  ]) {
    assert.equal(await readFile(path.join(f.data, name), 'utf8'), 'preserved:' + name);
    assert.equal(
      await readFile(path.join(result.backup, 'data-backup', name), 'utf8'),
      'preserved:' + name,
    );
  }
  assert.equal(
    await readFile(path.join(f.app, 'public-keys.json'), 'utf8'),
    'existing customer keys',
  );
});

for (const phase of [
  'switching',
  ...programParts.map((p) => 'switched-' + p),
  'configuring',
  'completed',
  'healthy',
]) {
  test('resume same package after interruption: ' + phase, async (t) => {
    const f = await fixture(t);
    const injected = async (p) => {
      if (p === phase) throw new Error('INTERRUPTED');
    };
    f.platform.checkpoint = injected;
    if (phase === 'healthy') f.platform.healthy = () => injected('healthy');
    await assert.rejects(repair(f, f.platform), /INTERRUPTED/);
    assert.equal(existsSync(f.pending), true);
    f.platform.checkpoint = async () => {};
    f.platform.healthy = async () => {};
    assert.equal((await repair(f, f.platform)).resumed, true);
    assert.equal(existsSync(f.pending), false);
    assert.equal((await json(f.marker)).version, '0.1.10');
  });
}

for (const condition of [
  'installed',
  'foreign',
  'runtime',
  'schema',
  'candidate',
  'lock',
  'maintenance',
]) {
  test('reject before stopping services: ' + condition, async (t) => {
    const f = await fixture(t);
    if (condition === 'installed')
      await writeFile(f.marker, JSON.stringify({ ...f.record, phase: 'installed' }));
    if (condition === 'foreign')
      await writeFile(f.marker, JSON.stringify({ ...f.record, product: 'Other' }));
    if (condition === 'runtime')
      await writeFile(path.join(f.app, 'runtime/content'), 'different runtime');
    if (condition === 'schema') {
      const r = await json(path.join(f.app, 'release.json'));
      r.migrations[0].checksum = 'b'.repeat(64);
      r.buildId = buildId(r);
      await writeFile(path.join(f.app, 'release.json'), JSON.stringify(r));
    }
    if (condition === 'candidate')
      await writeFile(path.join(f.source, 'server/content'), 'tampered');
    if (condition === 'lock')
      await writeFile(
        path.join(f.data, 'install-repair.lock'),
        JSON.stringify({ pid: process.pid }),
      );
    if (condition === 'maintenance')
      await writeFile(path.join(f.data, 'runtime/maintenance.json'), '{}');
    await assert.rejects(repair(f, f.platform));
    assert.equal(f.stops(), 0);
    assert.equal(f.starts(), 0);
    assert.equal(await readFile(path.join(f.app, 'server/content'), 'utf8'), 'server-old');
  });
}

for (const change of ['package', 'backup', 'config', 'keys']) {
  test('reject changed resume state: ' + change, async (t) => {
    const f = await fixture(t);
    f.platform.checkpoint = async (p) => {
      if (p === 'switching') throw new Error('INTERRUPTED');
    };
    await assert.rejects(repair(f, f.platform), /INTERRUPTED/);
    f.platform.checkpoint = async () => {};
    if (change === 'package') await f.makeRelease(f.source, '0.1.11');
    if (change === 'backup') {
      const s = await json(f.pending);
      await writeFile(
        path.join(f.data, 'repairs', s.id, 'data-backup/postgres/PG_VERSION'),
        'tampered',
      );
    }
    if (change === 'config') await writeFile(path.join(f.data, 'config.json'), 'changed');
    if (change === 'keys') await writeFile(path.join(f.app, 'public-keys.json'), 'changed');
    await assert.rejects(
      repair(f, f.platform),
      /REPAIR_(SAME_PACKAGE_REQUIRED|BACKUP_INVALID|CONFIGURATION_CHANGED)/,
    );
    assert.equal(f.starts(), 0);
    assert.equal(existsSync(f.pending), true);
  });
}

test('health failure keeps the gate and stops services; only successful retry removes it', async (t) => {
  const f = await fixture(t);
  f.platform.healthy = async () => {
    throw new Error('NOT_READY');
  };
  await assert.rejects(repair(f, f.platform), /NOT_READY/);
  assert.equal(f.stops(), 2);
  assert.equal(existsSync(f.pending), true);
  assert.equal((await json(f.marker)).phase, 'configuring');
  f.platform.healthy = async () => {};
  await repair(f, f.platform);
  assert.equal(existsSync(f.pending), false);
});
