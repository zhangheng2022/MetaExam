import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResults, selectResults, type ScoredRecord } from '../packages/domain/src/results';
import { reportFiltersSchema } from '../packages/contracts/src/reports';
const row = (id: string, scoreUnits: number | null): ScoredRecord => ({
  id,
  username: id,
  displayName: id,
  scoreUnits,
  submittedAt: null,
});
test('result statistics distinguish absence and zero, round means and preserve half-point comparisons', () => {
  const rows = [row('a', 19), row('b', 0), row('c', null)];
  const s = summarizeResults(rows, 20, 60);
  assert.deepEqual(
    [
      s.average,
      s.median,
      s.highest,
      s.lowest,
      s.passRate,
      s.passedCount,
      s.presentCount,
      s.absentCount,
    ],
    [4.75, 4.75, 9.5, 0, 50, 1, 2, 1],
  );
  assert.deepEqual(
    s.distribution.map((v) => v.count),
    [1, 0, 0, 0, 1],
  );
  assert.equal(summarizeResults(rows, 20, 95).passedCount, 1);
  assert.equal(summarizeResults(rows, 20, 96).passedCount, 0);
  assert.equal(summarizeResults(rows, 20, 0).passedCount, 2);
  assert.equal(summarizeResults([row('a', 1), row('b', 2), row('c', 2)], 3, 60).average, 0.83);
  assert.equal(summarizeResults([row('a', 1), row('b', 2)], 3, 60).median, 0.75);
});
test('all-absent report has null score statistics; exact bin boundaries and full scores count once', () => {
  const s = summarizeResults([row('a', null)], 20, 60);
  assert.equal(s.average, null);
  assert.equal(s.median, null);
  assert.equal(s.passRate, null);
  assert.equal(s.highest, null);
  assert.equal(s.passedCount, 0);
  const b = summarizeResults(
    [0, 4, 8, 12, 16, 20].map((p, i) => row(String(i), p)),
    20,
    60,
  );
  assert.deepEqual(
    b.distribution.map((v) => v.count),
    [1, 1, 1, 1, 2],
  );
});
test('deterministic filtered ordering places absent records last for score sorts', () => {
  const rows = [row('z', null), row('b', 10), row('a', 10), row('c', 0)],
    f = reportFiltersSchema.parse({ sort: 'score_asc' });
  assert.deepEqual(
    selectResults(rows, 20, f).map((v) => v.id),
    ['c', 'a', 'b', 'z'],
  );
  assert.deepEqual(
    selectResults(rows, 20, { ...f, sort: 'score_desc' }).map((v) => v.id),
    ['a', 'b', 'c', 'z'],
  );
  assert.equal(selectResults(rows, 20, { ...f, status: 'absent' })[0]!.score, null);
  assert.deepEqual(
    selectResults(rows, 20, { ...f, q: 'B' }).map((v) => v.id),
    ['b'],
  );
  assert.throws(() => reportFiltersSchema.parse({ userId: 'forged' }));
  assert.throws(() => reportFiltersSchema.parse({ passPercent: 60.1 }));
});
