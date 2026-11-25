import type { CandidateAnswer, QuestionInput } from '@metaexam/contracts';
// Policy v1: full match only. Integer half-point units avoid fractional rounding.
export function gradeObjective(
  question: QuestionInput,
  answer: CandidateAnswer,
  maxUnits: number,
): number | null {
  const q = question.content;
  if (q.type === 'essay') return null;
  if (!answer || answer.type !== q.type) return 0;
  let correct = false;
  if (q.type === 'boolean' && answer.type === 'boolean') correct = answer.value === q.answer;
  if (q.type === 'single' && answer.type === 'single') correct = answer.optionId === q.answer[0];
  if (q.type === 'multiple' && answer.type === 'multiple')
    correct =
      answer.optionIds.length === q.answer.length &&
      new Set(answer.optionIds).size === answer.optionIds.length &&
      q.answer.every((id) => answer.optionIds.includes(id));
  if (q.type === 'blank' && answer.type === 'blank') {
    const normalize = (v: string) => {
      const s = q.trimWhitespace ? v.trim() : v;
      return q.caseSensitive ? s : s.toLowerCase();
    };
    correct =
      answer.values.length === q.blanks.length &&
      new Set(answer.values.map((v) => v.id)).size === answer.values.length &&
      q.blanks.every((b) => {
        const v = answer.values.find((v) => v.id === b.id);
        return !!v && b.answers.some((expected) => normalize(expected) === normalize(v.value));
      });
  }
  return correct ? maxUnits : 0;
}
