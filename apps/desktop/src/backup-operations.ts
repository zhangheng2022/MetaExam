import { randomUUID } from 'node:crypto';
import type { BackupInfo, BackupResult } from '@metaexam/contracts';

type Dependencies = {
  authorize: () => Promise<void>;
  choose: (operation: 'create' | 'preview') => Promise<string | null>;
  run: <T>(input: object) => Promise<T>;
};
const codes = new Set([
  'ADMINISTRATOR_REQUIRED',
  'BACKUP_INVALID',
  'BACKUP_UNTRUSTED',
  'BACKUP_INCOMPATIBLE',
  'BACKUP_CHANGED',
  'BACKUP_WRONG_INSTANCE',
  'BACKUP_UNSAFE_PATH',
  'BACKUP_ATTACHMENT_MISSING',
  'BACKUP_INITIALIZATION_ROLLBACK',
  'BACKUP_DATABASE_TOOL_FAILED',
  'EXAMS_ACTIVE',
  'SERVICES_RUNNING',
  'MAINTENANCE_REQUIRED',
  'OPERATION_BUSY',
  'RESTORE_RECOVERY_REQUIRED',
  'BACKUP_FAILED',
  'RESTORE_RESULT_UNKNOWN',
  'PREVIEW_EXPIRED',
  'BACKUP_SPACE_REQUIRED',
  'BACKUP_WRONG_DEVICE',
]);
export class BackupOperations {
  private pending = false;
  private generation = 0;
  private selection?: { id: string; directory: string; backupId: string; expires: number };
  constructor(private readonly deps: Dependencies) {}
  clear() {
    this.generation++;
    this.selection = undefined;
  }
  cancel(id: unknown) {
    if (this.selection?.id === id) this.clear();
  }
  private async perform<T>(action: () => Promise<BackupResult<T>>): Promise<BackupResult<T>> {
    if (this.pending) return { status: 'error', code: 'OPERATION_BUSY' };
    this.pending = true;
    try {
      await this.deps.authorize();
      return await action();
    } catch (error) {
      return {
        status: 'error',
        code: error instanceof Error && codes.has(error.message) ? error.message : 'BACKUP_FAILED',
      };
    } finally {
      this.pending = false;
    }
  }
  create() {
    return this.perform(async () => {
      const directory = await this.deps.choose('create');
      if (!directory) return { status: 'cancelled' };
      return {
        status: 'success',
        value: await this.deps.run<BackupInfo>({ operation: 'create', directory }),
      };
    });
  }
  preview() {
    return this.perform(async () => {
      this.clear();
      const generation = this.generation;
      const directory = await this.deps.choose('preview');
      if (!directory) return { status: 'cancelled' };
      const value = await this.deps.run<BackupInfo>({ operation: 'preview', directory });
      if (generation !== this.generation) return { status: 'cancelled' };
      const id = randomUUID();
      this.selection = { id, directory, backupId: value.id, expires: Date.now() + 10 * 60 * 1000 };
      return { status: 'success', value: { ...value, previewId: id } };
    });
  }
  confirm(id: unknown) {
    return this.perform(async () => {
      const selection = this.selection;
      this.clear();
      if (!selection || selection.id !== id || selection.expires < Date.now())
        throw new Error('PREVIEW_EXPIRED');
      return {
        status: 'success',
        value: await this.deps.run<{ restored: true }>({
          operation: 'restore',
          directory: selection.directory,
          id: selection.backupId,
        }),
      };
    });
  }
  recover() {
    return this.perform(async () => ({
      status: 'success',
      value: await this.deps.run<{ recovered: boolean }>({ operation: 'recover' }),
    }));
  }
}
