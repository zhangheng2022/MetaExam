import { z } from 'zod';

export const licenseRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal('MetaExam'),
    requestId: z.string().uuid(),
    installationId: z.string().uuid(),
    fingerprintVersion: z.literal(1),
    deviceHash: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprintMode: z.string().min(1).max(64),
    appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();
export type LicenseRequest = z.infer<typeof licenseRequestSchema>;
export const issuerEnvironmentSchema = z.enum(['test', 'production']);
export type IssuerEnvironment = z.infer<typeof issuerEnvironmentSchema>;
export const issuerCustomerSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(128),
    note: z.string().max(1000),
  })
  .strict();
export const issuerDraftSchema = z
  .object({
    requestId: z.string().uuid(),
    kid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    packageId: z.string().min(1).max(128),
    environment: issuerEnvironmentSchema,
    notBefore: z.string().datetime().nullable(),
    expiresAt: z.string().datetime().nullable(),
    permanentConfirmed: z.boolean(),
    maxConcurrentAttempts: z.number().int().min(1).max(100000),
    minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    maxAppMajor: z.number().int().nonnegative(),
  })
  .strict();
export type IssuerDraft = z.infer<typeof issuerDraftSchema>;
export const issuerTrustSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal('MetaExam'),
    environment: issuerEnvironmentSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    keys: z
      .array(
        z
          .object({
            kid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
            publicKey: z.string().max(4096),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type IssuerTrust = z.infer<typeof issuerTrustSchema>;
export interface IssuerSnapshot {
  ledgerId: string;
  reviewRequired: boolean;
  customers: { id: string; name: string; note: string }[];
  instances: {
    id: string;
    customerId: string;
    deviceHash: string;
    floor: number;
    reconciled: boolean;
  }[];
  requests: LicenseRequest[];
  keys: { kid: string; environment: IssuerEnvironment; fingerprint: string; enabled: boolean }[];
  packages: { id: string; environment: IssuerEnvironment; version: string; kids: string[] }[];
  licenses: {
    id: string;
    instanceId: string;
    kid: string;
    sequence: number;
    createdAt: string;
    payload: import('./index').LicensePayload;
    digest: string;
  }[];
}
export interface IssuerPreview {
  id: string;
  operationId: string;
  payload: import('./index').LicensePayload;
  previous: import('./index').LicensePayload | null;
}
export type IssuerResult<T = unknown> = { ok: true; value: T } | { ok: false; code: string };
export interface IssuerBridge {
  status(): Promise<IssuerResult<{ unlocked: boolean; initialized: boolean }>>;
  unlock(password: string): Promise<IssuerResult>;
  lock(): Promise<IssuerResult>;
  snapshot(): Promise<IssuerResult<IssuerSnapshot>>;
  saveCustomer(input: z.infer<typeof issuerCustomerSchema>): Promise<IssuerResult>;
  importRequest(customerId: string): Promise<IssuerResult>;
  createKey(environment: IssuerEnvironment): Promise<IssuerResult>;
  importTestKey(): Promise<IssuerResult>;
  disableKey(kid: string): Promise<IssuerResult>;
  exportTrust(kid: string, version: string): Promise<IssuerResult>;
  importTrust(): Promise<IssuerResult>;
  importLegacyTrust(version: string): Promise<IssuerResult>;
  setFloor(
    instanceId: string,
    floor: number,
    reason: string,
    neverIssued: boolean,
  ): Promise<IssuerResult>;
  importHistory(): Promise<IssuerResult>;
  preview(draft: IssuerDraft): Promise<IssuerResult<IssuerPreview>>;
  confirm(id: string, operationId: string): Promise<IssuerResult<{ id: string }>>;
  cancelPreview(): Promise<IssuerResult>;
  exportLicense(id: string): Promise<IssuerResult>;
  changePassword(password: string): Promise<IssuerResult>;
  backup(password: string): Promise<IssuerResult>;
  restore(password: string): Promise<IssuerResult>;
  completeReview(note: string): Promise<IssuerResult>;
}
