import { app, dialog, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { LicenseOperations, type MaintenancePreview } from './license-operations';
import type { LicenseDetails } from '@metaexam/contracts';

export function createLicenseOperations(window: BrowserWindow) {
  const root = app.isPackaged
    ? path.resolve(path.dirname(app.getPath('exe')), '..')
    : path.resolve(__dirname, '../../..');
  const config =
    process.env.METAEXAM_CONFIG ??
    path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'MetaExam', 'config.json');
  const run = <T>(input: object) =>
    new Promise<T>((resolve, reject) => {
      const child = execFile(
        path.join(root, app.isPackaged ? 'runtime/node.exe' : '.tools/node/node.exe'),
        [
          path.join(root, app.isPackaged ? 'server/cli.cjs' : 'apps/worker/dist/cli.js'),
          'license-desktop',
        ],
        {
          env: { ...process.env, METAEXAM_CONFIG: config },
          windowsHide: true,
          timeout: 60000,
          maxBuffer: 128 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (error) {
            // Only the operations layer's allowlist can expose a CLI error to the renderer.
            const value = stderr.trim();
            reject(
              new Error(
                /^[A-Z_]+$/.test(value)
                  ? value
                  : 'operation' in input && input.operation === 'import'
                    ? 'IMPORT_RESULT_UNKNOWN'
                    : 'MAINTENANCE_FAILED',
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(stdout) as T);
          } catch {
            reject(
              new Error(
                'operation' in input && input.operation === 'import'
                  ? 'IMPORT_RESULT_UNKNOWN'
                  : 'MAINTENANCE_FAILED',
              ),
            );
          }
        },
      );
      child.stdin?.on('error', () => {
        /* execFile callback owns failure reporting */
      });
      child.stdin?.end(JSON.stringify(input));
    });
  return new LicenseOperations({
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
          { windowsHide: true, timeout: 10000, maxBuffer: 4096, encoding: 'utf8' },
          (error, stdout) =>
            !error && stdout.trim() === 'True'
              ? resolve()
              : reject(new Error('ADMINISTRATOR_REQUIRED')),
        );
      }),
    chooseSave: async () => {
      const result = await dialog.showSaveDialog(window, {
        title: '导出授权申请',
        defaultPath: 'MetaExam-授权申请.mreq',
        filters: [{ name: 'MetaExam 授权申请', extensions: ['mreq'] }],
        properties: ['dontAddToRecent'],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    chooseOpen: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '选择授权文件',
        filters: [{ name: 'MetaExam 授权文件', extensions: ['mlic'] }],
        properties: ['openFile', 'dontAddToRecent'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    request: () => run({ operation: 'request' }),
    preview: (raw) => run<MaintenancePreview>({ operation: 'preview', raw }),
    import: (raw, expectedDigest) =>
      run<LicenseDetails>({ operation: 'import', raw, expectedDigest }),
  });
}
