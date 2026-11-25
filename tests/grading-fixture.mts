import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { attemptFixture } from './attempts-fixture.mts';
export async function gradingFixture() {
  const t = await attemptFixture();
  try {
    await t.open();
    const cookie = t.people.student!.cookie;
    const entered = await t.request(`/my-exams/${t.examId}/start`, 'POST', {}, cookie);
    assert.equal(entered.statusCode, 200, entered.body);
    const attemptId = entered.json().id as string;
    const answers = [
      { type: 'boolean', value: true },
      { type: 'single', optionId: t.a },
      { type: 'multiple', optionIds: [t.b, t.a] },
      { type: 'blank', values: [{ id: t.blank, value: ' 秘密标准填空 ' }] },
      { type: 'essay', text: '考生的人工评分答案' },
    ];
    for (let i = 0; i < answers.length; i++) {
      const r = await t.request(
        `/attempts/${attemptId}/questions/${i + 1}`,
        'PUT',
        { revision: 0, mutationId: randomUUID(), answer: answers[i] },
        cookie,
      );
      assert.equal(r.statusCode, 200, r.body);
    }
    const submitted = await t.request(
      `/attempts/${attemptId}/submit`,
      'POST',
      { revision: 5 },
      cookie,
    );
    assert.equal(submitted.statusCode, 200, submitted.body);
    async function finish() {
      // Isolated fixture clock only; production has no exam time override endpoint.
      const c = await t.db.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('ALTER TABLE exams DISABLE TRIGGER exams_guard');
        await c.query(
          "UPDATE exams SET starts_at=clock_timestamp()-interval '3 hours',ends_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [t.examId],
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
    return { ...t, attemptId, finish };
  } catch (e) {
    await t.close();
    throw e;
  }
}
