import { app, dialog, net, type BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { collectDiagnostics, DiagnosticOperations, saveDiagnostics } from './diagnostics';

export function createDiagnosticOperations(window: BrowserWindow, endpoint: () => string) {
  const root = app.isPackaged
    ? path.resolve(path.dirname(app.getPath('exe')), '..')
    : path.resolve(__dirname, '../../..');
  let home: string | undefined = path.join(
    process.env.ProgramData ?? 'C:\\ProgramData',
    'MetaExam/runtime',
  );
  if (!app.isPackaged) {
    home = path.resolve(process.env.METAEXAM_HOME ?? path.join(root, '.local'));
    if (process.env.METAEXAM_CONFIG) {
      try {
        const config = JSON.parse(readFileSync(process.env.METAEXAM_CONFIG, 'utf8')) as {
          home?: unknown;
        };
        home =
          typeof config.home === 'string' && path.isAbsolute(config.home) ? config.home : undefined;
      } catch {
        home = undefined;
      }
    }
  }
  return new DiagnosticOperations({
    collect: () =>
      collectDiagnostics({
        endpoint,
        home,
        fetcher: (url, options) => net.fetch(url, options),
        managerVersion: app.getVersion(),
        runtime: {
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
        },
      }),
    choose: async () => {
      const result = await dialog.showSaveDialog(window, {
        title: '导出诊断报告',
        defaultPath:
          'MetaExam-diagnostics-' + new Date().toISOString().replaceAll(':', '-') + '.json',
        filters: [{ name: '诊断报告', extensions: ['json'] }],
        properties: ['dontAddToRecent'],
      });
      return result.canceled ? undefined : result.filePath;
    },
    save: (file, report) =>
      saveDiagnostics(file, report, [
        root,
        ...(home ? [app.isPackaged ? path.dirname(home) : home] : []),
        ...(process.env.METAEXAM_CONFIG
          ? [path.dirname(path.resolve(process.env.METAEXAM_CONFIG))]
          : []),
      ]),
  });
}
