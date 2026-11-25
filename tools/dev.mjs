import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const root = path.resolve(import.meta.dirname, '..'),
  config = path.join(root, '.local/config.json');
const c = JSON.parse(readFileSync(config, 'utf8'));
const env = { ...process.env, METAEXAM_CONFIG: config, METAEXAM_API_PORT: String(c.api.port) };
const children = [];
const run = (file, args = []) => {
  const p = spawn(process.execPath, [file, ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  children.push(p);
  return p;
};
run('apps/api/dist/main.js');
run('apps/worker/dist/main.js');
run('.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs', ['--filter', '@metaexam/web', 'dev']);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const p of children) {
    if (p.pid)
      spawn('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
  }
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of children)
  p.on('exit', (code) => {
    if (!stopping) {
      stop();
      process.exitCode = code ?? 1;
    }
  });
