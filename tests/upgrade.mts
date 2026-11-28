import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateHttpNetwork } from '../installer/http-network.mjs';
import { upgrade } from '../installer/upgrade-engine.mjs';
import { inventory, buildId, readRelease, programParts } from '../installer/release.mjs';
import { isolatedDatabase } from './database-fixture.mts';
import {
  migrate,
  ensureInstance,
  createDatabase,
  UpgradeDatabase,
  MIGRATIONS,
  SCHEMA_VERSION,
} from '../packages/db/dist/index.js';

async function fixture() {
  const t = await isolatedDatabase();
  const root = await mkdtemp(path.join(tmpdir(), 'MetaExam-upgrade-test-'));
  const app = path.join(root, 'app'),
    data = path.join(root, 'data'),
    source = path.join(root, 'source');
  const home = path.join(data, 'runtime');
  await mkdir(home, { recursive: true });
  for (const dir of [app, source])
    for (const part of [...programParts, 'runtime', 'postgres']) {
      await mkdir(path.join(dir, part), { recursive: true });
      await writeFile(
        path.join(dir, part, 'file.txt'),
        ['runtime', 'postgres'].includes(part) ? 'pinned-runtime' : dir === app ? 'old' : 'new',
      );
    }
  await writeFile(path.join(app, 'public-keys.json'), 'preserve-trusted-keys');
  await writeFile(path.join(data, 'config.json'), 'preserve-machine-credentials');
  await writeFile(
    path.join(data, 'installation.json'),
    JSON.stringify({ product: 'MetaExam', app, data, phase: 'installed', version: '0.1.0' }),
  );
  const release = {
    format: 1,
    product: 'MetaExam',
    version: '0.1.1',
    minimumVersion: '0.1.0',
    arch: 'x64',
    postgresMajor: 18,
    schemaVersion: SCHEMA_VERSION,
    migrations: MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })),
    files: await inventory(source),
  };
  await writeFile(
    path.join(source, 'release.json'),
    JSON.stringify({ ...release, buildId: buildId(release) }),
  );
  await migrate(t.db);
  await ensureInstance(t.db);
  await t.db.pool.query("INSERT INTO courses(id,code,name) VALUES($1,'upgrade-test','保留课程')", [
    randomUUID(),
  ]);
  await t.db.pool.end();
  const config = { ...t.config, home };
  let stopped = false,
    fault = '',
    backupFailure = false,
    healthFailure = false;
  const events: string[] = [];
  const platform = () => {
    const database = new UpgradeDatabase(config, config.database.user);
    return {
      database,
      authorize: async () => {},
      validateServices: async () => {},
      baseline: async () => ({ version: '0.1.0', backup: true, migrations: release.migrations }),
      payloadSize: async () => 1024,
      secure: async () => {},
      programAccess: async () => {},
      pendingAccess: async (file: string) => {
        assert.ok(file.endsWith('.tmp'), 'apply access before publishing the atomic replacement');
        assert.equal(JSON.parse(await readFile(file, 'utf8')).format, 1);
        events.push('pending-access');
      },
      stop: async () => {
        stopped = true;
        events.push('stop');
      },
      backup: async () => {
        events.push('backup');
        if (backupFailure) throw new Error('BACKUP_FAILED');
        return { id: randomUUID() };
      },
      validateBackup: async () => {
        events.push('backup-verified');
      },
      restartDatabase: async () => {
        assert.ok(existsSync(path.join(home, 'maintenance.json')));
        assert.ok(existsSync(path.join(data, 'upgrade-pending.json')));
        events.push('database-restart');
        if (fault === 'database-restart') throw new Error('INJECTED_FAILURE');
      },
      start: async () => {
        assert.ok(!existsSync(path.join(home, 'maintenance.json')));
        assert.ok(existsSync(path.join(data, 'upgrade-pending.json')));
        stopped = false;
        events.push('start');
      },
      healthy: async () => {
        if (healthFailure) throw new Error('UPGRADE_START_FAILED');
        events.push('healthy');
      },
      checkpoint: async (step: string) => {
        events.push(step);
        if (step === fault) throw new Error('INJECTED_FAILURE');
      },
    };
  };
  return {
    app,
    data,
    source,
    home,
    events,
    platform,
    config,
    fault: (value: string) => {
      fault = value;
    },
    backupFailure: () => {
      backupFailure = true;
    },
    healthFailure: (value: boolean) => {
      healthFailure = value;
    },
    stopped: () => stopped,
    close: async () => {
      await t.close();
      if (
        path.dirname(root) !== path.resolve(tmpdir()) ||
        !path.basename(root).startsWith('MetaExam-upgrade-test-')
      )
        throw new Error('Unsafe cleanup');
      await rm(root, { recursive: true, force: true });
    },
  };
}
for (const fault of ['switched-server', 'migrating', 'starting', 'database-restart', 'completed']) {
  const t = await fixture();
  try {
    t.fault(fault);
    await assert.rejects(upgrade(t, t.platform()), /INJECTED_FAILURE/);
    assert.ok(t.stopped());
    assert.ok(existsSync(path.join(t.home, 'maintenance.json')));
    const rejected = createDatabase(t.config);
    try {
      await assert.rejects(rejected.pool.query('SELECT 1'), /MAINTENANCE_REQUIRED/);
    } finally {
      await rejected.pool.end();
    }
    t.fault('');
    assert.equal((await upgrade(t, t.platform())).version, '0.1.1');
    assert.ok(!existsSync(path.join(t.data, 'upgrade-pending.json')));
    assert.ok(!existsSync(path.join(t.home, 'maintenance.json')));
    assert.equal(await readFile(path.join(t.app, 'server/file.txt'), 'utf8'), 'new');
    assert.equal(
      await readFile(path.join(t.app, 'public-keys.json'), 'utf8'),
      'preserve-trusted-keys',
    );
    assert.equal(
      await readFile(path.join(t.data, 'config.json'), 'utf8'),
      'preserve-machine-credentials',
    );
    const db = createDatabase(t.config);
    try {
      assert.equal((await db.pool.query('SELECT name FROM courses')).rows[0].name, '保留课程');
    } finally {
      await db.pool.end();
    }
    await assert.rejects(upgrade(t, t.platform()), /UPGRADE_NOT_NEWER/);
  } finally {
    await t.close();
  }
}
console.log(
  'PASS interrupted file switch/migration/start/finalization fail closed and resume without data rollback',
);
{
  const t = await fixture();
  const platform = t.platform();
  try {
    platform.restartDatabase = async () => {
      await platform.database.close();
      platform.database = new UpgradeDatabase(t.config, t.config.database.user);
      assert.ok(existsSync(path.join(t.home, 'maintenance.json')));
      const competing = t.platform();
      try {
        await assert.rejects(upgrade(t, competing), /REPAIR_ALREADY_RUNNING/);
      } finally {
        await competing.database.close();
      }
      const runtime = createDatabase(t.config);
      try {
        await assert.rejects(runtime.pool.query('SELECT 1'), /MAINTENANCE_REQUIRED/);
      } finally {
        await runtime.pool.end();
      }
      await platform.database.lock();
      await platform.database.enter();
      await platform.database.allowRuntime();
    };
    await upgrade(t, platform);
    assert.ok(!existsSync(path.join(t.home, 'maintenance.json')));
    console.log(
      'PASS durable maintenance gate and file lock survive loss and reacquisition of DB session locks',
    );
  } finally {
    await t.close();
  }
}
for (const kind of ['tamper', 'runtime', 'backup', 'health', 'wrong-package']) {
  const t = await fixture();
  try {
    if (kind === 'tamper') {
      await writeFile(path.join(t.source, 'server/file.txt'), 'tampered');
      await assert.rejects(upgrade(t, t.platform()), /UPGRADE_PAYLOAD_CHANGED/);
      assert.ok(!t.stopped());
    } else if (kind === 'runtime') {
      await writeFile(path.join(t.app, 'runtime/file.txt'), 'different');
      await assert.rejects(upgrade(t, t.platform()), /UPGRADE_RUNTIME_INCOMPATIBLE/);
      assert.ok(!t.stopped());
    } else if (kind === 'backup') {
      t.backupFailure();
      await assert.rejects(upgrade(t, t.platform()), /BACKUP_FAILED/);
      assert.equal(await readFile(path.join(t.app, 'server/file.txt'), 'utf8'), 'old');
    } else if (kind === 'health') {
      t.healthFailure(true);
      await assert.rejects(upgrade(t, t.platform()), /UPGRADE_START_FAILED/);
      assert.ok(t.stopped());
      t.healthFailure(false);
      await upgrade(t, t.platform());
    } else {
      t.fault('migrating');
      await assert.rejects(upgrade(t, t.platform()), /INJECTED_FAILURE/);
      const release = await readRelease(t.source);
      release.version = '0.1.2';
      release.buildId = buildId(release);
      await writeFile(path.join(t.source, 'release.json'), JSON.stringify(release));
      await assert.rejects(upgrade(t, t.platform()), /UPGRADE_RESUME_PACKAGE_REQUIRED/);
    }
  } finally {
    await t.close();
  }
}
console.log(
  'PASS tamper, incompatible runtime, failed backup, startup failure and wrong resume package boundaries',
);

