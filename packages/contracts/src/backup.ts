export interface BackupInfo {
  id: string;
  createdAt: string;
  schemaVersion: number;
  fileCount: number;
  bytes: number;
}
export type BackupResult<T> =
  | { status: 'success'; value: T }
  | { status: 'cancelled' }
  | { status: 'error'; code: string };
export interface BackupBridge {
  createBackup(): Promise<BackupResult<BackupInfo>>;
  previewRestore(): Promise<BackupResult<BackupInfo & { previewId: string }>>;
  confirmRestore(id: string): Promise<BackupResult<{ restored: true }>>;
  cancelRestore(id: string): Promise<void>;
  recoverRestore(): Promise<BackupResult<{ recovered: boolean }>>;
}
