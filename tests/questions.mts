import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { grantRuntimeAccess, MIGRATIONS, migrate, readiness } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
import { questionInputSchema, type QuestionInput } from '../packages/contracts/dist/index.js';
import { questionFixture } from './questions-fixture.mts';
const upgrade = await isolatedDatabase();
try {
  await upgrade.db.pool.query(
    'CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const m of MIGRATIONS.slice(0, 4)) {
    await upgrade.db.pool.query(m.sql);
    await upgrade.db.pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
      m.version,
      m.checksum,
    ]);
  }
  await upgrade.db.pool.query(
    "INSERT INTO courses(id,code,name) VALUES($1,'preserved','原有课程')",
    [randomUUID()],
  );
  await upgrade.db.pool.query('CREATE TABLE question_versions(sentinel integer)');
  await assert.rejects(migrate(upgrade.db));
  assert.equal(
    (await upgrade.db.pool.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v,
    4,
  );
  assert.equal(
    (await upgrade.db.pool.query("SELECT to_regclass('question_banks') AS t")).rows[0].t,
    null,
  );
  await upgrade.db.pool.query('DROP TABLE question_versions');
  await Promise.all([migrate(upgrade.db), migrate(upgrade.db)]);
  await migrate(upgrade.db);
  assert.ok(await readiness(upgrade.db));
  assert.equal(
    (await upgrade.db.pool.query("SELECT name FROM courses WHERE code='preserved'")).rows[0].name,
    '原有课程',
  );
  console.log(
    'PASS V4 upgrade preserves data, V5 failure rollback, concurrent retry and idempotence',
  );
} finally {
  await upgrade.close();
}
const t = await questionFixture();
const role = 'metaexam_test_' + randomUUID().replaceAll('-', '');
let roleCreated = false;
try {
  const { admin, teacher, other, student } = t.people;
  const request = t.request;
  const bank = await t.create('/question-banks', {
    name: '公共数学',
    courseId: t.courseId,
    visibility: 'public',
  });
  const privateResponse = await request(
    '/question-banks',
    'POST',
    { name: '教师个人', courseId: t.courseId, visibility: 'private' },
    teacher!.cookie,
  );
  assert.equal(privateResponse.statusCode, 201, privateResponse.body);
  const personal = privateResponse.json().id;
  const outside = await t.create('/question-banks', {
    name: '跨课程',
    courseId: t.otherCourse,
    visibility: 'public',
  });
  for (const endpoint of [
    '/question-banks',
    '/question-banks/courses',
    `/question-banks/${bank}/questions`,
  ]) {
    assert.equal((await request(endpoint)).statusCode, 401);
    assert.equal((await request(endpoint, 'GET', undefined, student!.cookie)).statusCode, 403);
  }
  assert.equal(
    (await request(`/question-banks/${personal}`, 'GET', undefined, other!.cookie)).statusCode,
    404,
  );
  assert.equal(
    (await request(`/question-banks/${outside}`, 'GET', undefined, teacher!.cookie)).statusCode,
    404,
  );
  assert.equal(
    (
      await request(
        '/question-banks',
        'POST',
        { name: '伪造公共', courseId: t.courseId, visibility: 'public' },
        teacher!.cookie,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        '/question-banks',
        'POST',
        { name: '跨课程私库', courseId: t.otherCourse, visibility: 'private' },
        teacher!.cookie,
      )
    ).statusCode,
    409,
  );
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const base = {
    stem: '题库测试题干',
    difficulty: 3,
    tags: ['基础'],
    knowledgePoints: ['加法'],
    explanation: '敏感解析-only-educator',
  };
  const samples: QuestionInput[] = [
    {
      ...base,
      content: {
        type: 'single',
        options: ids.map((id, i) => ({ id, text: '选项' + i })),
        answer: [ids[0]!],
      },
    },
    {
      ...base,
      content: {
        type: 'multiple',
        options: ids.map((id, i) => ({ id, text: '选项' + i })),
        answer: [ids[0]!, ids[1]!],
      },
    },
    { ...base, content: { type: 'boolean', answer: false } },
    {
      ...base,
      stem: '计算 [[blank]] 与 [[blank]]',
      content: {
        type: 'blank',
        blanks: [
          { id: ids[0]!, answers: ['  One  ', '一'] },
          { id: ids[1]!, answers: ['二'] },
        ],
        caseSensitive: true,
        trimWhitespace: false,
      },
    },
    { ...base, content: { type: 'essay', referenceAnswer: '教师参考答案' } },
  ];
  const questionIds: string[] = [];
  for (const q of samples) {
    const r = await request(`/question-banks/${bank}/questions`, 'POST', q, admin!.cookie);
    assert.equal(r.statusCode, 201, r.body);
    questionIds.push(r.json().id);
  }
  assert.equal(
    (await request(`/question-banks/${bank}/questions`, 'POST', samples[0], teacher!.cookie))
      .statusCode,
    403,
  );
  const teacherQuestion = await request(
    `/question-banks/${personal}/questions`,
    'POST',
    samples[0],
    teacher!.cookie,
  );
  assert.equal(teacherQuestion.statusCode, 201, teacherQuestion.body);
  const questionUrl = `/question-banks/${bank}/questions/${questionIds[0]}`;
  const detail = await request(questionUrl, 'GET', undefined, teacher!.cookie);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().current.question, samples[0]);
  const blankDetail = await request(
    `/question-banks/${bank}/questions/${questionIds[3]}`,
    'GET',
    undefined,
    teacher!.cookie,
  );
  assert.equal(blankDetail.json().current.question.content.blanks[0].answers[0], '  One  ');
  for (const endpoint of [questionUrl, questionUrl + '/versions']) {
    const denied = await request(endpoint, 'GET', undefined, student!.cookie);
    assert.equal(denied.statusCode, 403);
    assert.ok(!denied.body.includes('敏感解析'));
  }
  assert.equal(
    (
      await request(
        `/question-banks/${outside}/questions/${questionIds[0]}`,
        'GET',
        undefined,
        admin!.cookie,
      )
    ).statusCode,
    404,
  );
  const list = (
    await request(
      `/question-banks/${bank}/questions?type=single&tag=基础&knowledgePoint=加法&difficulty=3&pageSize=1`,
      'GET',
      undefined,
      teacher!.cookie,
    )
  ).json();
  assert.equal(list.total, 1);
  assert.equal(list.items.length, 1);
  assert.ok(!JSON.stringify(list).includes('敏感解析'));
  const invalid = [
    { ...samples[0], content: { ...samples[0]!.content, answer: [randomUUID()] } },
    { ...samples[1], content: { ...samples[1]!.content, answer: [ids[0]] } },
    { ...samples[3], stem: '没有空位' },
    { ...samples[4], difficulty: 0 },
    { ...samples[0], evil: true },
    { ...samples[0], stem: '文'.repeat(8000), explanation: '文'.repeat(8000) },
  ];
  for (const input of invalid) {
    assert.equal(questionInputSchema.safeParse(input).success, false);
    const r = await request(`/question-banks/${bank}/questions`, 'POST', input, admin!.cookie);
    assert.equal(r.statusCode, 400, r.body);
  }
  const before = (await t.db.pool.query('SELECT count(*) FROM question_versions')).rows[0].count;
  assert.equal(before, '6');
  const edits = await Promise.all(
    ['新版本一', '新版本二'].map((stem) =>
      request(
        questionUrl,
        'PATCH',
        { revision: 1, question: { ...samples[0], stem } },
        admin!.cookie,
      ),
    ),
  );
  assert.deepEqual(edits.map((r) => r.statusCode).sort(), [200, 409]);
  const history = (
    await request(questionUrl + '/versions', 'GET', undefined, teacher!.cookie)
  ).json();
  assert.equal(history.total, 2);
  assert.deepEqual(history.items[1].question, samples[0]);
  assert.equal(
    history.items[0].question.content.options[0].id,
    ids[0],
    'stable option ID across revisions',
  );
  await assert.rejects(
    t.db.pool.query("UPDATE question_versions SET content='{}' WHERE question_id=$1", [
      questionIds[0],
    ]),
    /IMMUTABLE/,
  );
  await assert.rejects(
    t.db.pool.query('DELETE FROM question_versions WHERE question_id=$1', [questionIds[0]]),
    /IMMUTABLE/,
  );
  assert.equal(
    (
      await request(
        questionUrl + '/archive',
        'POST',
        { revision: 2, archived: true },
        admin!.cookie,
      )
    ).statusCode,
    204,
  );
  assert.equal(
    (await request(questionUrl, 'PATCH', { revision: 3, question: samples[0] }, admin!.cookie))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await request(
        questionUrl + '/archive',
        'POST',
        { revision: 3, archived: false },
        admin!.cookie,
      )
    ).statusCode,
    204,
  );
  assert.equal(
    (
      await request(
        `/question-banks/${bank}`,
        'PATCH',
        { name: '公共数学', description: '', revision: 1, archived: true },
        admin!.cookie,
      )
    ).statusCode,
    204,
  );
  assert.equal(
    (await request(`/question-banks/${bank}/questions`, 'POST', samples[0], admin!.cookie))
      .statusCode,
    409,
  );
  assert.equal(
    (await request(questionUrl + '/versions', 'GET', undefined, teacher!.cookie)).statusCode,
    200,
  );
  assert.equal(
    (
      await request(
        `/question-banks/${bank}`,
        'PATCH',
        { name: '公共数学', description: '', revision: 2, archived: false },
        admin!.cookie,
      )
    ).statusCode,
    204,
  );
  await t.db.pool.query('UPDATE user_credentials SET must_change_password=true WHERE user_id=$1', [
    teacher!.id,
  ]);
  assert.equal((await request(questionUrl, 'GET', undefined, teacher!.cookie)).statusCode, 403);
  await t.db.pool.query('UPDATE user_credentials SET must_change_password=false WHERE user_id=$1', [
    teacher!.id,
  ]);
  assert.equal(
    (
      await request(
        '/admin/assignments',
        'DELETE',
        { teacherId: teacher!.id, courseId: t.courseId, classId: t.classId },
        admin!.cookie,
      )
    ).statusCode,
    204,
  );
  assert.equal(
    (await request(`/question-banks/${personal}`, 'GET', undefined, teacher!.cookie)).statusCode,
    404,
  );
  assert.equal(
    (await request(`/question-banks/${personal}/questions`, 'POST', samples[0], teacher!.cookie))
      .statusCode,
    404,
  );
  const audit = (
    await t.db.pool.query("SELECT details FROM audit_events WHERE event LIKE 'question%'")
  ).rows;
  assert.ok(audit.length > 10);
  assert.ok(!JSON.stringify(audit).includes('敏感解析'));
  assert.ok(!JSON.stringify(audit).includes('选项0'));
  await t.db.pool.query('CREATE ROLE ' + role + ' NOLOGIN');
  roleCreated = true;
  await grantRuntimeAccess(t.db.pool, role, t.config.database.database);
  const c = await t.db.pool.connect();
  try {
    await c.query('SET ROLE ' + role);
    assert.equal((await c.query('SELECT count(*) FROM question_versions')).rows[0].count, '7');
    await assert.rejects(
      c.query('UPDATE question_versions SET version=version'),
      (e) => (e as { code: string }).code === '42501',
    );
    await assert.rejects(
      c.query('CREATE TABLE forbidden(id int)'),
      (e) => (e as { code: string }).code === '42501',
    );
    await c.query('BEGIN');
    const id = randomUUID();
    await c.query('INSERT INTO questions(id,bank_id) VALUES($1,$2)', [id, bank]);
    await c.query(
      'INSERT INTO question_versions(id,question_id,version,content,author_id) VALUES($1,$2,1,$3,$4)',
      [randomUUID(), id, JSON.stringify(samples[0]), admin!.id],
    );
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('ROLLBACK');
  } finally {
    await c.query('RESET ROLE');
    c.release();
  }
  await t.restart();
  assert.equal(
    (await request(questionUrl + '/versions', 'GET', undefined, admin!.cookie)).json().total,
    2,
  );
  console.log(
    'PASS five types, validation, scope/answer isolation, immutable versions, concurrent edit, archive, revoked teaching access, audit redaction, restricted runtime DML, restart',
  );
} finally {
  if (roleCreated) {
    await t.db.pool.query('DROP OWNED BY ' + role);
    await t.db.pool.query('DROP ROLE ' + role);
  }
  await t.close();
}
