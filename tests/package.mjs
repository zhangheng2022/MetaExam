import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { isolatedDatabase } from './database-fixture.mts';
const { licenseRequest, importLicense, BootstrapRepository, digestToken } = createRequire(
  import.meta.url,
)('../packages/db/dist/index.js');
const root = path.resolve(import.meta.dirname, '..'),
  payload = path.join(root, 'artifacts/payload');
const isolated = mkdtempSync(path.join(tmpdir(), 'MetaExam-smoke-')),
  children = [];
const fixture = await isolatedDatabase();
const { config, db } = fixture;
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
  execFileSync(node, ['server/cli.cjs', 'migrate'], {
    cwd: isolated,
    env,
    windowsHide: true,
    stdio: 'pipe',
  });
  const request = await licenseRequest(db),
    keys = generateKeyPairSync('ed25519');
  writeFileSync(
    config.trustFile,
    JSON.stringify({ 'package-test': keys.publicKey.export({ type: 'spki', format: 'pem' }) }),
  );
  const issuedAt = new Date(Date.now() - 60000).toISOString();
  const h = Buffer.from(
    JSON.stringify({ typ: 'MetaExam-License-v1', alg: 'Ed25519', kid: 'package-test' }),
  ).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      product: 'MetaExam',
      licenseId: randomUUID(),
      customerId: 'package-test',
      installationId: request.installationId,
      fingerprintVersion: 1,
      deviceHash: request.deviceHash,
      sequence: 1,
      issuedAt,
      notBefore: issuedAt,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      maxConcurrentAttempts: 10,
      features: ['exam.core'],
      minAppVersion: '0.1.0',
      maxAppMajor: 0,
    }),
  ).toString('base64url');
  await importLicense(
    db,
    JSON.stringify({
      protected: h,
      payload: p,
      signature: sign(
        null,
        Buffer.from('MetaExam-License-v1.' + h + '.' + p),
        keys.privateKey,
      ).toString('base64url'),
    }),
  );
  const api = start(node, ['server/api.cjs']);
  await wait(async () => (await fetch(url + '/health/ready')).ok, api);
  assert.equal((await fetch(url + '/')).status, 200);
  const token = randomBytes(32).toString('hex');
  await new BootstrapRepository(db).issue(digestToken(token), new Date(Date.now() + 60000), {
    requestId: 'package-test',
  });
  const post = (route, body, cookie, authorization) =>
    fetch(url + route, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await post(
        '/api/v1/setup/administrator',
        { username: 'package_admin', displayName: 'Package', password: 'package password phrase' },
        undefined,
        'Bearer ' + token,
      )
    ).status,
    201,
  );
  const signed = await post('/api/v1/auth/login', {
    username: 'package_admin',
    password: 'package password phrase',
  });
  assert.equal(signed.status, 200);
  const cookie = signed.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(url + '/api/v1/admin/overview', { headers: { cookie } })).status, 200);
  const create = async (route, data) => {
    const r = await post('/api/v1' + route, data, cookie);
    assert.equal(r.status, 201, await r.clone().text());
    return (await r.json()).id;
  };
  const studentId = await create('/admin/users', {
    username: 'payload_student',
    displayName: '学生',
    password: 'payload temporary phrase',
    roles: ['student'],
  });
  const teacherId = await create('/admin/users', {
    username: 'payload_teacher',
    displayName: '教师',
    password: 'payload temporary phrase',
    roles: ['teacher'],
  });
  const classId = await create('/admin/organizations/classes', {
    code: 'payload_class',
    name: '班级',
  });
  const courseId = await create('/admin/organizations/courses', {
    code: 'payload_course',
    name: '课程',
  });
  const bankId = await create('/question-banks', {
    name: '包内题库',
    courseId,
    visibility: 'public',
  });
  const questionId = await create('/question-banks/' + bankId + '/questions', {
    stem: '包内判断题',
    content: { type: 'boolean', answer: true },
    difficulty: 2,
    tags: [],
    knowledgePoints: [],
    explanation: '仅供教师查看',
  });
  const questionPath = '/api/v1/question-banks/' + bankId + '/questions/' + questionId;
  assert.equal(
    (await fetch(url + questionPath + '/versions', { headers: { cookie } })).status,
    200,
  );
  assert.equal(
    (await fetch(url + '/question-banks/' + bankId)).headers
      .get('content-type')
      .includes('text/html'),
    true,
  );
  assert.equal(
    (await post('/api/v1/admin/classes/' + classId + '/members', { studentId }, cookie)).status,
    204,
  );
  assert.equal(
    (await post('/api/v1/admin/assignments', { teacherId, classId, courseId }, cookie)).status,
    204,
  );
  const temporary = await post('/api/v1/auth/login', {
    username: 'payload_student',
    password: 'payload temporary phrase',
  });
  assert.equal((await temporary.clone().json()).mustChangePassword, true);
  const studentCookie = temporary.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (await fetch(url + questionPath, { headers: { cookie: studentCookie } })).status,
    403,
  );
  assert.equal(
    (await fetch(url + '/api/v1/teaching/me', { headers: { cookie: studentCookie } })).status,
    403,
  );
  assert.equal(
    (await fetch(url + '/users')).headers.get('content-type').includes('text/html'),
    true,
  );
  assert.equal(
    (
      await post(
        '/api/v1/auth/change-password',
        { oldPassword: 'package password phrase', newPassword: 'package changed phrase' },
        cookie,
      )
    ).status,
    204,
  );
  assert.equal((await fetch(url + '/api/v1/auth/me', { headers: { cookie } })).status, 401);
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
          'bundled setup, login, protected overview and password revocation',
          'bundled account/organization/assignment management and forced password boundary',
          'bundled question bank, immutable version read, deep route and student answer denial',
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
  await fixture.close();
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
