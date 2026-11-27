import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
mkdirSync('artifacts', { recursive: true });
const directory = mkdtempSync(path.join(root, 'artifacts/installer-result-'));
writeFileSync(
  path.join(directory, 'test.iss'),
  `[Setup]
AppName=MetaExam installation result regression
AppVersion=1
DefaultDirName={tmp}\\MetaExam-installation-result-test
PrivilegesRequired=lowest
Uninstallable=no
CreateUninstallRegKey=no
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=${directory}
OutputBaseFilename=installation-result
[Code]
#include "${path.join(root, 'installer/install-result.iss')}"
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    BeginPostInstall;
    if ExpandConstant('{param:fail|0}') = '1' then
      RaiseException('EXPECTED_POST_INSTALL_FAILURE');
    CompletePostInstall;
  end;
end;
`,
);
execFileSync(path.join(root, '.tools/inno/ISCC.exe'), ['/Q', path.join(directory, 'test.iss')], {
  windowsHide: true,
  stdio: 'pipe',
});
for (const fail of [false, true]) {
  const log = path.join(directory, fail ? 'failure.log' : 'success.log');
  const result = spawnSync(
    path.join(directory, 'installation-result.exe'),
    ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${log}`, `/fail=${fail ? 1 : 0}`],
    { windowsHide: true, timeout: 60000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, fail ? 10 : 0, readFileSync(log, 'utf8'));
  if (fail) assert.match(readFileSync(log, 'utf8'), /EXPECTED_POST_INSTALL_FAILURE/);
}
console.log('PASS real Inno post-install failure returns 10; successful installation returns 0');
