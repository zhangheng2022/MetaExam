import {
  importLicense,
  licenseDetails,
  licenseRequest,
  previewLicenseImport,
  type Database,
} from '@metaexam/db';
import { LicenseError } from '@metaexam/domain';

export type LicenseMaintenanceInput =
  | { operation: 'request' }
  | { operation: 'preview'; raw: string }
  | { operation: 'import'; raw: string; expectedDigest: string | null };

export function parseLicenseMaintenanceInput(value: unknown): LicenseMaintenanceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BAD_FORMAT');
  const v = value as Record<string, unknown>;
  if (v.operation === 'request' && Object.keys(v).length === 1) return { operation: 'request' };
  if (typeof v.raw !== 'string' || Buffer.byteLength(v.raw) > 65536) throw new Error('BAD_FORMAT');
  if (v.operation === 'preview' && Object.keys(v).sort().join(',') === 'operation,raw')
    return { operation: 'preview', raw: v.raw };
  if (
    v.operation === 'import' &&
    Object.keys(v).sort().join(',') === 'expectedDigest,operation,raw' &&
    (v.expectedDigest === null ||
      (typeof v.expectedDigest === 'string' && /^[a-f0-9]{64}$/.test(v.expectedDigest)))
  )
    return { operation: 'import', raw: v.raw, expectedDigest: v.expectedDigest };
  throw new Error('BAD_FORMAT');
}

// Uses the same runtime DB permissions and local verifier as existing maintenance commands.
// The CLI boundary requires Windows elevation before reading protected configuration.
export async function runLicenseMaintenance(db: Database, input: LicenseMaintenanceInput) {
  if (input.operation === 'request') return licenseRequest(db);
  if (input.operation === 'preview') return previewLicenseImport(db, input.raw);
  try {
    return licenseDetails(
      (await importLicense(db, input.raw, { expectedDigest: input.expectedDigest })).payload,
    );
  } catch (error) {
    if (
      error instanceof LicenseError ||
      (error instanceof Error && error.message === 'LICENSE_CHANGED')
    )
      throw error;
    // A lost connection or watermark IO failure may occur after database commit.
    // Do not falsely promise that the previous license remains installed.
    throw new Error('IMPORT_RESULT_UNKNOWN', { cause: error });
  }
}

export async function readLicenseMaintenanceInput() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 512 * 1024) throw new Error('BAD_FORMAT');
    chunks.push(buffer);
  }
  try {
    return parseLicenseMaintenanceInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    throw new Error('BAD_FORMAT');
  }
}
