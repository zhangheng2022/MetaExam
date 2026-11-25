import { z } from 'zod';
import { idSchema, listSchema } from './management';
export const examInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    paperVersionId: idSchema,
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    durationMinutes: z.number().int().min(1).max(480),
    classIds: z
      .array(idSchema)
      .min(1)
      .max(50)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export const examSaveSchema = examInputSchema
  .extend({ revision: z.number().int().positive() })
  .strict();
export const examRevisionSchema = z.object({ revision: z.number().int().positive() }).strict();
export const examCancelSchema = examRevisionSchema
  .extend({ reason: z.string().trim().min(1).max(500) })
  .strict();
export const examQuerySchema = listSchema
  .pick({ page: true, pageSize: true, q: true })
  .extend({ status: z.enum(['draft', 'published', 'cancelled']).optional() });
export const examChoiceSchema = listSchema
  .pick({ page: true, pageSize: true, q: true })
  .extend({ courseId: idSchema.optional() });
export type ExamInput = z.infer<typeof examInputSchema>;
export type ExamSave = z.infer<typeof examSaveSchema>;
export type ExamQuery = z.infer<typeof examQuerySchema>;
export type ExamChoiceQuery = z.infer<typeof examChoiceSchema>;
export type ExamPhase = 'draft' | 'scheduled' | 'in_progress' | 'ended' | 'cancelled';
export interface StudentExam {
  id: string;
  name: string;
  courseName: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  phase: ExamPhase;
  totalScore: number;
  itemCount: number;
  cancellationReason: string | null;
}
export interface ExamSummary extends StudentExam {
  courseId: string;
  ownerId: string;
  ownerName: string;
  paperVersionId: string;
  paperName: string;
  status: 'draft' | 'published' | 'cancelled';
  revision: number;
  rosterCount: number;
  publishedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
}
export interface ExamPerson {
  id: string;
  username: string;
  displayName: string;
}
export interface ExamDetail extends ExamSummary {
  classes: { id: string; name: string }[];
  publicationCapacity: number | null;
  licenseExpiresAt: string | null;
}
