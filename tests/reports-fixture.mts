import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gradeNextAttempt } from '../packages/db/dist/index.js';
import { attemptFixture } from './attempts-fixture.mts';
export async function reportFixture(options: { publish?: boolean; allAbsent?: boolean } = {}) {
  const t = await attemptFixture();
  try {
    const absent = await t.create('/admin/users', {
      username: '00007',
      displayName: '=2+3',
      password: t.password,
      roles: ['student'],
    });
    await t.db.pool.query('INSERT INTO class_members(class_id,student_id) VALUES($1,$2)', [
      t.classId,
      absent,
    ]);
    const original = (
      await t.request('/exams/' + t.examId, 'GET', undefined, t.people.teacher!.cookie)
    ).json();
    const created = await t.request(
      '/exams',
      'POST',
      { ...t.input, name: '成绩统计验收', paperVersionId: original.paperVersionId },
      t.people.teacher!.cookie,
    );
    assert.equal(created.statusCode, 201, created.body);
    const examId = created.json().id as string;
    assert.equal(
      (
        await t.request(
          `/exams/${examId}/publish`,
          'POST',
          { revision: 1 },
          t.people.teacher!.cookie,
        )
      ).statusCode,
      200,
    );
    async function clock(finish = false) {
      const c = await t.db.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('ALTER TABLE exams DISABLE TRIGGER exams_guard');
        await c.query(
          finish
            ? "UPDATE exams SET starts_at=clock_timestamp()-interval '3 hours',ends_at=clock_timestamp()-interval '1 second' WHERE id=$1"
            : "UPDATE exams SET starts_at=clock_timestamp()-interval '1 minute',ends_at=clock_timestamp()+interval '2 hours' WHERE id=$1",
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
    await clock();
    if (!options.allAbsent) {
      for (const [index, cookie] of [t.people.student!.cookie, t.second.cookie].entries()) {
        const entered = await t.request(`/my-exams/${examId}/start`, 'POST', {}, cookie);
        assert.equal(entered.statusCode, 200, entered.body);
        const id = entered.json().id;
        if (index === 0) {
          const answers = [
            { type: 'boolean', value: true },
            { type: 'single', optionId: t.a },
            { type: 'multiple', optionIds: [t.a, t.b] },
            { type: 'blank', values: [{ id: t.blank, value: '秘密标准填空' }] },
            { type: 'essay', text: '考生原文不导出' },
          ];
          for (let n = 0; n < answers.length; n++)
            assert.equal(
              (
                await t.request(
                  `/attempts/${id}/questions/${n + 1}`,
                  'PUT',
                  { revision: 0, mutationId: randomUUID(), answer: answers[n] },
                  cookie,
                )
              ).statusCode,
              200,
            );
        }
        assert.equal(
          (
            await t.request(
              `/attempts/${id}/submit`,
              'POST',
              { revision: index === 0 ? 5 : 0 },
              cookie,
            )
          ).statusCode,
          200,
        );
        await gradeNextAttempt(t.db);
        assert.equal(
          (
            await t.request(
              `/grading/exams/${examId}/attempts/${id}/questions/5`,
              'PUT',
              { revision: 1, score: index === 0 ? 1.5 : 0, comment: '内部评语不导出' },
              t.people.teacher!.cookie,
            )
          ).statusCode,
          200,
        );
      }
    }
    await clock(true);
    async function publish() {
      const state = (
        await t.request('/grading/exams/' + examId, 'GET', undefined, t.people.teacher!.cookie)
      ).json();
      const r = await t.request(
        `/grading/exams/${examId}/publish`,
        'POST',
        { revision: state.revision },
        t.people.teacher!.cookie,
      );
      assert.equal(r.statusCode, 200, r.body);
    }
    if (options.publish !== false) await publish();
    return { ...t, examId, absent, publish };
  } catch (e) {
    await t.close();
    throw e;
  }
}
