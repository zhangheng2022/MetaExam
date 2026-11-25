import type { CandidateAnswer, CandidateQuestion, QuestionInput } from '@metaexam/contracts';
export function candidateQuestion(
  question: QuestionInput,
): Pick<CandidateQuestion, 'stem' | 'images' | 'content'> {
  const c = question.content;
  const content: CandidateQuestion['content'] =
    c.type === 'single' || c.type === 'multiple'
      ? { type: c.type, options: c.options.map((o) => ({ id: o.id, text: o.text })) }
      : c.type === 'blank'
        ? { type: 'blank', blanks: c.blanks.map((b) => ({ id: b.id })) }
        : { type: c.type };
  return {
    stem: question.stem,
    images: (question.images ?? []).map((i) => ({ id: i.id, alt: i.alt })),
    content,
  };
}
export function validCandidateAnswer(q: QuestionInput, answer: CandidateAnswer) {
  if (answer === null) return true;
  const c = q.content;
  if (c.type !== answer.type) return false;
  if (answer.type === 'single' && c.type === 'single')
    return answer.optionId === null || c.options.some((o) => o.id === answer.optionId);
  if (answer.type === 'multiple' && c.type === 'multiple')
    return answer.optionIds.every((id) => c.options.some((o) => o.id === id));
  if (answer.type === 'blank' && c.type === 'blank')
    return answer.values.every((v) => c.blanks.some((b) => b.id === v.id));
  return answer.type === 'boolean' || answer.type === 'essay';
}
export function isAnswered(answer: CandidateAnswer): boolean {
  if (!answer) return false;
  switch (answer.type) {
    case 'single':
      return answer.optionId !== null;
    case 'multiple':
      return answer.optionIds.length > 0;
    case 'boolean':
      return answer.value !== null;
    case 'blank':
      return answer.values.some((v) => v.value.trim().length > 0);
    case 'essay':
      return answer.text.trim().length > 0;
  }
}
