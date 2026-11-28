import concurrently from 'concurrently';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.resolve(
  process.env.METAEXAM_CONFIG ?? path.join(root, '.local/config.json'),
);
if (!existsSync(configPath)) throw new Error('Run db:start and db:migrate first; see README.md.');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const pnpm = path.join(root, '.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs');
if (process.argv.includes('--desktop')) {
  const endpoint = `http://127.0.0.1:${config.api.port}`;
  console.log('Waiting for API startup before opening Electron...');
  while (true) {
    try {
      const response = await fetch(endpoint + '/health/live', {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok && (await response.json()).status === 'alive') break;
    } catch {
      // The TypeScript watcher may still be compiling or waiting for a correction.
    }
    await delay(300);
  }
  execFileSync(process.execPath, [pnpm, '--filter', '@metaexam/desktop', 'start'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
} else {
  const webOnly = process.argv.includes('--web-only');
  // Build frontend type declarations once. Vite serves shared UI source via the
  // development export condition, so later UI edits use its normal React HMR.
  execFileSync(
    process.execPath,
    [pnpm, '--filter', webOnly ? '@metaexam/ui...' : '@metaexam/desktop...', 'build'],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  const env = {
    ...process.env,
    METAEXAM_CONFIG: configPath,
    METAEXAM_API_PORT: String(config.api.port),
    METAEXAM_WEB_PORT: process.env.METAEXAM_WEB_PORT ?? String(config.api.webPort ?? 5173),
  };
  const { result } = concurrently(
    [
      { name: 'server', command: 'pnpm run dev:backend', env },
      { name: 'web', command: 'pnpm --filter @metaexam/web dev', env },
      ...(!webOnly ? [{ name: 'desktop', command: 'node tools/dev.mjs --desktop', env }] : []),
    ],
    { cwd: root, killOthersOn: ['failure'], prefix: 'name' },
  );
  try {
    await result;
  } catch {
    process.exitCode = 1;
  }
}
