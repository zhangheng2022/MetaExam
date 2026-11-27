import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { recordBuild, verifyBuild } from '../tools/ci/build.mjs';

const directory = mkdtempSync(path.resolve('.local/ci-build-test-'));
assert.equal(path.dirname(directory), path.resolve('.local'));
const write = (file, value) => {
  mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  writeFileSync(path.join(directory, file), value);
};
try {
  execFileSync('git', ['init', '--quiet', directory], { windowsHide: true });
  write('.gitignore', '.local/\n**/dist/\n**/renderer-dist/\n');
  write('package.json', '{"version":"0.1.0"}');
  write('apps/api/src/main.ts', 'original source');
  for (const workspace of ['api', 'worker', 'web', 'desktop', 'issuer'])
    write(`apps/${workspace}/dist/main.js`, 'compiled');
  for (const workspace of ['desktop', 'issuer'])
    write(`apps/${workspace}/renderer-dist/index.html`, 'rendered');
  for (const workspace of ['contracts', 'domain', 'db', 'ui'])
    write(`packages/${workspace}/dist/index.js`, 'shared');
  assert.throws(() => verifyBuild(directory), /ENOENT/);
  recordBuild(directory);
  verifyBuild(directory);
  write('apps/api/src/main.ts', 'modified source');
  assert.throws(() => verifyBuild(directory), /MISMATCH/);
  write('apps/api/src/main.ts', 'original source');
  write('apps/api/src/new.ts', 'new source');
  assert.throws(() => verifyBuild(directory), /MISMATCH/);
  rmSync(path.join(directory, 'apps/api/src/new.ts'));
  write('apps/api/dist/main.js', 'tampered');
  assert.throws(() => verifyBuild(directory), /MISMATCH/);
  rmSync(path.join(directory, 'apps/api/dist/main.js'));
  assert.throws(() => verifyBuild(directory), /OUTPUT_EMPTY/);
  console.log(
    'PASS compiled reuse rejects missing receipt, changed/new source, altered/missing output',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