for (const kind of ['checksum', 'future', 'concurrent', 'migration-failure']) {
  const t = await fixture();
  try {
    if (kind === 'checksum' || kind === 'future') {
      const db = createDatabase(t.config);
      try {
        if (kind === 'checksum')
          await db.pool.query("UPDATE schema_migrations SET checksum='changed' WHERE version=1");
        else
          await db.pool.query(
            "INSERT INTO schema_migrations(version,checksum) VALUES(999,'future')",
          );
      } finally {
        await db.pool.end();
      }
      await assert.rejects(upgrade(t, t.platform()));
      assert.ok(!t.stopped());
      assert.ok(!existsSync(path.join(t.data, 'upgrade-pending.json')));
    } else if (kind === 'concurrent') {
      const first = t.platform();
      await first.database.lock();
      try {
        await assert.rejects(upgrade(t, t.platform()), /UPGRADE_BUSY/);
      } finally {
        await first.database.close();
      }
      assert.ok(!t.stopped());
    } else {
      const broken = t.platform();
      broken.database.migrate = async () => {
        throw new Error('INJECTED_MIGRATION_FAILURE');
      };
      await assert.rejects(upgrade(t, broken), /INJECTED_MIGRATION_FAILURE/);
      assert.ok(t.stopped());
      assert.ok(existsSync(path.join(t.home, 'maintenance.json')));
      assert.ok(!t.events.includes('start'));
      await upgrade(t, t.platform());
    }
  } finally {
    await t.close();
  }
}
console.log(
  'PASS checksum/future schema and concurrent upgrade refused before stop; migration failure remains offline and resumes',
);

