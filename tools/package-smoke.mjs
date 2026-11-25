import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..'),
  payload = path.join(root, 'artifacts/payload');
const isolated = mkdtempSync(path.join(tmpdir(), 'MetaExam-smoke-')),
  children = [];
const config = JSON.parse(readFileSync(path.join(root, '.local/config.json'), 'utf8'));
const port = 3303,
  url = 'http://127.0.0.1:' + port;
const conf = path.join(isolated, 'config.json');
writeFileSync(
  conf,
  JSON.stringify({ ...config, api: { ...config.api, port, webDir: path.join(payload, 'web') } }),
);
const env = { ...process.env, METAEXAM_CONFIG: conf };
function start(exe, args) {
  const p = spawn(exe, args, {
    cwd: isolated,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  p.stdout.on('data', (b) => {
    log += b;
  });
  p.stderr.on('data', (b) => {
    log += b;
  });
  p.on('error', (e) => {
    log += e.message;
  });
  p.log = () => log;
  children.push(p);
  return p;
}
async function wait(fn, p) {
  for (let i = 0; i < 80; i++) {
    if (p?.exitCode !== null && p?.exitCode !== undefined) throw new Error(p.log());
    try {
      if (await fn()) return;
    } catch {
      /* startup */
    }
    await delay(250);
  }
  throw new Error('SMOKE_TIMEOUT ' + (p?.log() ?? ''));
}
try {
  cpSync(path.join(payload, 'server'), path.join(isolated, 'server'), { recursive: true });
  cpSync(path.join(payload, 'runtime'), path.join(isolated, 'runtime'), { recursive: true });
  const node = path.join(isolated, 'runtime/node.exe');
  const api = start(node, ['server/api.cjs']);
  await wait(async () => (await fetch(url + '/health/ready')).ok, api);
  assert.equal((await fetch(url + '/')).status, 200);
  const worker = start(node, ['server/worker.cjs']);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + config.api.managementToken,
  };
  const response = await fetch(url + '/api/v1/diagnostics/jobs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ businessKey: 'package-' + randomUUID(), message: 'isolated-payload' }),
  });
  assert.equal(response.status, 202);
  const job = await response.json();
  await wait(async () => {
    const j = await (await fetch(url + '/api/v1/diagnostics/jobs/' + job.id, { headers })).json();
    return j.status === 'completed';
  }, worker);
  const status = JSON.parse(
    execFileSync(node, ['server/cli.cjs', 'license-status'], {
      cwd: isolated,
      env,
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  assert.equal(status.state, 'valid');
  env.METAEXAM_DESKTOP_SMOKE = '1';
  const manager = start(path.join(payload, 'manager/MetaExam.Manager.exe'), []);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('MANAGER_TIMEOUT ' + manager.log())), 20000);
    manager.once('error', reject);
    manager.once('exit', (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(manager.log()));
    });
  });
  assert.ok(manager.log().includes('DESKTOP_STATUS_READY'));
  assert.equal((await fetch(url + '/health/ready')).status, 200);
  assert.equal(worker.exitCode, null);
  const pgVersion = execFileSync(path.join(payload, 'postgres/bin/postgres.exe'), ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  assert.ok(pgVersion.includes('18.'));
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(root, 'artifacts/package-smoke-results.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        isolatedFromWorkspace: true,
        checks: [
          'bundled API ready and static web',
          'bundled Worker completes API task',
          'bundled CLI validates persisted license',
          'packaged Electron IPC returns database ready',
          'closing packaged Electron leaves API/Worker alive',
          'packaged PostgreSQL binary version',
        ],
        postgres: pgVersion,
      },
      null,
      2,
    ),
  );
  console.log('ISOLATED_PACKAGE_SMOKE_PASSED');
} finally {
  for (const p of children)
    if (p.pid && p.exitCode === null)
      try {
        execFileSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        /* stopped */
      }
  await delay(500);
  if (
    path.dirname(isolated) === path.resolve(tmpdir()) &&
    path.basename(isolated).startsWith('MetaExam-smoke-')
  )
    try {
      rmSync(isolated, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      console.warn('Temporary smoke directory retained: ' + isolated);
    }
}
