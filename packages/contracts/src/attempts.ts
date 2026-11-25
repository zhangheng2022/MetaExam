import { z } from 'zod';
import { idSchema } from './management';
export const startAttemptSchema = z.object({}).strict();
export const answerSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('single'), optionId: idSchema.nullable() }).strict(),
    z
      .object({
        type: z.literal('multiple'),
        optionIds: z
          .array(idSchema)
          .max(8)
          .refine((v) => new Set(v).size === v.length),
      })
      .strict(),
    z.object({ type: z.literal('boolean'), value: z.boolean().nullable() }).strict(),
    z
      .object({
        type: z.literal('blank'),
        values: z
          .array(z.object({ id: idSchema, value: z.string().max(200) }).strict())
          .max(20)
          .refine((v) => new Set(v.map((x) => x.id)).size === v.length),
      })
      .strict(),
    z.object({ type: z.literal('essay'), text: z.string().max(8000) }).strict(),
  ])
  .nullable();
export const saveAnswerSchema = z
  .object({ revision: z.number().int().nonnegative(), mutationId: idSchema, answer: answerSchema })
  .strict();
export const submitAttemptSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
export const positionSchema = z.coerce.number().int().min(1).max(200);
export type CandidateAnswer = z.infer<typeof answerSchema>;
export type SaveAnswer = z.infer<typeof saveAnswerSchema>;
export interface AttemptSummary {
  id: string;
  examId: string;
  name: string;
  status: 'active' | 'submitted';
  startedAt: string;
  deadlineAt: string;
  submittedAt: string | null;
  submitReason: 'manual' | 'timeout' | null;
  revision: number;
  serverTime: string;
  answeredCount: number;
  items: {
    position: number;
    type: 'single' | 'multiple' | 'boolean' | 'blank' | 'essay';
    score: number;
    answered: boolean;
  }[];
}
export interface CandidateQuestion {
  position: number;
  stem: string;
  score: number;
  images: { id: string; alt: string }[];
  content:
    | { type: 'single' | 'multiple'; options: { id: string; text: string }[] }
    | { type: 'boolean' }
    | { type: 'blank'; blanks: { id: string }[] }
    | { type: 'essay' };
  answer: CandidateAnswer;
  revision: number;
  savedAt: string | null;
}
