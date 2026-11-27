import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
  const env = { ...process.env, GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md') };
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
      { encoding: 'utf8', windowsHide: true, timeout: 60000, env },
    );
  writeFileSync(stub, "process.exit(process.argv.includes('db:start') ? 23 : 0);\n");
  let result = execute();
  assert.equal(
    result.error,
    undefined,
    JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }),
  );
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
  writeFileSync(
    stub,
    "if(process.argv.includes('db:start')) { console.log('READY_BEFORE_EXIT'); setTimeout(()=>process.exit(23),2500); }\n",
  );
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(directory, 'tools/ci/verify.ps1'),
    ],
    { windowsHide: true, timeout: 60000, env },
  );
  let firstOutputAt,
    output = '';
  child.stderr.resume();
  child.stdout.on('data', (data) => {
    output += data;
    if (output.includes('READY_BEFORE_EXIT') && firstOutputAt === undefined)
      firstOutputAt = Date.now();
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.notEqual(code, 0);
  assert.ok(
    firstOutputAt !== undefined && Date.now() - firstOutputAt >= 500,
    'test output must be visible while the child is still doing work',
  );
  assert.match(output, /TASK_RESULT:/);
  console.log(
    'PASS real child exit failure and silent success cannot pass the CI verification gate',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
