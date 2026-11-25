import { z } from 'zod';
import { listSchema } from './management';
import type { CandidateAnswer } from './attempts';
import type { QuestionInput } from './questions';
export const gradingQuerySchema = listSchema.pick({ page: true, pageSize: true, q: true });
export const gradeSchema = z
  .object({
    revision: z.number().int().positive(),
    score: z.number().min(0).max(10000).multipleOf(0.5),
    comment: z.string().trim().max(2000),
  })
  .strict();
export const releaseGradesSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
export type GradeInput = z.infer<typeof gradeSchema>;
export type GradingQuery = z.infer<typeof gradingQuerySchema>;
export interface GradingOverview {
  examId: string;
  name: string;
  endsAt: string;
  totalScore: number;
  revision: number;
  publishedAt: string | null;
  rosterCount: number;
  submittedCount: number;
  activeCount: number;
  absentCount: number;
  pendingCount: number;
  readyCount: number;
  canPublish: boolean;
}
export interface GradingCandidate {
  id: string;
  username: string;
  displayName: string;
  attemptId: string | null;
  state: 'absent' | 'active' | 'pending' | 'ready';
  score: number | null;
}
export interface MarkingQuestion {
  position: number;
  question: QuestionInput;
  answer: CandidateAnswer;
  maxScore: number;
  score: number | null;
  mode: 'auto' | 'manual';
  revision: number;
  comment: string;
}
export interface MarkingDetail {
  attemptId: string;
  examId: string;
  displayName: string;
  username: string;
  publishedAt: string | null;
  itemCount: number;
  items: MarkingQuestion[];
}
export interface StudentResult {
  examId: string;
  name: string;
  state: 'unpublished' | 'absent' | 'published';
  publishedAt: string | null;
  totalScore: number | null;
  maxScore: number | null;
  items: { position: number; score: number; maxScore: number; comment: string }[];
}
