import { z } from 'zod';
import type { QuestionInput } from './questions';
export const importConfirmSchema = z.object({ duplicatePolicy: z.enum(['skip', 'keep']) }).strict();
export type ImportStatus = 'pending' | 'processing' | 'ready' | 'queued' | 'completed' | 'failed';
export interface ImportSummary {
  id: string;
  bankId: string;
  filename: string;
  status: ImportStatus;
  total: number;
  errors: number;
  duplicates: number;
  imported: number;
  skipped: number;
  errorCode: string | null;
  duplicatePolicy: 'skip' | 'keep' | null;
  createdAt: string;
  expiresAt: string;
}
export interface ImportRow {
  rowNumber: number;
  question: QuestionInput | null;
  errors: string[];
  duplicate: boolean;
  questionId: string | null;
}
export interface ImageAttachment {
  id: string;
  width: number;
  height: number;
  bytes: number;
}
