import type { LicenseSummary } from './index';

export interface LicenseDetails {
  licenseId: string;
  sequence: number;
  notBefore: string;
  expiresAt: string | null;
  maxConcurrentAttempts: number;
  features: string[];
}
export interface LicenseImportPreview {
  id: string;
  fileName: string;
  current: LicenseSummary;
  candidate: LicenseDetails;
}
export type LicenseOperationResult<T> =
  | { status: 'success'; value: T }
  | { status: 'cancelled' }
  | { status: 'error'; code: string };

export interface LicenseManagerBridge {
  exportLicenseRequest(): Promise<LicenseOperationResult<{ fileName: string }>>;
  previewLicenseImport(): Promise<LicenseOperationResult<LicenseImportPreview>>;
  confirmLicenseImport(id: string): Promise<LicenseOperationResult<LicenseDetails>>;
  cancelLicenseImport(id: string): Promise<void>;
}
