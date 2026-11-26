export type DiagnosticProbeState = 'ok' | 'http_error' | 'unreachable' | 'invalid_response';
export interface DiagnosticProbe {
  state: DiagnosticProbeState;
  httpStatus: number | null;
}
export type DiagnosticFileState = 'present' | 'absent' | 'unknown';
export interface DiagnosticReport {
  format: 1;
  product: 'MetaExam';
  createdAt: string;
  managerVersion: string | null;
  runtime: {
    platform: string;
    arch: string;
    node: string | null;
    electron: string | null;
    chrome: string | null;
  };
  checks: { live: DiagnosticProbe; ready: DiagnosticProbe; system: DiagnosticProbe };
  system: {
    version: string | null;
    database: 'ready' | 'unavailable' | 'unknown';
    worker: 'online' | 'offline' | 'unknown';
    adminInitialized: boolean | null;
    schemaVersion: number | null;
    license:
      | 'unactivated'
      | 'valid'
      | 'expired'
      | 'not_yet_valid'
      | 'invalid'
      | 'clock_anomaly'
      | 'unknown';
  };
  maintenance: { upgrade: DiagnosticFileState; operation: DiagnosticFileState };
}
export type DiagnosticResult<T> =
  | { status: 'success'; value: T }
  | {
      status: 'error';
      code: 'BUSY' | 'CHECK_FAILED' | 'SAVE_FAILED' | 'FILE_EXISTS' | 'UNSAFE_PATH';
    };
export interface DiagnosticBridge {
  checkDiagnostics(): Promise<DiagnosticResult<DiagnosticReport>>;
  exportDiagnostics(): Promise<DiagnosticResult<DiagnosticReport> | { status: 'cancelled' }>;
}
