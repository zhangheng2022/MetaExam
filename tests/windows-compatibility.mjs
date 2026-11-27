import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Compile and execute the real Pascal implementation. No JS copy of the policy,
// product installation, services, registry writes, or administrator token needed.
const root = process.cwd();
mkdirSync('artifacts', { recursive: true });
const directory = mkdtempSync(path.join(root, 'artifacts/windows-compatibility-'));
const cases = [
  ['Windows 10 22H2', 10, 0, 19045, 1, 'paX64', 'Client', ''],
  ['Windows 11 initial', 10, 0, 22000, 1, 'paX64', 'Client', ''],
  ['Windows 11 newer', 10, 0, 26100, 1, 'paX64', 'Client', ''],
  ['Server 2022 desktop', 10, 0, 20348, 3, 'paX64', 'Server', ''],
  ['Server 2025 desktop', 10, 0, 26100, 3, 'paX64', 'Server', ''],
  ['Server domain controller', 10, 0, 20348, 2, 'paX64', 'Server', ''],
  ['Windows 10 21H2', 10, 0, 19044, 1, 'paX64', 'Client', 'WINDOWS_CLIENT_VERSION'],
  ['Unknown client build', 10, 0, 19046, 1, 'paX64', 'Client', 'WINDOWS_CLIENT_VERSION'],
  ['Server 2019', 10, 0, 17763, 3, 'paX64', 'Server', 'WINDOWS_SERVER_VERSION'],
  ['Server 2016', 10, 0, 14393, 3, 'paX64', 'Server', 'WINDOWS_SERVER_VERSION'],
  ['Unknown server build', 10, 0, 26200, 3, 'paX64', 'Server', 'WINDOWS_SERVER_VERSION'],
  ['Server Core 2022', 10, 0, 20348, 3, 'paX64', 'Server Core', 'WINDOWS_DESKTOP_REQUIRED'],
  ['Server Core 2025', 10, 0, 26100, 3, 'paX64', 'Server Core', 'WINDOWS_DESKTOP_REQUIRED'],
  ['Missing server type', 10, 0, 20348, 3, 'paX64', '', 'WINDOWS_DESKTOP_REQUIRED'],
  ['Unknown server type', 10, 0, 20348, 3, 'paX64', 'Unknown', 'WINDOWS_DESKTOP_REQUIRED'],
  ['Missing client type', 10, 0, 19045, 1, 'paX64', '', 'WINDOWS_INSTALLATION_TYPE'],
  ['Mismatched product', 10, 0, 26100, 1, 'paX64', 'Server', 'WINDOWS_INSTALLATION_TYPE'],
  ['ARM64 emulation', 10, 0, 26100, 1, 'paArm64', 'Client', 'WINDOWS_ARCHITECTURE'],
  ['x86', 10, 0, 19045, 1, 'paX86', 'Client', 'WINDOWS_ARCHITECTURE'],
  ['Unknown architecture', 10, 0, 26100, 1, 'paUnknown', 'Client', 'WINDOWS_ARCHITECTURE'],
  ['Unknown product', 10, 0, 26100, 0, 'paX64', 'Client', 'WINDOWS_PRODUCT_TYPE'],
  ['Windows 8.1', 6, 3, 9600, 1, 'paX64', 'Client', 'WINDOWS_VERSION'],
  ['Unknown major', 11, 0, 26100, 1, 'paX64', 'Client', 'WINDOWS_VERSION'],
  ['Unknown minor', 10, 1, 26100, 1, 'paX64', 'Client', 'WINDOWS_VERSION'],
];
const pascal = (s) => `'${s.replaceAll("'", "''")}'`;
const expression = ([, major, minor, build, product, arch, type]) =>
  `WindowsCompatibilityError(${major}, ${minor}, ${build}, ${product}, ${arch}, ${pascal(type)})`;
const source = `[Setup]
AppName=MetaExam compatibility regression harness
AppVersion=1
DefaultDirName={tmp}\\MetaExam-compatibility-test
PrivilegesRequired=lowest
Uninstallable=no
CreateUninstallRegKey=no
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=${directory}
OutputBaseFilename=compatibility-test
[Files]
Source: "${directory}\\probe.txt"; DestDir: "{app}"
[Code]
#include "${path.join(root, 'installer/windows-compatibility.iss')}"
function InitializeSetup: Boolean;
var Error: String;
begin
${cases
  .map(
    (row) => `  Error := ${expression(row)};
  if ${row[7] ? `Pos(${pascal(row[7] + ':')}, Error) <> 1` : "Error <> ''"} then
    RaiseException(${pascal('CASE_FAILED: ' + row[0])} + ': ' + Error);`,
  )
  .join('\n')}
  Log('COMPATIBILITY_MATRIX_PASSED');
  if ExpandConstant('{param:reject|0}') = '1' then
    Error := ${expression(cases.find((row) => row[0] === 'Server Core 2022'))}
  else
    Error := CurrentWindowsCompatibilityError;
  Result := RequireCompatibleWindows(Error);
end;
`;
writeFileSync(path.join(directory, 'probe.txt'), 'isolated compatibility test');
writeFileSync(path.join(directory, 'test.iss'), source);
execFileSync(path.join(root, '.tools/inno/ISCC.exe'), ['/Q', path.join(directory, 'test.iss')], {
  windowsHide: true,
  stdio: 'inherit',
});
for (const reject of [false, true]) {
  const destination = path.join(directory, reject ? 'rejected' : 'accepted');
  const log = destination + '.log';
  const result = spawnSync(
    path.join(directory, 'compatibility-test.exe'),
    [
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      `/DIR=${destination}`,
      `/LOG=${log}`,
      ...(reject ? ['/reject=1'] : []),
    ],
    { windowsHide: true, timeout: 60000 },
  );
  assert.ifError(result.error);
  const content = readFileSync(log, 'utf8');
  assert.match(content, /COMPATIBILITY_MATRIX_PASSED/);
  assert.equal(result.status, reject ? 1 : 0, content);
  assert.equal(existsSync(path.join(destination, 'probe.txt')), !reject);
  if (reject) assert.match(content, /WINDOWS_DESKTOP_REQUIRED/);
}
// Ensure both production installers actually invoke the same gate before writes.
for (const name of ['MetaExam', 'Issuer']) {
  const iss = readFileSync(path.join(root, 'installer', name + '.iss'), 'utf8');
  assert.match(iss, /#include "windows-compatibility\.iss"/);
  assert.match(
    iss,
    /function InitializeSetup: Boolean;\s*begin\s*Result := RequireCompatibleWindows\(CurrentWindowsCompatibilityError\);\s*end;/,
  );
  assert.match(iss, /ArchitecturesAllowed=x64compatible and not arm64/);
  assert.doesNotMatch(iss, /param:reject/);
}
console.log(
  `PASS ${cases.length} Windows compatibility cases, actual host installation, silent rejection before file copy (${directory})`,
);
