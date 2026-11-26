import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  cpSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, randomBytes, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isolatedDatabase } from './database-fixture.mts';
const { licenseRequest, importLicense, BootstrapRepository, digestToken } = createRequire(
  import.meta.url,
)('../packages/db/dist/index.js');
const root = path.resolve(import.meta.dirname, '..'),
  payload = path.join(root, 'artifacts/payload');
assert.ok(existsSync(path.join(payload, 'maintenance/data-directory.ps1')));
const releaseVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const releaseExe = path.join(
  root,
  'artifacts',
  `MetaExam-Setup-${releaseVersion}-win-x64-internal.exe`,
);
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const originalExeHash = digest(releaseExe),
  originalManifestHash = digest(path.join(payload, 'release.json'));
assert.throws(
  () =>
    execFileSync(process.execPath, ['installer/build.mjs'], {
      cwd: root,
      windowsHide: true,
      stdio: 'pipe',
    }),
  (error) => error.stderr.toString().includes('RELEASE_ALREADY_EXISTS'),
);
assert.equal(digest(releaseExe), originalExeHash);
assert.equal(digest(path.join(payload, 'release.json')), originalManifestHash);
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
  const worker = start(node, ['server/worker.cjs']);
  const bankRoute = '/api/v1/question-banks/' + bankId;
  const template = await fetch(url + bankRoute + '/import-template', { headers: { cookie } });
  assert.equal(template.status, 200, await template.clone().text());
  const runtimeRequire = createRequire(path.join(isolated, 'server/api.cjs'));
  const Excel = runtimeRequire('exceljs');
  const book = new Excel.Workbook();
  await book.xlsx.load(Buffer.from(await template.arrayBuffer()));
  book
    .getWorksheet('题目')
    .addRow([
      '判断',
      '离线包导入判断题',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '正确',
      '',
      2,
      '',
      '',
      '',
      '',
    ]);
  const upload = async (route, bytes, name, type) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    return fetch(url + bankRoute + route, { method: 'POST', headers: { cookie }, body: form });
  };
  const uploaded = await upload(
    '/imports',
    await book.xlsx.writeBuffer(),
    'payload.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.equal(uploaded.status, 202, await uploaded.clone().text());
  const importId = (await uploaded.json()).id;
  const report = async () =>
    (await (await fetch(url + bankRoute + '/imports/' + importId, { headers: { cookie } })).json())
      .summary;
  await wait(async () => (await report()).status === 'ready', worker);
  assert.equal(
    (
      await post(
        bankRoute + '/imports/' + importId + '/confirm',
        { duplicatePolicy: 'skip' },
        cookie,
      )
    ).status,
    202,
  );
  await wait(async () => (await report()).status === 'completed', worker);
  assert.equal((await report()).imported, 1);
  // A child releases its native DLL before Windows removes the isolated payload.
  const png = execFileSync(
    node,
    [
      '-e',
      "require('sharp')({create:{width:30,height:20,channels:3,background:'#1677ff'}}).png().toBuffer().then(b=>process.stdout.write(b))",
    ],
    { cwd: path.join(isolated, 'server'), windowsHide: true },
  );
  const imageUpload = await upload('/attachments', png, 'diagram.png', 'image/png');
  assert.equal(imageUpload.status, 201, await imageUpload.clone().text());
  const uploadedImage = await imageUpload.json();
  const imageId = uploadedImage.id;
  assert.equal(uploadedImage.width, 30);
  const imageResponse = await fetch(url + bankRoute + '/attachments/' + imageId + '/content', {
    headers: { cookie },
  });
  assert.equal(imageResponse.status, 200);
  assert.equal(
    Buffer.from(await imageResponse.arrayBuffer())
      .subarray(0, 8)
      .toString('hex'),
    '89504e470d0a1a0a',
  );
  const questionId = await create('/question-banks/' + bankId + '/questions', {
    stem: '包内判断题',
    content: { type: 'boolean', answer: true },
    difficulty: 2,
    tags: [],
    knowledgePoints: [],
    explanation: '仅供教师查看',
    images: [{ id: imageId, alt: '包内示意图' }],
  });
  const questionPath = '/api/v1/question-banks/' + bankId + '/questions/' + questionId;
  const paperId = await create('/papers', {
    name: '包内冻结试卷',
    courseId,
    instructions: '普通进程回归',
  });
  const paperPath = '/api/v1/papers/' + paperId;
  assert.equal(
    (
      await post(
        paperPath + '/draw',
        { revision: 1, bankId, type: 'boolean', count: 2, score: 2.5 },
        cookie,
      )
    ).status,
    200,
  );
  const freeze = await post(paperPath + '/freeze', { revision: 2 }, cookie);
  assert.equal(freeze.status, 200, await freeze.clone().text());
  const frozenVersion = (await freeze.json()).id;
  const paper = await (await fetch(url + paperPath, { headers: { cookie } })).json();
  assert.equal(paper.status, 'frozen');
  assert.equal(paper.totalScore, 5);
  assert.equal(paper.frozenVersionId, frozenVersion);
  assert.ok(paper.items.some((i) => i.question.images?.[0]?.id === imageId));
  assert.equal(
    (
      await fetch(url + paperPath, {
        method: 'PATCH',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 3, name: '改写', instructions: '', items: [] }),
      })
    ).status,
    409,
  );
  await create('/papers/' + paperId + '/copy', { name: '包内新草稿' });
  assert.equal(
    (await fetch(url + '/papers/' + paperId)).headers.get('content-type').includes('text/html'),
    true,
  );
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
    (await fetch(url + '/api/v1/my-exams', { headers: { cookie: studentCookie } })).status,
    403,
  );
  const examId = await create('/exams', {
    name: '包内考试发布',
    paperVersionId: frozenVersion,
    startsAt: new Date(Date.now() + 3600000).toISOString(),
    endsAt: new Date(Date.now() + 10800000).toISOString(),
    durationMinutes: 60,
    classIds: [classId],
  });
  const publish = await post('/api/v1/exams/' + examId + '/publish', { revision: 1 }, cookie);
  assert.equal(publish.status, 200, await publish.clone().text());
  const exam = await (await fetch(url + '/api/v1/exams/' + examId, { headers: { cookie } })).json();
  assert.equal(exam.status, 'published');
  assert.equal(exam.rosterCount, 1);
  assert.equal(exam.paperVersionId, frozenVersion);
  assert.equal(
    (await fetch(url + '/exams/' + examId)).headers.get('content-type').includes('text/html'),
    true,
  );
  assert.equal(
    (
      await post(
        '/api/v1/auth/change-password',
        { oldPassword: 'payload temporary phrase', newPassword: 'payload changed phrase' },
        studentCookie,
      )
    ).status,
    204,
  );
  const studentLogin = await post('/api/v1/auth/login', {
    username: 'payload_student',
    password: 'payload changed phrase',
  });
  const freshStudentCookie = studentLogin.headers.get('set-cookie').split(';')[0];
  const own = await (
    await fetch(url + '/api/v1/my-exams', { headers: { cookie: freshStudentCookie } })
  ).json();
  assert.equal(own.total, 1);
  assert.equal(own.items[0].id, examId);
  assert.equal(own.items[0].paperVersionId, undefined);
  assert.equal(
    (
      await post(
        '/api/v1/exams/' + examId + '/cancel',
        { revision: exam.revision, reason: '包内取消回归' },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await fetch(url + '/users')).headers.get('content-type').includes('text/html'),
    true,
  );
  const activeExam = await create('/exams', {
    name: '包内作答考试',
    paperVersionId: frozenVersion,
    startsAt: new Date(Date.now() + 3600000).toISOString(),
    endsAt: new Date(Date.now() + 10800000).toISOString(),
    durationMinutes: 60,
    classIds: [classId],
  });
  assert.equal(
    (await post('/api/v1/exams/' + activeExam + '/publish', { revision: 1 }, cookie)).status,
    200,
  );
  const clockClient = await db.pool.connect();
  try {
    await clockClient.query('BEGIN');
    await clockClient.query('ALTER TABLE exams DISABLE TRIGGER exams_guard');
    await clockClient.query(
      "UPDATE exams SET starts_at=clock_timestamp()-interval '1 minute',ends_at=clock_timestamp()+interval '2 hours' WHERE id=$1",
      [activeExam],
    );
    await clockClient.query('ALTER TABLE exams ENABLE TRIGGER exams_guard');
    await clockClient.query('COMMIT');
  } catch (e) {
    await clockClient.query('ROLLBACK');
    throw e;
  } finally {
    clockClient.release();
  }
  const admission = await post('/api/v1/my-exams/' + activeExam + '/start', {}, freshStudentCookie);
  assert.equal(admission.status, 200, await admission.clone().text());
  const attemptId = (await admission.json()).id;
  const attemptPath = '/api/v1/attempts/' + attemptId;
  const attemptDetail = await fetch(url + attemptPath, { headers: { cookie: freshStudentCookie } });
  assert.equal(attemptDetail.status, 200);
  assert.equal((await attemptDetail.json()).instructions, '普通进程回归');
  const attemptQuestion = await (
    await fetch(url + attemptPath + '/questions/1', { headers: { cookie: freshStudentCookie } })
  ).json();
  assert.equal(attemptQuestion.content.answer, undefined);
  assert.equal(attemptQuestion.explanation, undefined);
  assert.equal(attemptQuestion.answer, null);
  const answerSave = await fetch(url + attemptPath + '/questions/1', {
    method: 'PUT',
    headers: { cookie: freshStudentCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revision: 0,
      mutationId: randomUUID(),
      answer: { type: 'boolean', value: true },
    }),
  });
  assert.equal(answerSave.status, 200, await answerSave.clone().text());
  const candidateImage = await fetch(url + attemptPath + '/images/' + imageId, {
    headers: { cookie: freshStudentCookie },
  });
  assert.equal(candidateImage.status, 200);
  assert.equal(
    (await post(attemptPath + '/submit', { revision: 1 }, freshStudentCookie)).status,
    200,
  );
  const receipt = await (
    await fetch(url + attemptPath, { headers: { cookie: freshStudentCookie } })
  ).json();
  assert.equal(receipt.status, 'submitted');
  assert.equal(receipt.answeredCount, 1);
  assert.equal(
    (await fetch(url + attemptPath + '/questions/1', { headers: { cookie: freshStudentCookie } }))
      .status,
    409,
  );
  assert.equal(
    (await fetch(url + '/attempts/' + attemptId)).headers.get('content-type').includes('text/html'),
    true,
  );
  const gradingPath = '/api/v1/grading/exams/' + activeExam;
  await wait(async () => {
    const state = await (await fetch(url + gradingPath, { headers: { cookie } })).json();
    return state.readyCount === 1;
  }, worker);
  const review = await fetch(url + gradingPath + '/attempts/' + attemptId + '/questions/1', {
    headers: { cookie },
  });
  assert.equal(review.status, 200);
  const scored = await review.json();
  assert.equal(scored.items[0].mode, 'auto');
  const hiddenResult = await (
    await fetch(url + '/api/v1/my-exams/' + activeExam + '/result', {
      headers: { cookie: freshStudentCookie },
    })
  ).json();
  assert.equal(hiddenResult.state, 'unpublished');
  assert.equal(hiddenResult.totalScore, null);
  const finishClient = await db.pool.connect();
  try {
    await finishClient.query('BEGIN');
    await finishClient.query('ALTER TABLE exams DISABLE TRIGGER exams_guard');
    await finishClient.query(
      "UPDATE exams SET starts_at=clock_timestamp()-interval '3 hours',ends_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [activeExam],
    );
    await finishClient.query('ALTER TABLE exams ENABLE TRIGGER exams_guard');
    await finishClient.query('COMMIT');
  } catch (e) {
    await finishClient.query('ROLLBACK');
    throw e;
  } finally {
    finishClient.release();
  }
  const gradingState = await (await fetch(url + gradingPath, { headers: { cookie } })).json();
  assert.equal(
    (await post(gradingPath + '/publish', { revision: gradingState.revision }, cookie)).status,
    200,
  );
  const publishedResult = await (
    await fetch(url + '/api/v1/my-exams/' + activeExam + '/result', {
      headers: { cookie: freshStudentCookie },
    })
  ).json();
  assert.equal(publishedResult.state, 'published');
  assert.equal(publishedResult.totalScore, scored.items[0].score);
  assert.equal(publishedResult.items[0].question, undefined);
  const reportPath = '/api/v1/reports/exams/' + activeExam;
  const publishedStats = await (await fetch(url + reportPath, { headers: { cookie } })).json();
  assert.equal(publishedStats.statistics.presentCount, 1);
  assert.equal(publishedStats.statistics.average, publishedResult.totalScore);
  assert.equal(
    (await fetch(url + reportPath, { headers: { cookie: freshStudentCookie } })).status,
    403,
  );
  const resultExport = await post(reportPath + '/export', {}, cookie);
  assert.equal(resultExport.status, 200, await resultExport.clone().text());
  assert.equal(resultExport.headers.get('cache-control'), 'no-store');
  const resultBook = new Excel.Workbook();
  await resultBook.xlsx.load(Buffer.from(await resultExport.arrayBuffer()));
  assert.deepEqual(
    resultBook.worksheets.map((s) => s.name),
    ['统计概览', '成绩名单', '逐题统计'],
  );
  assert.equal(resultBook.getWorksheet('成绩名单').rowCount, 2);
  assert.equal(resultBook.getWorksheet('成绩名单').getCell('D2').value, publishedResult.totalScore);
  assert.equal(
    (await fetch(url + `/exams/${activeExam}/report`)).headers
      .get('content-type')
      .includes('text/html'),
    true,
  );
  assert.equal(
    (await fetch(url + `/exams/${activeExam}/grading`)).headers
      .get('content-type')
      .includes('text/html'),
    true,
  );
  assert.equal(
    (await fetch(url + `/my-exams/${activeExam}/result`)).headers
      .get('content-type')
      .includes('text/html'),
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
  assert.throws(
    () =>
      execFileSync(node, ['server/cli.cjs', 'license-desktop'], {
        cwd: isolated,
        env,
        encoding: 'utf8',
        windowsHide: true,
      }),
    (error) => error.stderr.trim() === 'ADMINISTRATOR_REQUIRED',
  );
  assert.throws(
    () =>
      execFileSync(node, ['server/cli.cjs', 'backup-desktop'], {
        cwd: isolated,
        env,
        encoding: 'utf8',
        windowsHide: true,
        input: '{"operation":"recover"}',
      }),
    (error) => error.stderr.trim() === 'ADMINISTRATOR_REQUIRED',
  );
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
  // Exercise the shipped backup engine and shipped pg_dump/pg_restore without elevation.
  const maintenance = await isolatedDatabase();
  const packed = createRequire(path.join(isolated, 'server/db.cjs'))('./db.cjs');
  try {
    await packed.migrate(maintenance.db);
    await packed.ensureInstance(maintenance.db);
    await maintenance.db.pool.query(
      "INSERT INTO courses(id,code,name) VALUES($1,'package-backup','备份时数据')",
      [randomUUID()],
    );
    await maintenance.db.pool.end();
    const destination = path.join(isolated, 'backups');
    mkdirSync(destination);
    const backup = new packed.BackupService(maintenance.config, {
      bin: path.join(payload, 'postgres/bin'),
      key: randomBytes(32),
      runtimeRole: maintenance.config.database.user,
      secureDirectory: async () => {},
    });
    const info = await backup.create(destination);
    const folder = path.join(destination, 'MetaExam-' + info.id + '.mbackup');
    assert.deepEqual(await backup.preview(folder), info);
    const changed = packed.createDatabase(maintenance.config);
    try {
      await changed.pool.query("UPDATE courses SET name='备份后数据'");
    } finally {
      await changed.pool.end();
    }
    await backup.restore(folder, info.id);
    const restored = packed.createDatabase(maintenance.config);
    try {
      assert.equal(
        (await restored.pool.query('SELECT name FROM courses')).rows[0].name,
        '备份时数据',
      );
    } finally {
      await restored.pool.end();
    }
  } finally {
    const cleanup = packed.createDatabase({
      ...maintenance.config,
      home: config.home,
      database: { ...maintenance.config.database, database: 'postgres' },
    });
    try {
      for (const entry of readdirSync(maintenance.config.home)) {
        const match = /^restore-([a-f0-9-]{36})$/.exec(entry);
        if (!match) continue;
        const suffix = match[1].replaceAll('-', '');
        assert.match(suffix, /^[a-f0-9]{32}$/);
        for (const prefix of ['metaexam_old_', 'metaexam_restore_'])
          await cleanup.pool.query('DROP DATABASE IF EXISTS ' + prefix + suffix + ' WITH (FORCE)');
      }
    } finally {
      await cleanup.pool.end();
      await maintenance.close();
    }
  }
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
          'isolated ExcelJS template, multipart import, worker-thread preflight and atomic confirmation',
          'isolated Sharp native PNG normalization and authenticated image read',
          'bundled paper draw, fixed question/image snapshot, fractional score, immutable freeze, copy and deep route',
          'bundled local-license publication, roster, student schedule redaction, forced-password boundary and cancellation',
          'bundled admission, sanitized questions and images, persistent answer, submission receipt and closed-write boundary',
          'bundled Worker objective grading, teacher review, hidden unpublished results, immutable publication and student score',
          'bundled published statistics and restricted Excel export through packaged worker thread',
          'bundled Worker completes API task',
          'bundled CLI validates persisted license',
          'bundled desktop license CLI rejects ordinary privileges',
          'bundled backup maintenance CLI rejects ordinary privileges',
          'bundled backup engine and PostgreSQL tools restore isolated data after authenticated preview',
          'packaged Electron IPC returns database ready',
          'closing packaged Electron leaves API/Worker alive',
          'packaged PostgreSQL binary version',
          'duplicate release build refused without changing EXE or payload manifest',
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
