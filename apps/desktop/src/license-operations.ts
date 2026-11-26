import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type {
  LicenseDetails,
  LicenseImportPreview,
  LicenseOperationResult,
  LicenseSummary,
} from '@metaexam/contracts';

export interface MaintenancePreview {
  candidate: LicenseDetails;
  current: LicenseSummary;
  expectedDigest: string | null;
}
export interface LicenseOperationsDependencies {
  authorize(): Promise<void>;
  chooseSave(): Promise<string | null>;
  chooseOpen(): Promise<string | null>;
  request(): Promise<unknown>;
  preview(raw: string): Promise<MaintenancePreview>;
  import(raw: string, expectedDigest: string | null): Promise<LicenseDetails>;
  now?: () => number;
}
const safeCodes = new Set([
  'ADMINISTRATOR_REQUIRED',
  'BAD_FORMAT',
  'UNKNOWN_KEY',
  'BAD_SIGNATURE',
  'WRONG_PRODUCT',
  'WRONG_INSTANCE',
  'WRONG_DEVICE',
  'VERSION_MISMATCH',
  'EXPIRED',
  'NOT_YET_VALID',
  'STALE_SEQUENCE',
  'SEQUENCE_CONFLICT',
  'CLOCK_ANOMALY',
  'LICENSE_CHANGED',
  'IMPORT_RESULT_UNKNOWN',
  'MAINTENANCE_FAILED',
  'FILE_TOO_LARGE',
  'FILE_UNAVAILABLE',
  'FILE_EXISTS',
  'PREVIEW_EXPIRED',
  'OPERATION_BUSY',
]);
function code(error: unknown) {
  const value = error instanceof Error ? error.message : '';
  return safeCodes.has(value) ? value : 'MAINTENANCE_FAILED';
}
export class LicenseOperations {
  private pending = false;
  private revision = 0;
  private selected?: { id: string; raw: string; expectedDigest: string | null; expiresAt: number };
  constructor(private readonly deps: LicenseOperationsDependencies) {}
  clear() {
    this.revision++;
    this.selected = undefined;
  }
  cancel(id: unknown) {
    if (this.selected?.id === id) this.clear();
  }
  private async perform<T>(
    action: () => Promise<LicenseOperationResult<T>>,
  ): Promise<LicenseOperationResult<T>> {
    if (this.pending) return { status: 'error', code: 'OPERATION_BUSY' };
    this.pending = true;
    try {
      await this.deps.authorize();
      return await action();
    } catch (error) {
      return { status: 'error', code: code(error) };
    } finally {
      this.pending = false;
    }
  }
  exportRequest() {
    return this.perform<{ fileName: string }>(async () => {
      const file = await this.deps.chooseSave();
      if (!file) return { status: 'cancelled' };
      const request = await this.deps.request();
      let handle;
      try {
        handle = await open(file, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(request, null, 2), 'utf8');
      } catch (error) {
        throw new Error(
          (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'FILE_EXISTS' : 'FILE_UNAVAILABLE',
          { cause: error },
        );
      } finally {
        await handle?.close();
      }
      return { status: 'success', value: { fileName: path.basename(file) } };
    });
  }
  preview() {
    return this.perform<LicenseImportPreview>(async () => {
      this.clear();
      const revision = this.revision;
      const file = await this.deps.chooseOpen();
      if (!file) return { status: 'cancelled' };
      let raw: string;
      let handle;
      try {
        handle = await open(file, 'r');
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('FILE_UNAVAILABLE');
        if (info.size > 65536) throw new Error('FILE_TOO_LARGE');
        // Bounded read also covers a file growing after stat().
        const buffer = Buffer.alloc(65537);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > 65536) throw new Error('FILE_TOO_LARGE');
        try {
          raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
        } catch (error) {
          throw new Error('BAD_FORMAT', { cause: error });
        }
      } catch (error) {
        if (error instanceof Error && safeCodes.has(error.message)) throw error;
        throw new Error('FILE_UNAVAILABLE', { cause: error });
      } finally {
        await handle?.close();
      }
      const result = await this.deps.preview(raw);
      if (revision !== this.revision) throw new Error('PREVIEW_EXPIRED');
      const id = randomUUID();
      this.selected = {
        id,
        raw,
        expectedDigest: result.expectedDigest,
        expiresAt: (this.deps.now?.() ?? Date.now()) + 600000,
      };
      return {
        status: 'success',
        value: {
          id,
          fileName: path.basename(file),
          current: result.current,
          candidate: result.candidate,
        },
      };
    });
  }
  confirm(id: unknown) {
    return this.perform<LicenseDetails>(async () => {
      const selected = this.selected;
      this.clear();
      if (
        typeof id !== 'string' ||
        !selected ||
        id !== selected.id ||
        (this.deps.now?.() ?? Date.now()) >= selected.expiresAt
      )
        throw new Error('PREVIEW_EXPIRED');
      // Import the exact previewed bytes; never reread a potentially replaced file.
      const value = await this.deps.import(selected.raw, selected.expectedDigest);
      return { status: 'success', value };
    });
  }
}
