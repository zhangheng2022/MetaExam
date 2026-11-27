import { execFileSync } from 'node:child_process';
import { readFileSync, copyFileSync, existsSync, constants } from 'node:fs';
import path from 'node:path';
const script = path.resolve(import.meta.dirname, 'signing.ps1');
const powershell = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
);
function run(action, target) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Action',
    action,
  ];
  if (target) args.push('-Target', path.resolve(target));
  return JSON.parse(
    execFileSync(powershell, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
      stdio: 'pipe',
    })
      .trim()
      .replace(/^\uFEFF/, ''),
  );
}
export const signingInfo = () => run('Check');
export const signExecutable = (target) => run('Sign', target);
export const verifyExecutable = (target) => run('Verify', target);
export function innoSigningArgument() {
  for (const value of [script, powershell])
    if (/["$\r\n]/.test(value)) throw new Error('SIGNING_PATH_INVALID');
  return `/Smetaexam=$q${powershell}$q -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $q${script}$q -Action Sign -Target $f`;
}
export function exportSigningCertificate(destination) {
  const info = signingInfo();
  if (existsSync(destination)) {
    if (!readFileSync(destination).equals(readFileSync(info.publicCertificate)))
      throw new Error('SIGNING_CERTIFICATE_CONFLICT');
  } else copyFileSync(info.publicCertificate, destination, constants.COPYFILE_EXCL);
  return {
    mode: 'self-signed',
    subject: info.subject,
    thumbprint: info.thumbprint,
    notAfter: info.notAfter,
    timestamped: false,
  };
}
