import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const outputs = [
  'apps/api/dist',
  'apps/worker/dist',
  'apps/web/dist',
  'apps/desktop/dist',
  'apps/desktop/renderer-dist',
  'apps/issuer/dist',
  'apps/issuer/renderer-dist',
  'packages/contracts/dist',
  'packages/domain/dist',
  'packages/db/dist',
  'packages/ui/dist',
];
function files(root, directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('BUILD_OUTPUT_LINK');
    return entry.isDirectory() ? files(root, file) : [file];
  });
}
function digest(root, names) {
  const hash = createHash('sha256');
  for (const name of [...new Set(names)].sort()) {
    hash.update(name).update('\0');
    hash.update(
      createHash('sha256')
        .update(readFileSync(path.join(root, name)))
        .digest(),
    );
  }
  return hash.digest('hex');
}
function snapshot(root) {
  const sources = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
    .split('\0')
    .filter(Boolean);
  if (!sources.length) throw new Error('BUILD_SOURCE_EMPTY');
  const built = outputs.flatMap((directory) => {
    const names = files(root, directory);
    if (!names.length) throw new Error('BUILD_OUTPUT_EMPTY');
    return names;
  });
  return {
    format: 1,
    node: process.version,
    source: digest(root, sources),
    output: digest(root, built),
  };
}
export function recordBuild(root) {
  const receipt = snapshot(root);
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, '.local/ci-build.json'), JSON.stringify(receipt));
}
export function verifyBuild(root) {
  const receipt = JSON.parse(readFileSync(path.join(root, '.local/ci-build.json'), 'utf8'));
  if (JSON.stringify(receipt) !== JSON.stringify(snapshot(root)))
    throw new Error('BUILD_RECEIPT_MISMATCH');
  console.log('BUILD_REUSED: source and compiled outputs verified');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, '../..');
  if (process.argv[2] === 'verify') verifyBuild(root);
  else if (!process.argv[2]) {
    execFileSync(
      process.execPath,
      [path.join(root, '.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs'), 'build'],
      {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    recordBuild(root);
  } else throw new Error('BUILD_COMMAND_INVALID');
}
