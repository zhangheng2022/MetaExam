import {
  BackupService,
  ordinaryPath,
  loadConfig,
  loadMaintenanceConfig,
  requireAdministrator,
} from '@metaexam/db';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';

export const backupErrorCodes = [
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
  'BACKUP_SPACE_REQUIRED',
  'BACKUP_WRONG_DEVICE',
];
async function secureDirectory(directory: string) {
  await ordinaryPath(directory);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$p=[Console]::In.ReadToEnd(); $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @('S-1-5-18','S-1-5-32-544')) { $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl -ErrorAction Stop",
      ],
      { windowsHide: true, timeout: 10000 },
      (error) => (error ? reject(new Error('BACKUP_ACCESS_DENIED')) : resolve()),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(directory);
  });
}
export async function runBackupMaintenance() {
  requireAdministrator();
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (raw.length > 32768) throw new Error('BACKUP_INVALID');
  }
  const input = JSON.parse(raw) as { operation: string; directory?: string; id?: string };
  if (
    !['create', 'preview', 'restore', 'recover'].includes(input.operation) ||
    Object.keys(input).some((k) => !['operation', 'directory', 'id'].includes(k)) ||
    (input.operation !== 'recover' &&
      (typeof input.directory !== 'string' || !path.isAbsolute(input.directory))) ||
    (input.operation === 'restore' &&
      (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id)))
  )
    throw new Error('BACKUP_INVALID');
  const runtime = loadConfig();
  const config = runtime.database.user === 'metaexam_app' ? loadMaintenanceConfig() : runtime;
  await ordinaryPath(config.home);
  const secrets = path.join(config.home, 'backup-secret');
  await mkdir(secrets, { recursive: true });
  await secureDirectory(secrets);
  const keyPath = path.join(secrets, 'key');
  try {
    await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await ordinaryPath(keyPath);
  const root = process.env.METAEXAM_INSTALL_ROOT;
  const service = new BackupService(config, {
    key: await readFile(keyPath),
    runtimeRole: runtime.database.user,
    secureDirectory,
    bin: root
      ? path.join(root, 'postgres/bin')
      : path.resolve(__dirname, '../../../.tools/pgsql/bin'),
  });
  if (input.operation === 'recover') return service.recover();
  if (input.operation === 'restore') return service.restore(input.directory!, input.id!);
  if (input.operation === 'preview') return service.preview(input.directory!);
  return service.create(input.directory!);
}
