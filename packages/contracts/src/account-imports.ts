export interface AccountImportInput {
  row: number;
  username: string;
  displayName: string;
  role: string;
  classCode: string;
  password: string;
}
export interface AccountImportRow {
  row: number;
  username: string;
  displayName: string;
  role: string;
  classCode: string;
  action: 'create' | 'member' | 'skip';
  errors: string[];
}
export interface AccountImportPreview {
  id: string;
  expiresAt: string;
  rows: AccountImportRow[];
}
export interface AccountImportResult {
  created: number;
  added: number;
  skipped: number;
}
