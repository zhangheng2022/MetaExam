import { z } from 'zod';

export const licenseHeaderSchema = z
  .object({
    typ: z.literal('MetaExam-License-v1'),
    alg: z.literal('Ed25519'),
    kid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  })
  .strict();
export const licensePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal('MetaExam'),
    licenseId: z.string().min(1).max(128),
    customerId: z.string().min(1).max(128),
    installationId: z.string().uuid(),
    fingerprintVersion: z.literal(1),
    deviceHash: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().positive().safe(),
    issuedAt: z.string().datetime(),
    notBefore: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    maxConcurrentAttempts: z.number().int().min(1).max(100000),
    features: z
      .array(z.string().regex(/^[a-z][a-z0-9.]{1,63}$/))
      .min(1)
      .max(100)
      .refine((v) => new Set(v).size === v.length),
    minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    maxAppMajor: z.number().int().nonnegative(),
  })
  .strict();
export type LicensePayload = z.infer<typeof licensePayloadSchema>;
export type LicenseState =
  | 'unactivated'
  | 'valid'
  | 'expired'
  | 'not_yet_valid'
  | 'invalid'
  | 'clock_anomaly';
export interface LicenseSummary {
  state: LicenseState;
  expiresAt: string | null;
  maxConcurrentAttempts: number | null;
  features: string[];
  errorCode?: string;
}
export interface SystemStatus {
  product: 'MetaExam';
  version: string;
  initialized: boolean;
  adminInitialized: boolean;
  database: 'ready' | 'unavailable';
  schemaVersion: number;
  worker: 'online' | 'offline';
  checkedAt: string;
  license: LicenseSummary;
  stage: 'phase1';
}
export const jobRequestSchema = z
  .object({
    businessKey: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    message: z.string().min(1).max(500),
  })
  .strict();

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,64}$/);
export const passwordSchema = z.string().min(12).max(128);
export const administratorSchema = z
  .object({
    username: usernameSchema,
    displayName: z.string().trim().min(1).max(100),
    password: passwordSchema,
  })
  .strict();
export const loginSchema = z
  .object({ username: usernameSchema, password: z.string().min(1).max(128) })
  .strict();
export const changePasswordSchema = z
  .object({ oldPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .strict();
export type AdministratorInput = z.infer<typeof administratorSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  mustChangePassword: boolean;
}
export interface SetupStatus {
  database: 'ready' | 'unavailable';
  adminInitialized: boolean;
}
export interface ApiError {
  code: string;
  message: string;
  requestId: string;
}
export * from './management';
export * from './questions';
