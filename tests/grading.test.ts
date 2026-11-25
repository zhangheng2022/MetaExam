import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeObjective } from '../packages/domain/src/grading';
import type { QuestionContent, QuestionInput, CandidateAnswer } from '../packages/contracts/src';
const q = (content: QuestionContent): QuestionInput => ({
  content,
  stem: '题干',
  explanation: '',
  difficulty: 1,
  tags: [],
  knowledgePoints: [],
});
test('objective grading uses stable IDs, exact sets and integer half points', () => {
  const options = [
    { id: 'a', text: '甲' },
    { id: 'b', text: '乙' },
    { id: 'c', text: '丙' },
  ];
  assert.equal(
    gradeObjective(
      q({ type: 'single', options, answer: ['a'] }),
      { type: 'single', optionId: 'a' },
      3,
    ),
    3,
  );
  assert.equal(
    gradeObjective(
      q({ type: 'single', options, answer: ['a'] }),
      { type: 'single', optionId: 'b' },
      3,
    ),
    0,
  );
  const multi = q({ type: 'multiple', options, answer: ['a', 'b'] });
  for (const ids of [['a'], ['a', 'c'], ['a', 'b', 'c'], ['a', 'a']])
    assert.equal(gradeObjective(multi, { type: 'multiple', optionIds: ids }, 5), 0);
  assert.equal(gradeObjective(multi, { type: 'multiple', optionIds: ['b', 'a'] }, 5), 5);
  assert.equal(
    gradeObjective(q({ type: 'boolean', answer: false }), { type: 'boolean', value: false }, 1),
    1,
  );
  for (const a of [
    null,
    { type: 'boolean', value: null },
    { type: 'essay', text: 'false' },
  ] as CandidateAnswer[])
    assert.equal(gradeObjective(q({ type: 'boolean', answer: false }), a, 2), 0);
});
test('blank grading respects trim/case flags, alternatives and all blanks; essay stays manual', () => {
  const base = {
    type: 'blank' as const,
    blanks: [
      { id: '1', answers: ['A', '甲'] },
      { id: '2', answers: ['B'] },
    ],
    caseSensitive: false,
    trimWhitespace: true,
  };
  const answer: CandidateAnswer = {
    type: 'blank',
    values: [
      { id: '2', value: ' b ' },
      { id: '1', value: ' a ' },
    ],
  };
  assert.equal(gradeObjective(q(base), answer, 7), 7);
  assert.equal(gradeObjective(q({ ...base, caseSensitive: true }), answer, 7), 0);
  assert.equal(gradeObjective(q({ ...base, trimWhitespace: false }), answer, 7), 0);
  assert.equal(
    gradeObjective(q(base), { type: 'blank', values: [{ id: '1', value: '甲' }] }, 7),
    0,
  );
  assert.equal(
    gradeObjective(
      q(base),
      {
        type: 'blank',
        values: [
          { id: '1', value: '甲' },
          { id: '2', value: 'B' },
        ],
      },
      7,
    ),
    7,
  );
  assert.equal(gradeObjective(q({ type: 'essay', referenceAnswer: '参考' }), null, 4), null);
});
