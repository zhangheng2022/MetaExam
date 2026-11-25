import { z } from 'zod';
import { idSchema, listSchema } from './management';
export const questionTypeSchema = z.enum(['single', 'multiple', 'boolean', 'blank', 'essay']);
const text = (max: number) =>
  z.string().trim().min(1, '内容不能为空').max(max, `内容不能超过 ${max} 个字符`);
const option = z.object({ id: idSchema, text: text(2000) }).strict();
const choice = {
  options: z.array(option).min(2, '至少填写两个选项').max(8, '最多填写八个选项'),
  answer: z.array(idSchema).min(1, '请选择正确答案').max(8, '答案数量不能超过八个'),
};
export const questionContentSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('single'), ...choice }).strict(),
    z.object({ type: z.literal('multiple'), ...choice }).strict(),
    z.object({ type: z.literal('boolean'), answer: z.boolean() }).strict(),
    z
      .object({
        type: z.literal('blank'),
        blanks: z
          .array(
            z
              .object({
                id: idSchema,
                answers: z
                  .array(
                    z
                      .string()
                      .min(1, '填空候选答案不能为空')
                      .max(200, '每个填空候选答案最多 200 个字符')
                      .refine((v) => v.trim().length > 0, '填空候选答案不能只有空白'),
                  )
                  .min(1)
                  .max(10, '每空最多 10 个候选答案'),
              })
              .strict(),
          )
          .min(1)
          .max(20),
        caseSensitive: z.boolean(),
        trimWhitespace: z.boolean(),
      })
      .strict(),
    z.object({ type: z.literal('essay'), referenceAnswer: text(8000) }).strict(),
  ])
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.type === 'single' || v.type === 'multiple') {
      const ids = new Set(v.options.map((o) => o.id));
      if (
        ids.size !== v.options.length ||
        new Set(v.answer).size !== v.answer.length ||
        v.answer.some((id) => !ids.has(id))
      )
        issue('选项标识和答案必须唯一且对应');
      if (new Set(v.options.map((o) => o.text)).size !== v.options.length)
        issue('选项内容不能重复');
      if (v.type === 'single' && v.answer.length !== 1) issue('单选题只能有一个答案');
      if (v.type === 'multiple' && v.answer.length < 2) issue('多选题至少有两个答案');
    }
    if (v.type === 'blank' && new Set(v.blanks.map((b) => b.id)).size !== v.blanks.length)
      issue('填空标识不能重复');
  });
export const questionInputSchema = z
  .object({
    stem: text(8000),
    content: questionContentSchema,
    explanation: z.string().trim().max(8000).default(''),
    difficulty: z.number().int().min(1).max(5),
    tags: z
      .array(text(40))
      .max(10, '最多 10 个标签')
      .refine((v) => new Set(v).size === v.length, '标签不能重复'),
    knowledgePoints: z
      .array(text(80))
      .max(10, '最多 10 个知识点')
      .refine((v) => new Set(v).size === v.length, '知识点不能重复'),
    images: z
      .array(
        z
          .object({ id: idSchema, alt: z.string().trim().min(1, '请填写图片说明').max(200) })
          .strict(),
      )
      .max(6)
      .refine((v) => new Set(v.map((x) => x.id)).size === v.length, '图片不能重复')
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(v)).length > 48000)
      ctx.addIssue({ code: 'custom', message: '题目总内容不能超过 48 KB' });
    if (
      v.content.type === 'blank' &&
      (v.stem.match(/\[\[blank\]\]/g) ?? []).length !== v.content.blanks.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['stem'],
        message: '题干中的 [[blank]] 数量须与空位数量一致',
      });
  });
export const questionEditSchema = z
  .object({ revision: z.number().int().positive(), question: questionInputSchema })
  .strict();
export const bankCreateSchema = z
  .object({
    name: text(100),
    description: z.string().trim().max(500).default(''),
    courseId: idSchema,
    visibility: z.enum(['public', 'private']),
  })
  .strict();
export const bankEditSchema = bankCreateSchema
  .pick({ name: true, description: true })
  .extend({ revision: z.number().int().positive(), archived: z.boolean() });
export const archiveQuestionSchema = z
  .object({ revision: z.number().int().positive(), archived: z.boolean() })
  .strict();
export const bankQuerySchema = listSchema
  .pick({ page: true, pageSize: true, q: true, courseId: true })
  .extend({
    archived: z.enum(['true', 'false']).optional(),
    visibility: z.enum(['public', 'private']).optional(),
  });
export const questionQuerySchema = listSchema.pick({ page: true, pageSize: true, q: true }).extend({
  type: questionTypeSchema.optional(),
  difficulty: z.coerce.number().int().min(1).max(5).optional(),
  tag: z.string().trim().max(40).optional(),
  knowledgePoint: z.string().trim().max(80).optional(),
  archived: z.enum(['true', 'false']).optional(),
});
export type QuestionInput = z.infer<typeof questionInputSchema>;
export type QuestionContent = z.infer<typeof questionContentSchema>;
export type BankInput = z.infer<typeof bankCreateSchema>;
export type BankEdit = z.infer<typeof bankEditSchema>;
export type BankQuery = z.infer<typeof bankQuerySchema>;
export type QuestionQuery = z.infer<typeof questionQuerySchema>;
export interface QuestionBank extends BankInput {
  id: string;
  ownerId: string;
  ownerName: string;
  courseName: string;
  archived: boolean;
  revision: number;
  canEdit: boolean;
  courseEnabled: boolean;
  questionCount: number;
}
export interface QuestionSummary {
  id: string;
  bankId: string;
  version: number;
  revision: number;
  archived: boolean;
  stem: string;
  type: QuestionContent['type'];
  difficulty: number;
  tags: string[];
  knowledgePoints: string[];
  updatedAt: string;
}
export interface QuestionVersion {
  id: string;
  questionId: string;
  version: number;
  question: QuestionInput;
  createdAt: string;
  authorName: string;
}
export interface QuestionDetail extends QuestionSummary {
  current: QuestionVersion;
}
