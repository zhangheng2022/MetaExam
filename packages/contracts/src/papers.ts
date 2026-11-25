import { z } from 'zod';
import { idSchema, listSchema } from './management';
import { questionTypeSchema, type QuestionInput } from './questions';
const name = z.string().trim().min(1).max(100);
export const scoreSchema = z.number().min(0.5).max(1000).multipleOf(0.5);
export const paperRevisionSchema = z.object({ revision: z.number().int().positive() }).strict();
export const paperCreateSchema = z
  .object({ name, courseId: idSchema, instructions: z.string().trim().max(2000).default('') })
  .strict();
export const paperItemSchema = z.object({ versionId: idSchema, score: scoreSchema }).strict();
export const paperSaveSchema = paperRevisionSchema
  .extend({
    name,
    instructions: z.string().trim().max(2000),
    items: z
      .array(paperItemSchema)
      .max(200)
      .refine((v) => new Set(v.map((i) => i.versionId)).size === v.length, '不能重复选题'),
  })
  .strict();
export const paperQuerySchema = listSchema
  .pick({ page: true, pageSize: true, q: true, courseId: true })
  .extend({ status: z.enum(['draft', 'frozen']).optional() });
export const paperCandidateSchema = listSchema
  .pick({ page: true, pageSize: true, q: true })
  .extend({
    bankId: idSchema,
    type: questionTypeSchema.optional(),
    difficulty: z.coerce.number().int().min(1).max(5).optional(),
    tag: z.string().trim().max(40).optional(),
    knowledgePoint: z.string().trim().max(80).optional(),
  });
export const paperDrawSchema = paperCandidateSchema
  .omit({ page: true, pageSize: true, q: true })
  .extend({
    revision: z.number().int().positive(),
    type: questionTypeSchema,
    count: z.number().int().min(1).max(100),
    score: scoreSchema,
  })
  .strict();
export const paperCopySchema = z.object({ name }).strict();
export type PaperCreate = z.infer<typeof paperCreateSchema>;
export type PaperSave = z.infer<typeof paperSaveSchema>;
export type PaperQuery = z.infer<typeof paperQuerySchema>;
export type PaperCandidateQuery = z.infer<typeof paperCandidateSchema>;
export type PaperDraw = z.infer<typeof paperDrawSchema>;
export type PaperSelection = z.infer<typeof paperItemSchema>;
export interface PaperSummary extends PaperCreate {
  id: string;
  ownerId: string;
  ownerName: string;
  courseName: string;
  courseEnabled: boolean;
  revision: number;
  status: 'draft' | 'frozen';
  sourceVersionId: string | null;
  frozenVersionId: string | null;
  frozenAt: string | null;
  digest: string | null;
  itemCount: number;
  totalScore: number;
  updatedAt: string;
}
export interface PaperItem extends PaperSelection {
  questionId: string;
  bankId: string;
  version: number;
  currentVersion: number;
  available: boolean;
  question: QuestionInput;
}
export interface PaperDetail extends PaperSummary {
  items: PaperItem[];
}
export interface PaperCandidate {
  questionId: string;
  versionId: string;
  version: number;
  stem: string;
  type: QuestionInput['content']['type'];
  difficulty: number;
}