for (const phase of ['http-prepared', 'http-config', 'http-public-config', 'http-firewall']) {
  const t = await fixture();
  try {
    const original = {
      api: { host: '0.0.0.0', port: 3000, tlsCert: 'old.crt', tlsKey: 'old.key' },
      production: true,
      database: { passwordDpapi: 'preserved' },
      firewallSubnet: '10.0.0.0/24',
    };
    await writeFile(path.join(t.data, 'config.json'), JSON.stringify(original));
    let interrupted = false;
    const platform = () => ({
      ...t.platform(),
      configureNetwork: async (work: string) => {
        assert.ok(t.stopped());
        assert.ok(existsSync(path.join(t.home, 'maintenance.json')));
        assert.ok(t.events.includes('backup-verified'));
        await migrateHttpNetwork(
          { data: t.data, work },
          {
            configureFirewall: async () => {},
            checkpoint: async (at: string) => {
              if (!interrupted && at === phase) {
                interrupted = true;
                throw new Error('NETWORK_INTERRUPTED');
              }
            },
          },
        );
      },
    });
    await assert.rejects(upgrade(t, platform()), /NETWORK_INTERRUPTED/);
    assert.ok(existsSync(path.join(t.data, 'upgrade-pending.json')));
    assert.ok(t.stopped());
    const result = await upgrade(t, platform());
    assert.equal(result.resumed, true);
    const current = JSON.parse(await readFile(path.join(t.data, 'config.json'), 'utf8'));
    assert.equal(current.api.tlsCert, undefined);
    assert.deepEqual(current.database, original.database);
    assert.equal(current.firewallSubnet, '10.0.0.0/24');
  } finally {
    await t.close();
  }
}
console.log(
  'PASS HTTP conversion interruptions retain maintenance gate and resume after verified backup',
);
