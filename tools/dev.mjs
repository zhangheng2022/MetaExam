import concurrently from 'concurrently';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.resolve(
  process.env.METAEXAM_CONFIG ?? path.join(root, '.local/config.json'),
);
if (!existsSync(configPath)) throw new Error('Run db:start and db:migrate first; see README.md.');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const pnpm = path.join(root, '.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs');
// Build frontend type declarations once. Vite serves shared UI source via the
// development export condition, so later UI edits use its normal React HMR.
execFileSync(process.execPath, [pnpm, '--filter', '@metaexam/ui...', 'build'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
const env = {
  ...process.env,
  METAEXAM_CONFIG: configPath,
  METAEXAM_API_PORT: String(config.api.port),
};
const { result } = concurrently(
  [
    { name: 'server', command: 'pnpm run dev:backend', env },
    { name: 'web', command: 'pnpm --filter @metaexam/web dev', env },
  ],
  { cwd: root, killOthersOn: ['failure', 'success'], prefix: 'name' },
);
try {
  await result;
} catch {
  process.exitCode = 1;
}
