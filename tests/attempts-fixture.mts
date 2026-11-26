import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { examFixture } from './exams-fixture.mts';
export async function attemptFixture() {
  const t = await examFixture();
  try {
    const second = await t.create('/admin/users', {
      username: 'secondstudent',
      displayName: '第二考生',
      password: t.password,
      roles: ['student'],
    });
    await t.db.pool.query(
      'UPDATE user_credentials SET must_change_password=false WHERE user_id=$1',
      [second],
    );
    await t.db.pool.query('INSERT INTO class_members(class_id,student_id) VALUES($1,$2)', [
      t.classId,
      second,
    ]);
    const login = await t.request('/auth/login', 'POST', {
      username: 'secondstudent',
      password: t.password,
    });
    assert.equal(login.statusCode, 200);
    const secondCookie = String(login.headers['set-cookie']).split(';')[0]!;
    const a = randomUUID(),
      b = randomUUID(),
      blank = randomUUID();
    const sharp = createRequire(path.resolve('packages/db/package.json'))('sharp');
    const bytes = await sharp({
      create: { width: 32, height: 20, channels: 3, background: '#1677ff' },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'image.png');
    const uploaded = await fetch(
      'http://127.0.0.1:' +
        t.app.getHttpServer().address().port +
        '/api/v1/question-banks/' +
        t.bank +
        '/attachments',
      { method: 'POST', headers: { cookie: t.people.admin!.cookie }, body: form },
    );
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const imageId = (await uploaded.json()).id as string;
    const inputs = [
      {
        type: 'single',
        options: [
          { id: a, text: '选项甲' },
          { id: b, text: '选项乙' },
        ],
        answer: [a],
      },
      {
        type: 'multiple',
        options: [
          { id: a, text: '选项甲' },
          { id: b, text: '选项乙' },
        ],
        answer: [a, b],
      },
      {
        type: 'blank',
        blanks: [{ id: blank, answers: ['秘密标准填空'] }],
        caseSensitive: false,
        trimWhitespace: true,
      },
      { type: 'essay', referenceAnswer: '秘密简答参考答案' },
    ];
    for (const content of inputs)
      await t.create(`/question-banks/${t.bank}/questions`, {
        stem: content.type === 'blank' ? '请填 [[blank]]' : '作答题 ' + content.type,
        content,
        explanation: '秘密评分解析',
        difficulty: 2,
        tags: [],
        knowledgePoints: [],
        images: content.type === 'essay' ? [{ id: imageId, alt: '作答示意图' }] : [],
      });
    const instructions = '请逐题作答。\n简答题须写明计算过程。<b>按纯文本显示</b>';
    const r = await t.request(
      '/papers',
      'POST',
      { name: '五题型作答卷', courseId: t.courseId, instructions },
      t.people.teacher!.cookie,
    );
    const paperId = r.json().id;
    let revision = 1;
    for (const type of ['boolean', 'single', 'multiple', 'blank', 'essay']) {
      const draw = await t.request(
        `/papers/${paperId}/draw`,
        'POST',
        { revision: revision++, bankId: t.bank, type, count: 1, score: 2 },
        t.people.teacher!.cookie,
      );
      assert.equal(draw.statusCode, 200, draw.body);
    }
    const frozen = await t.request(
      `/papers/${paperId}/freeze`,
      'POST',
      { revision },
      t.people.teacher!.cookie,
    );
    assert.equal(frozen.statusCode, 200, frozen.body);
    await t.activate();
    const input = { ...t.input, paperVersionId: frozen.json().id };
    const created = await t.request('/exams', 'POST', input, t.people.teacher!.cookie);
    assert.equal(created.statusCode, 201, created.body);
    const examId = created.json().id as string;
    const published = await t.request(
      `/exams/${examId}/publish`,
      'POST',
      { revision: 1 },
      t.people.teacher!.cookie,
    );
    assert.equal(published.statusCode, 200, published.body);
    // Isolated test DB only: move the published window without waiting an hour.
    async function open() {
      const c = await t.db.pool.connect();
      await c.query('BEGIN');
      try {
        await c.query('ALTER TABLE exams DISABLE TRIGGER exams_guard');
        await c.query(
          "UPDATE exams SET starts_at=clock_timestamp()-interval '1 minute',ends_at=clock_timestamp()+interval '2 hours' WHERE id=$1",
          [examId],
        );
        await c.query('ALTER TABLE exams ENABLE TRIGGER exams_guard');
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }
    return {
      ...t,
      input,
      examId,
      instructions,
      open,
      second: { id: second, cookie: secondCookie },
      a,
      b,
      blank,
      imageId,
    };
  } catch (e) {
    await t.close();
    throw e;
  }
}
