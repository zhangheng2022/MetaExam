import { app, dialog, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { BackupOperations } from './backup-operations';

export function createBackupOperations(window: BrowserWindow) {
  const root = app.isPackaged
    ? path.resolve(path.dirname(app.getPath('exe')), '..')
    : path.resolve(__dirname, '../../..');
  return new BackupOperations({
    authorize: () =>
      new Promise<void>((resolve, reject) => {
        execFile(
          path.join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32/WindowsPowerShell/v1.0/powershell.exe',
          ),
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
          ],
          { windowsHide: true, timeout: 10000, encoding: 'utf8' },
          (error, stdout) =>
            !error && stdout.trim() === 'True'
              ? resolve()
              : reject(new Error('ADMINISTRATOR_REQUIRED')),
        );
      }),
    choose: async (operation) => {
      const result = await dialog.showOpenDialog(window, {
        title: operation === 'create' ? '选择备份保存位置' : '选择 MetaExam 备份文件夹',
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    run: <T>(input: object) =>
      new Promise<T>((resolve, reject) => {
        const unknown =
          'operation' in input && ['restore', 'recover'].includes(String(input.operation))
            ? 'RESTORE_RESULT_UNKNOWN'
            : 'BACKUP_FAILED';
        const child = execFile(
          path.join(root, app.isPackaged ? 'runtime/node.exe' : '.tools/node/node.exe'),
          [
            path.join(root, app.isPackaged ? 'server/cli.cjs' : 'apps/worker/dist/cli.js'),
            'backup-desktop',
          ],
          {
            windowsHide: true,
            timeout: 35 * 60 * 1000,
            maxBuffer: 32768,
            encoding: 'utf8',
            env: {
              ...process.env,
              METAEXAM_CONFIG:
                process.env.METAEXAM_CONFIG ??
                path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'MetaExam/config.json'),
              ...(app.isPackaged ? { METAEXAM_INSTALL_ROOT: root } : {}),
            },
          },
          (error, stdout, stderr) => {
            if (error) {
              const code = stderr.trim();
              reject(
                new Error(/^[A-Z_]+$/.test(code) && code !== 'BACKUP_FAILED' ? code : unknown),
              );
              return;
            }
            try {
              resolve(JSON.parse(stdout) as T);
            } catch {
              reject(new Error(unknown));
            }
          },
        );
        child.stdin?.on('error', () => {});
        child.stdin?.end(JSON.stringify(input));
      }),
  });
}
