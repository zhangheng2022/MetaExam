import { z } from 'zod';
import { passwordSchema } from './password';
export const roleSchema = z.enum(['admin', 'teacher', 'student']);
export const idSchema = z.string().uuid();
const name = z.string().trim().min(1).max(100);
const revision = z.number().int().positive();
const roles = z
  .array(roleSchema)
  .min(1)
  .max(3)
  .refine((v) => new Set(v).size === v.length);
export const userCreateSchema = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9._-]{3,64}$/),
    displayName: name,
    password: passwordSchema,
    roles,
  })
  .strict();
export const userEditSchema = z
  .object({ displayName: name, enabled: z.boolean(), roles, revision })
  .strict();
export const resetPasswordSchema = z.object({ password: passwordSchema, revision }).strict();
export const organizationSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9._-]+$/),
    name,
  })
  .strict();
export const organizationEditSchema = organizationSchema.extend({ enabled: z.boolean(), revision });
export const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).default(''),
    enabled: z.enum(['true', 'false']).optional(),
    role: roleSchema.optional(),
    classId: idSchema.optional(),
    courseId: idSchema.optional(),
  })
  .strict();
export const assignmentSchema = z
  .object({ teacherId: idSchema, courseId: idSchema, classId: idSchema })
  .strict();
export const memberSchema = z.object({ studentId: idSchema }).strict();
export const auditQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).default(''),
    outcome: z.enum(['success', 'failure', 'issued']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to);
export type RoleCode = z.infer<typeof roleSchema>;
export type UserCreate = z.infer<typeof userCreateSchema>;
export type UserEdit = z.infer<typeof userEditSchema>;
export type OrganizationInput = z.infer<typeof organizationSchema>;
export type OrganizationEdit = z.infer<typeof organizationEditSchema>;
export type ListQuery = z.infer<typeof listSchema>;
export type AuditQuery = z.infer<typeof auditQuerySchema>;
export type AssignmentInput = z.infer<typeof assignmentSchema>;
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface ManagedUser {
  id: string;
  username: string;
  displayName: string;
  enabled: boolean;
  roles: RoleCode[];
  revision: number;
  mustChangePassword: boolean;
  createdAt: string;
}
export interface Organization {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  revision: number;
  memberCount: number;
  createdAt: string;
}
export interface Assignment extends AssignmentInput {
  teacherName: string;
  courseName: string;
  className: string;
  teacherEnabled: boolean;
  courseEnabled: boolean;
  classEnabled: boolean;
}
export interface AuditEvent {
  id: string;
  actorName: string | null;
  event: string;
  outcome: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  requestId: string;
  createdAt: string;
}
export interface MyTeaching {
  classes: Organization[];
  assignments: Assignment[];
}
