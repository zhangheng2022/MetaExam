import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createDatabase,
  migrate,
  licenseRequest,
  importLicense,
  licenseStatus,
} from '../packages/db/src';
const root = process.cwd(),
  configPath = path.resolve('.local/config.json'),
  config = JSON.parse(readFileSync(configPath, 'utf8'));
const db = createDatabase(config),
  port = 3300,
  url = 'http://127.0.0.1:' + port,
  children: ChildProcess[] = [];
const testConfig = path.resolve('.local/integration-config.json');
writeFileSync(testConfig, JSON.stringify({ ...config, api: { ...config.api, port } }));
function start(file: string, conf = testConfig) {
  const p = spawn(process.execPath, [file], {
    cwd: root,
    env: { ...process.env, METAEXAM_CONFIG: conf },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  p.stderr?.on('data', () => {});
  children.push(p);
  return p;
}
function stop(p: ChildProcess) {
  if (p.pid && p.exitCode === null)
    execFileSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
}
async function wait(fn: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* service boot */
    }
    await delay(150);
  }
  throw new Error('WAIT_TIMEOUT');
}
const results: string[] = [];
function pass(name: string) {
  results.push(name);
  console.log('PASS ' + name);
}
async function main() {
  let oldTrust = '';
  try {
    await migrate(db);
    await migrate(db);
    assert.equal(
      (await db.pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,
      1,
    );
    pass('repeat migrations are safe');
    let api = start('apps/api/dist/main.js');
    await wait(async () => (await fetch(url + '/health/ready')).status === 200);
    assert.equal(
      (
        await fetch(url + '/api/v1/diagnostics/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    pass('anonymous mutation rejected');
    const key = 'test-' + randomUUID(),
      headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.api.managementToken,
      };
    const enqueue = () =>
      fetch(url + '/api/v1/diagnostics/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify({ businessKey: key, message: 'restart-persistence' }),
      });
    const response = await enqueue();
    assert.equal(response.status, 202);
    const job = (await response.json()) as { id: string };
    assert.equal(((await (await enqueue()).json()) as { id: string }).id, job.id);
    pass('API enqueues idempotent persistent job');
    stop(api);
    api = start('apps/api/dist/main.js');
    await wait(async () => (await fetch(url + '/health/ready')).ok);
    assert.equal(
      (await db.pool.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0].status,
      'pending',
    );
    pass('queued job survives API restart');
    // Emulate a worker killed after claiming a job. A new process must reclaim the expired lease.
    await db.pool.query(
      "UPDATE jobs SET status='running',attempts=1,lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",
      [job.id, randomUUID()],
    );
    const worker = start('apps/worker/dist/main.js');
    await wait(
      async () =>
        (await db.pool.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0].status ===
        'completed',
    );
    const done = (await db.pool.query('SELECT * FROM jobs WHERE id=$1', [job.id])).rows[0];
    assert.equal(done.attempts, 2);
    assert.equal(done.result.echo, 'restart-persistence');
    pass('worker reclaims crashed job without duplicate result');
    const request = await licenseRequest(db),
      keys = generateKeyPairSync('ed25519');
    oldTrust = readFileSync(config.trustFile, 'utf8');
    const publicStore = JSON.stringify({
      'internal-test': keys.publicKey.export({ type: 'spki', format: 'pem' }),
    });
    writeFileSync(config.trustFile, publicStore);
    writeFileSync(path.resolve('.local/test-trust.json'), publicStore);
    const current = Number(
      (await db.pool.query('SELECT highest_sequence FROM license_state WHERE id=1')).rows[0]
        .highest_sequence,
    );
    const now = new Date(),
      startTime = new Date(now.getTime() - 60000).toISOString();
    const payload = {
      schemaVersion: 1,
      product: 'MetaExam',
      licenseId: 'INTERNAL-' + randomUUID(),
      customerId: 'INTERNAL-TEST',
      installationId: request.installationId,
      fingerprintVersion: 1,
      deviceHash: request.deviceHash,
      sequence: current + 1,
      issuedAt: startTime,
      notBefore: startTime,
      expiresAt: new Date(now.getTime() + 86400000).toISOString(),
      maxConcurrentAttempts: 300,
      features: ['exam.core'],
      minAppVersion: '0.1.0',
      maxAppMajor: 0,
    };
    const h = Buffer.from(
        JSON.stringify({ typ: 'MetaExam-License-v1', alg: 'Ed25519', kid: 'internal-test' }),
      ).toString('base64url'),
      p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const raw = JSON.stringify({
      protected: h,
      payload: p,
      signature: sign(
        null,
        Buffer.from('MetaExam-License-v1.' + h + '.' + p),
        keys.privateKey,
      ).toString('base64url'),
    });
    await importLicense(db, raw);
    await importLicense(db, raw);
    assert.equal((await licenseStatus(db)).state, 'valid');
    pass('local import, duplicate import and persisted verification');
    await assert.rejects(importLicense(db, raw.replace(/"signature":"./, '"signature":"!')));
    assert.equal((await licenseStatus(db)).state, 'valid');
    pass('invalid import preserves previous license');
    stop(api);
    api = start('apps/api/dist/main.js');
    await wait(async () => (await fetch(url + '/health/ready')).ok);
    const status = (await (await fetch(url + '/api/v1/system/status')).json()) as {
      license: { state: string };
    };
    assert.equal(status.license.state, 'valid');
    pass('local license verifies after API restart');
    // Persist public trust only; private test key exists solely in this process.
    oldTrust = publicStore;
    const badConfig = path.resolve('.local/unavailable-config.json');
    writeFileSync(
      badConfig,
      JSON.stringify({
        ...config,
        database: { ...config.database, port: 55433 },
        api: { ...config.api, port: 3301 },
      }),
    );
    const unavailable = start('apps/api/dist/main.js', badConfig);
    await wait(async () => (await fetch('http://127.0.0.1:3301/health/live')).ok);
    assert.equal((await fetch('http://127.0.0.1:3301/health/ready')).status, 503);
    pass('unavailable database returns readiness 503');
    stop(unavailable);
    stop(worker);
    stop(api);
    // Electron exits without owning or stopping API and worker.
    api = start('apps/api/dist/main.js', configPath);
    const w = start('apps/worker/dist/main.js', configPath);
    await wait(
      async () => (await fetch('http://127.0.0.1:' + config.api.port + '/health/ready')).ok,
    );
    const electronPath = path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe');
    const desktop = spawn(electronPath, ['apps/desktop'], {
      cwd: root,
      env: { ...process.env, METAEXAM_CONFIG: configPath, METAEXAM_DESKTOP_SMOKE: '1' },
      stdio: 'pipe',
      windowsHide: true,
    });
    children.push(desktop);
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error('DESKTOP_TIMEOUT')), 20000);
      desktop.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      desktop.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error('DESKTOP_EXIT_' + code));
      });
    });
    assert.equal(
      (await fetch('http://127.0.0.1:' + config.api.port + '/health/ready')).status,
      200,
    );
    assert.equal(w.exitCode, null);
    pass('closing Electron leaves API and worker running');
    mkdirSync('artifacts', { recursive: true });
    writeFileSync(
      'artifacts/integration-results.json',
      JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
    );
  } finally {
    if (oldTrust) writeFileSync(config.trustFile, oldTrust);
    for (const p of children)
      try {
        stop(p);
      } catch {
        /* exited */
      }
    await db.pool.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
