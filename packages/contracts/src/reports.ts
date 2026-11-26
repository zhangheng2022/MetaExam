import { z } from 'zod';
export const reportSettingsSchema = z
  .object({ passPercent: z.coerce.number().int().min(0).max(100).default(60) })
  .strict();
export const reportFiltersSchema = reportSettingsSchema
  .extend({
    q: z.string().trim().max(100).default(''),
    status: z.enum(['all', 'passed', 'failed', 'absent']).default('all'),
    sort: z.enum(['username', 'score_desc', 'score_asc']).default('username'),
  })
  .strict();
export const reportQuerySchema = reportFiltersSchema
  .extend({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ReportFilters = z.infer<typeof reportFiltersSchema>;
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export interface ResultRecord {
  id: string;
  username: string;
  displayName: string;
  score: number | null;
  status: 'passed' | 'failed' | 'absent';
  submittedAt: string | null;
}
export interface ResultStatistics {
  rosterCount: number;
  presentCount: number;
  absentCount: number;
  average: number | null;
  median: number | null;
  highest: number | null;
  lowest: number | null;
  passedCount: number;
  passRate: number | null;
  passPercent: number;
  passScore: number;
  distribution: { label: string; count: number }[];
}
export interface QuestionStatistics {
  position: number;
  type: 'single' | 'multiple' | 'boolean' | 'blank' | 'essay';
  maxScore: number;
  gradedCount: number;
  average: number | null;
  scoreRate: number | null;
  fullCount: number;
  zeroCount: number;
}
export interface ExamReport {
  examId: string;
  name: string;
  courseName: string;
  publishedAt: string;
  maxScore: number;
  statistics: ResultStatistics;
  questions: QuestionStatistics[];
}
export interface ResultExport {
  report: ExamReport;
  filters: ReportFilters;
  records: ResultRecord[];
  generatedAt: string;
}
