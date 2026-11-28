import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { get as httpsGet } from 'node:https';
import { temporaryTls } from './tls-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { licenseManagerFixture } from './license-manager-fixture.mts';
import { migrateHttpNetwork, backupConfiguration } from '../installer/http-network.mjs';
import { upgrade } from '../installer/upgrade-engine.mjs';
import { readRelease, compareVersions } from '../installer/release.mjs';

const source = path.resolve('artifacts/payload');
const baseline = path.resolve(
  process.env.METAEXAM_UPGRADE_BASELINE ?? 'artifacts/upgrade-baseline',
);
assert.ok(
  existsSync(path.join(baseline, 'server/db.cjs')),
  'Provide an original, older backup-capable payload via METAEXAM_UPGRADE_BASELINE',
);
const require = createRequire(import.meta.url);
const old = require(path.join(baseline, 'server/db.cjs'));
const next = require(path.join(source, 'server/db.cjs'));
assert.equal(typeof old.BackupService, 'function');
const release = await readRelease(source);
assert.equal(next.APP_VERSION, release.version);
assert.ok(compareVersions(old.APP_VERSION, release.version) < 0);
if (existsSync(path.join(baseline, 'release.json'))) {
  const prior = await readRelease(baseline);
  assert.equal(prior.version, old.APP_VERSION);
}
const t = await licenseManagerFixture();
const root = await mkdtemp(path.join(tmpdir(), 'MetaExam-upgrade-package-'));
const app = path.join(root, 'app'),
  data = path.join(root, 'data');
