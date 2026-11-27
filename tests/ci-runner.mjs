import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd(),
  directory = mkdtempSync(path.join(root, '.local/ci-runner-test-'));
assert.equal(path.dirname(directory), path.join(root, '.local'));
try {
  for (const name of ['tools/ci', '.tools/node', '.tools/pnpm/node_modules/pnpm/bin'])
    mkdirSync(path.join(directory, name), { recursive: true });
  for (const name of ['verify.ps1', 'RestrictedProcess.cs'])
    copyFileSync(path.join(root, 'tools/ci', name), path.join(directory, 'tools/ci', name));
  copyFileSync(
    path.join(root, '.tools/node/node.exe'),
    path.join(directory, '.tools/node/node.exe'),
  );
  const stub = path.join(directory, '.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs');
  const execute = () =>
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(directory, 'tools/ci/verify.ps1'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 },
    );
  writeFileSync(stub, "process.exit(process.argv.includes('db:start') ? 23 : 0);\n");
  let result = execute();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /CI_TASK_FAILED/);
  writeFileSync(stub, 'process.exit(0);\n');
  result = execute();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /CI_VERIFICATION_INCOMPLETE/);
  writeFileSync(
    stub,
    `process.stderr.write('expected native diagnostic\\n');console.log('ISOLATED_PACKAGE_SMOKE_PASSED\\nPASS packaged issuer real Electron\\nSIGNING_OK:\\nPASS closing Electron leaves API and worker running');\n`,
  );
  result = execute();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  console.log(
    'PASS real child exit failure and silent success cannot pass the CI verification gate',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
