import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { questionFixture } from './questions-fixture.mts';
import { grantRuntimeAccess, MIGRATIONS, migrate, readiness } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
import { execFileSync } from 'node:child_process';
const upgrade = await isolatedDatabase();
try {
  const original = execFileSync('git', ['show', '2cf4d7c:packages/db/src/migrations.ts'], {
    encoding: 'utf8',
  });
  assert.equal(
    MIGRATIONS[5]!.sql,
    original.split('const imports = `')[1]!.split('`;')[0]!,
    'V6 SQL preserved',
  );
  await upgrade.db.pool.query(
    'CREATE TABLE schema_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const m of MIGRATIONS.slice(0, 6)) {
    await upgrade.db.pool.query(m.sql);
    await upgrade.db.pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
      m.version,
      m.checksum,
    ]);
  }
  const old = randomUUID();
  await upgrade.db.pool.query(
    "INSERT INTO jobs(id,business_key,kind,payload) VALUES($1,'v6-preserved','diagnostic.echo','{}')",
    [old],
  );
  await upgrade.db.pool.query('CREATE TABLE paper_versions(sentinel integer)');
  await assert.rejects(migrate(upgrade.db));
  assert.equal(
    (await upgrade.db.pool.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v,
    6,
  );
  assert.equal((await upgrade.db.pool.query("SELECT to_regclass('papers') AS t")).rows[0].t, null);
  await upgrade.db.pool.query('DROP TABLE paper_versions');
  await Promise.all([migrate(upgrade.db), migrate(upgrade.db)]);
  await migrate(upgrade.db);
  assert.equal(await readiness(upgrade.db), true);
  assert.equal((await upgrade.db.pool.query('SELECT id FROM jobs')).rows[0].id, old);
  console.log('PASS V6 bytes/data preserved, V7 rollback/concurrent retry/idempotence');
} finally {
  await upgrade.close();
}
const t = await questionFixture();
const role = 'metaexam_test_' + randomUUID().replaceAll('-', '');
let roleCreated = false;
try {
  const { admin, teacher, other, student } = t.people;
  const req = (url: string, method = 'GET', data?: object, cookie = admin!.cookie) =>
    t.request(url, method, data, cookie);
  const create = async (url: string, body: object, cookie = admin!.cookie) => {
    const r = await req(url, 'POST', body, cookie);
    assert.equal(r.statusCode, 201, r.body);
    return r.json().id as string;
  };
  const bank = await create('/question-banks', {
    name: '组卷公共库',
    courseId: t.courseId,
    visibility: 'public',
  });
  const versions: string[] = [];
  const questionIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const id = await create(`/question-banks/${bank}/questions`, {
      stem: '组卷题 ' + i,
      content: { type: 'boolean', answer: i % 2 === 0 },
      difficulty: i < 4 ? 2 : 4,
      tags: ['基础'],
      knowledgePoints: ['整数'],
      explanation: '原始答案解析',
    });
    questionIds.push(id);
    versions.push((await req(`/question-banks/${bank}/questions/${id}`)).json().current.id);
  }
  const createPaper = (cookie = admin!.cookie) =>
    create(
      '/papers',
      { name: '数学试卷', courseId: t.courseId, instructions: '请按顺序作答' },
      cookie,
    );
  const id = await createPaper();
  const route = '/papers/' + id;
  const detail = async () => {
    const r = await req(route);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const save = (items: { versionId: string; score: number }[], revision: number) =>
    req(route, 'PATCH', { name: '数学试卷', instructions: '请按顺序作答', items, revision });
  assert.equal((await req('/papers', 'GET', undefined, '')).statusCode, 401);
  assert.equal((await req('/papers', 'GET', undefined, student!.cookie)).statusCode, 403);
  assert.equal((await req(route, 'GET', undefined, teacher!.cookie)).statusCode, 404);
  assert.equal((await req(route + '/freeze', 'POST', { revision: 1 })).json().code, 'EMPTY_PAPER');
  assert.equal((await save([{ versionId: versions[0]!, score: 0.1 }], 1)).statusCode, 400);
  assert.equal(
    (
      await save(
        [
          { versionId: versions[0]!, score: 1 },
          { versionId: versions[0]!, score: 2 },
        ],
        1,
      )
    ).statusCode,
    400,
  );
  const original = (await req(`/question-banks/${bank}/questions/${questionIds[0]}`)).json();
  assert.equal(
    (
      await req(`/question-banks/${bank}/questions/${questionIds[0]}`, 'PATCH', {
        revision: 1,
        question: {
          ...original.current.question,
          stem: '更新后的题干',
          content: { type: 'boolean', answer: false },
        },
      })
    ).statusCode,
    200,
  );
  const latest = (await req(`/question-banks/${bank}/questions/${questionIds[0]}`)).json().current
    .id;
  assert.equal(
    (
      await save(
        [
          { versionId: versions[0]!, score: 1 },
          { versionId: latest, score: 1 },
        ],
        1,
      )
    ).json().code,
    'INVALID_PAPER_QUESTIONS',
  );
  assert.equal(
    (
      await save(
        [
          { versionId: versions[0]!, score: 2.5 },
          { versionId: versions[1]!, score: 1 },
        ],
        1,
      )
    ).statusCode,
    200,
  );
  assert.equal((await detail()).totalScore, 3.5);
  assert.equal((await detail()).items[0].question.stem, '组卷题 0');
  const concurrent = await Promise.all([
    save(
      [
        { versionId: versions[1]!, score: 1 },
        { versionId: versions[0]!, score: 2.5 },
      ],
      2,
    ),
    save(
      [
        { versionId: versions[1]!, score: 1 },
        { versionId: versions[0]!, score: 2.5 },
      ],
      2,
    ),
  ]);
  assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [200, 409]);
  const p = await detail();
  const failedDraw = await req(route + '/draw', 'POST', {
    revision: p.revision,
    bankId: bank,
    type: 'boolean',
    difficulty: 2,
    tag: '基础',
    knowledgePoint: '整数',
    count: 20,
    score: 1,
  });
  assert.equal(failedDraw.json().code, 'INSUFFICIENT_QUESTIONS');
  assert.equal((await detail()).revision, p.revision);
  assert.equal(
    (
      await req(route + '/draw', 'POST', {
        revision: p.revision,
        bankId: bank,
        type: 'boolean',
        difficulty: 2,
        tag: '基础',
        knowledgePoint: '整数',
        count: 2,
        score: 0.5,
      })
    ).statusCode,
    200,
  );
  const afterDraw = await detail();
  assert.equal(afterDraw.items.length, 4);
  assert.equal(new Set(afterDraw.items.map((i: { questionId: string }) => i.questionId)).size, 4);
  assert.equal(afterDraw.totalScore, 4.5);
  assert.equal(
    (await req(route + `/candidates?bankId=${bank}&type=boolean&difficulty=2`)).json().total,
    0,
  );
  assert.equal((await req(route + `/candidates?bankId=${bank}&difficulty=4`)).json().total, 2);
  // A failure after snapshot insertion must roll all of it back.
  await t.db.pool.query(
    `CREATE FUNCTION reject_test_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='frozen' THEN RAISE EXCEPTION 'TEST_FREEZE_FAILURE'; END IF; RETURN NEW; END; $$; CREATE TRIGGER reject_test_freeze BEFORE UPDATE ON papers FOR EACH ROW EXECUTE FUNCTION reject_test_freeze()`,
  );
  assert.equal(
    (await req(route + '/freeze', 'POST', { revision: afterDraw.revision })).statusCode,
    503,
  );
  assert.equal(
    (await t.db.pool.query('SELECT count(*) FROM paper_versions WHERE paper_id=$1', [id])).rows[0]
      .count,
    '0',
  );
  assert.equal((await detail()).status, 'draft');
  await t.db.pool.query(
    'DROP TRIGGER reject_test_freeze ON papers; DROP FUNCTION reject_test_freeze()',
  );
  const frozen = await Promise.all([
    req(route + '/freeze', 'POST', { revision: afterDraw.revision }),
    req(route + '/freeze', 'POST', { revision: afterDraw.revision }),
  ]);
  assert.deepEqual(
    frozen.map((r) => r.statusCode),
    [200, 200],
  );
  assert.equal(frozen[0].json().id, frozen[1].json().id);
  const frozenId = frozen[0].json().id;
  const snapshot = await detail();
  assert.equal(snapshot.status, 'frozen');
  assert.equal(snapshot.items[1].versionId, versions[0]);
  const manifest = {
    schemaVersion: 1,
    paperId: id,
    courseId: t.courseId,
    name: snapshot.name,
    instructions: snapshot.instructions,
    items: snapshot.items.map((i: { versionId: string; score: number }, position: number) => ({
      position: position + 1,
      versionId: i.versionId,
      scoreUnits: i.score * 2,
    })),
  };
  assert.equal(
    snapshot.digest,
    createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  );
  assert.equal((await save([], snapshot.revision)).json().code, 'PAPER_FROZEN');
  assert.equal(
    (
      await req(route + '/draw', 'POST', {
        revision: snapshot.revision,
        bankId: bank,
        type: 'boolean',
        count: 1,
        score: 1,
      })
    ).json().code,
    'PAPER_FROZEN',
  );
  for (const sql of [
    "UPDATE papers SET name='changed' WHERE id=$1",
    'DELETE FROM papers WHERE id=$1',
    "UPDATE papers SET status='draft' WHERE id=$1",
    'DELETE FROM paper_draft_items WHERE paper_id=$1',
  ]) {
    await assert.rejects(t.db.pool.query(sql, [id]), /IMMUTABLE/);
  }
  await assert.rejects(
    t.db.pool.query('DELETE FROM paper_versions WHERE id=$1', [frozenId]),
    /IMMUTABLE/,
  );
  await assert.rejects(
    t.db.pool.query('UPDATE paper_version_items SET score_units=2 WHERE paper_version_id=$1', [
      frozenId,
    ]),
    /IMMUTABLE/,
  );
  await assert.rejects(
    t.db.pool.query(
      'INSERT INTO paper_version_items(paper_version_id,position,question_version_id,score_units) VALUES($1,5,$2,2)',
      [frozenId, versions[4]],
    ),
    /IMMUTABLE/,
  );
  await req(`/question-banks/${bank}/questions/${questionIds[0]}/archive`, 'POST', {
    revision: 2,
    archived: true,
  });
  const changedSource = (await req(`/question-banks/${bank}/questions/${questionIds[1]}`)).json();
  assert.equal(
    (
      await req(`/question-banks/${bank}/questions/${questionIds[1]}`, 'PATCH', {
        revision: 1,
        question: {
          ...changedSource.current.question,
          stem: '冻结后的题库改动',
          content: { type: 'boolean', answer: true },
        },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(
    (await detail()).items.map((i: object) => JSON.stringify((i as { question: object }).question)),
    snapshot.items.map((i: { question: object }) => JSON.stringify(i.question)),
  );
  const copy = await create(route + '/copy', { name: '新草稿' });
  const copyDetail = (await req('/papers/' + copy)).json();
  assert.equal(copyDetail.sourceVersionId, frozenId);
  assert.equal(copyDetail.status, 'draft');
  assert.deepEqual(
    copyDetail.items.map((i: { versionId: string }) => i.versionId),
    snapshot.items.map((i: { versionId: string }) => i.versionId),
  );
  assert.equal(
    (await req('/papers/' + copy + '/freeze', 'POST', { revision: 1 })).json().code,
    'INVALID_PAPER_QUESTIONS',
  );
  const teacherPaper = await createPaper(teacher!.cookie);
  assert.equal((await req(route, 'GET', undefined, student!.cookie)).statusCode, 403);
  const crossBank = await create('/question-banks', {
    name: '跨课题库',
    courseId: t.otherCourse,
    visibility: 'public',
  });
  const crossQuestion = await create(`/question-banks/${crossBank}/questions`, {
    stem: '其他课程',
    content: { type: 'boolean', answer: true },
    difficulty: 2,
    tags: [],
    knowledgePoints: [],
  });
  const crossVersion = (await req(`/question-banks/${crossBank}/questions/${crossQuestion}`)).json()
    .current.id;
  assert.equal(
    (
      await req('/papers/' + teacherPaper, 'PATCH', {
        revision: 1,
        name: '跨课试卷',
        instructions: '',
        items: [{ versionId: crossVersion, score: 1 }],
      })
    ).json().code,
    'INVALID_PAPER_QUESTIONS',
  );
  assert.equal(
    (await req('/papers/' + teacherPaper, 'GET', undefined, other!.cookie)).statusCode,
    404,
  );
  assert.equal(
    (await req('/papers/' + teacherPaper, 'GET', undefined, admin!.cookie)).statusCode,
    200,
  );
  const privateBank = await create(
    '/question-banks',
    { name: '他人的库', courseId: t.courseId, visibility: 'private' },
    other!.cookie,
  );
  const privateQuestion = await create(
    `/question-banks/${privateBank}/questions`,
    {
      stem: '私有',
      content: { type: 'boolean', answer: true },
      difficulty: 2,
      tags: [],
      knowledgePoints: [],
    },
    other!.cookie,
  );
  const privateVersion = (
    await req(
      `/question-banks/${privateBank}/questions/${privateQuestion}`,
      'GET',
      undefined,
      other!.cookie,
    )
  ).json().current.id;
  assert.equal(
    (
      await req(
        '/papers/' + teacherPaper,
        'PATCH',
        {
          revision: 1,
          name: '越权',
          instructions: '',
          items: [{ versionId: privateVersion, score: 1 }],
        },
        teacher!.cookie,
      )
    ).json().code,
    'INVALID_PAPER_QUESTIONS',
  );
  assert.equal(
    (
      await req(
        `/papers/${teacherPaper}/candidates?bankId=${privateBank}`,
        'GET',
        undefined,
        teacher!.cookie,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await req('/papers', 'POST', { name: '跨课', courseId: t.otherCourse }, teacher!.cookie))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await req(
        '/papers/' + teacherPaper,
        'PATCH',
        {
          revision: 1,
          name: '教师草稿',
          instructions: '',
          items: [{ versionId: versions[2], score: 1.5 }],
        },
        teacher!.cookie,
      )
    ).statusCode,
    200,
  );
  const base = 'http://127.0.0.1:' + t.app.getHttpServer().address().port;
  assert.equal(
    (
      await fetch(base + '/api/v1/papers/' + teacherPaper + '/freeze', {
        method: 'POST',
        headers: {
          cookie: teacher!.cookie,
          origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ revision: 2 }),
      })
    ).status,
    403,
  );
  await t.db.pool.query('DELETE FROM teaching_assignments WHERE teacher_id=$1', [teacher!.id]);
  assert.equal(
    (await req('/papers/' + teacherPaper + '/freeze', 'POST', { revision: 1 }, teacher!.cookie))
      .statusCode,
    404,
  );
  await t.db.pool.query('CREATE ROLE ' + role + ' NOLOGIN');
  roleCreated = true;
  await grantRuntimeAccess(t.db.pool, role, t.config.database.database);
  const c = await t.db.pool.connect();
  try {
    await c.query('SET ROLE ' + role);
    assert.equal((await c.query('SELECT count(*) FROM paper_versions')).rows[0].count, '1');
    await c.query('UPDATE papers SET name=name WHERE id=$1', [copy]);
    await c.query('BEGIN');
    try {
      const rp = randomUUID(),
        rv = randomUUID();
      await c.query(
        'INSERT INTO papers(id,course_id,owner_id,name,instructions) SELECT $2,course_id,owner_id,name,instructions FROM papers WHERE id=$1',
        [copy, rp],
      );
      await c.query(
        'INSERT INTO paper_draft_items SELECT $2,position,question_version_id,score_units FROM paper_draft_items WHERE paper_id=$1',
        [copy, rp],
      );
      await c.query(
        "INSERT INTO paper_versions(id,paper_id,course_id,name,instructions,total_units,digest,author_id) SELECT $2,p.id,p.course_id,p.name,p.instructions,(SELECT sum(score_units) FROM paper_draft_items WHERE paper_id=p.id),'runtime-permission-test',p.owner_id FROM papers p WHERE p.id=$1",
        [rp, rv],
      );
      await c.query(
        'INSERT INTO paper_version_items SELECT $2,position,question_version_id,score_units FROM paper_draft_items WHERE paper_id=$1',
        [rp, rv],
      );
      await c.query("UPDATE papers SET status='frozen' WHERE id=$1", [rp]);
      assert.equal(
        (await c.query('SELECT status FROM papers WHERE id=$1', [rp])).rows[0].status,
        'frozen',
      );
    } finally {
      await c.query('ROLLBACK');
    }
    await assert.rejects(
      c.query('DELETE FROM paper_version_items WHERE false'),
      (e: unknown) => (e as { code: string }).code === '42501',
    );
    await assert.rejects(
      c.query('CREATE TABLE forbidden_paper_table(id int)'),
      (e: unknown) => (e as { code: string }).code === '42501',
    );
  } finally {
    await c.query('RESET ROLE');
    c.release();
  }
  const audit = (
    await t.db.pool.query("SELECT details FROM audit_events WHERE event LIKE 'paper.%'")
  ).rows;
  assert.ok(!JSON.stringify(audit).includes('原始答案解析'));
  await t.restart();
  assert.equal((await detail()).digest, snapshot.digest);
  assert.equal((await detail()).frozenVersionId, frozenId);
  console.log(
    'PASS manual ordering/scores, exact versions, draw filtering/no replacement/shortage rollback, concurrent save/freeze, immutable SQL snapshots, copy, permission scope/revocation, restricted role, audit and restart',
  );
} finally {
  if (roleCreated) {
    await t.db.pool.query('DROP OWNED BY ' + role);
    await t.db.pool.query('DROP ROLE ' + role);
  }
  await t.close();
}