const home = path.join(data, 'runtime');
let children = [];
async function cleanup() {
  if (
    path.dirname(root) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('MetaExam-upgrade-package-')
  )
    throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
}
async function stop() {
  await Promise.all(
    children.map(async (p) => {
      if (p.exitCode !== null || p.signalCode !== null) return;
      const exit = new Promise((resolve) => p.once('exit', resolve));
      p.kill();
      await exit;
    }),
  );
  children = [];
}
async function wait(fn) {
  for (let i = 0; i < 100; i++) {
    try {
      if (await fn()) return;
    } catch {
      /* bounded startup wait */
    }
    await delay(100);
  }
  throw new Error('UPGRADE_TEST_TIMEOUT');
}
try {
  await cp(baseline, app, { recursive: true });
  await mkdir(home, { recursive: true });
  await cp(t.config.home, home, { recursive: true });
  await cp(t.config.trustFile, path.join(app, 'public-keys.json'));
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      server.close(() => resolve(p));
    });
  });
  const tls = process.env.METAEXAM_UPGRADE_HTTPS === '1' ? await temporaryTls(data) : undefined;
  const config = {
    ...t.config,
    home,
    trustFile: path.join(app, 'public-keys.json'),
    production: !!tls,
    api: {
      ...t.config.api,
      port,
      webDir: path.join(app, 'web'),
      ...(tls ? { host: '0.0.0.0', tlsCert: tls.tlsCert, tlsKey: tls.tlsKey } : {}),
    },
  };
  const conf = path.join(data, 'config.json');
  await writeFile(conf, JSON.stringify(config));
  const savedConfig = await readFile(conf, 'utf8'),
    savedKeys = await readFile(config.trustFile, 'utf8');
  await writeFile(
    path.join(data, 'installation.json'),
    JSON.stringify({
      product: 'MetaExam',
      app,
      data,
      phase: 'installed',
      version: old.APP_VERSION,
    }),
  );
  await t.db.pool.end();
  const seed = next.createDatabase(config);
  await next.importLicense(seed, t.issue(7));
  await seed.pool.query(
    "INSERT INTO courses(id,code,name) VALUES($1,'upgrade-course','升级保留课程')",
    [randomUUID()],
  );
  await seed.pool.end();
  const url = 'http://127.0.0.1:' + port;
  function start() {
    for (const script of ['api.cjs', 'worker.cjs']) {
      const child = spawn(path.join(app, 'runtime/node.exe'), [path.join(app, 'server', script)], {
        cwd: app,
        env: { ...process.env, METAEXAM_CONFIG: conf },
        windowsHide: true,
        stdio: 'ignore',
      });
      children.push(child);
    }
  }
  start();
  await wait(async () => {
    if (!tls) return (await (await fetch(url + '/health/live')).json()).version === old.APP_VERSION;
    const version = await new Promise((resolve, reject) => {
      const request = httpsGet(
        'https://127.0.0.1:' + port + '/health/live',
        { ca: tls.ca, timeout: 3000 },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (part) => {
            body += part;
          });
          response.on('end', () => {
            try {
              resolve(JSON.parse(body).version);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('TLS_TIMEOUT')));
    });
    return version === old.APP_VERSION;
  });
  await stop();
  const queued = next.createDatabase(config);
  const { id: job } = await next.enqueue(
    queued,
    'upgrade-pending-test',
    'held until upgrade completes',
  );
  await queued.pool.end();
  const backup = new old.BackupService(config, {
    bin: path.join(app, 'postgres/bin'),
    key: randomBytes(32),
    runtimeRole: config.database.user,
    secureDirectory: async () => {},
  });
  let failStartup = true,
    backupCount = 0;
  const platform = () => {
    const database = new next.UpgradeDatabase(config, config.database.user);
    return {
      database,
      authorize: async () => {},
      validateServices: async () => {},
      baseline: async () => ({
        version: old.APP_VERSION,
        backup: true,
        migrations: old.MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })),
      }),
      payloadSize: async () => 600 * 1024 * 1024,
      secure: async () => {},
      programAccess: async () => {},
      stop,
      backup: async (_app, folder) => {
        backupCount++;
        await mkdir(folder);
        return backup.create(folder);
      },
      validateBackup: async (_app, work, id) => {
        const original = await backupConfiguration(data, work);
        assert.equal(await readFile(original, 'utf8'), savedConfig);
        const previous = process.env.METAEXAM_CONFIG;
        try {
          process.env.METAEXAM_CONFIG = original;
          old.loadConfig();
        } finally {
          if (previous === undefined) delete process.env.METAEXAM_CONFIG;
          else process.env.METAEXAM_CONFIG = previous;
        }
        await backup.preview(path.join(work, 'backups', 'MetaExam-' + id + '.mbackup'));
      },
      configureNetwork: async (work) =>
        migrateHttpNetwork({ data, work }, { configureFirewall: async () => {} }),
      start: async () => start(),
      healthy: async (_release, since) => {
        await wait(
          async () =>
            (await (await fetch(url + '/health/live')).json()).version === release.version,
        );
        assert.equal((await fetch(url + '/health/ready')).status, 200);
        await wait(() => database.workerReady(since));
        const blocked = await fetch(url + '/api/v1/setup/status');
        assert.equal(blocked.status, 503);
        assert.equal((await blocked.json()).code, 'UPGRADE_IN_PROGRESS');
        const db = next.createDatabase(config);
        try {
          await delay(700);
          assert.equal(
            (await db.pool.query('SELECT status FROM jobs WHERE id=$1', [job])).rows[0].status,
            'pending',
          );
        } finally {
          await db.pool.end();
        }
        if (failStartup) throw new Error('INJECTED_START_FAILURE');
      },
    };
  };
  await assert.rejects(upgrade({ app, data, source }, platform()), /INJECTED_START_FAILURE/);
  assert.equal(children.length, 0);
  assert.ok(existsSync(path.join(home, 'maintenance.json')));
  assert.ok(existsSync(path.join(data, 'upgrade-pending.json')));
  failStartup = false;
  const result = await upgrade({ app, data, source }, platform());
  assert.equal(result.version, release.version);
  assert.equal(result.resumed, true);
  assert.equal(backupCount, 1);
  assert.equal((await fetch(url + '/api/v1/setup/status')).status, 200);
  const verified = next.createDatabase(config);
  try {
    await wait(
      async () =>
        (await verified.pool.query('SELECT status FROM jobs WHERE id=$1', [job])).rows[0].status ===
        'completed',
    );
    assert.equal(
      (await verified.pool.query("SELECT name FROM courses WHERE code='upgrade-course'")).rows[0]
        .name,
      '升级保留课程',
    );
    assert.equal((await next.licenseStatus(verified)).state, 'valid');
  } finally {
    await verified.pool.end();
  }
  const converted = JSON.parse(await readFile(conf, 'utf8'));
  const expectedApi = { ...config.api, host: '0.0.0.0' };
  delete expectedApi.tlsCert;
  delete expectedApi.tlsKey;
  assert.deepEqual(converted, {
    ...JSON.parse(savedConfig),
    api: expectedApi,
    production: true,
    firewallSubnet: 'LocalSubnet',
  });
  assert.equal(await readFile(config.trustFile, 'utf8'), savedKeys);
  await assert.rejects(upgrade({ app, data, source }, platform()), /UPGRADE_NOT_NEWER/);
  if (existsSync(path.join(baseline, 'release.json')))
    await assert.rejects(upgrade({ app, data, source: baseline }, platform()), /UPGRADE_NOT_NEWER/);
  console.log(
    `PASS real ${old.APP_VERSION} ${tls ? 'HTTPS' : 'local HTTP'} → ${release.version} LAN HTTP payload upgrade, pg_dump backup, startup failure/resume, API/Worker maintenance gating, preserved course/license/config/keys`,
  );
} finally {
  await stop();
  await t.close();
  await cleanup();
}
