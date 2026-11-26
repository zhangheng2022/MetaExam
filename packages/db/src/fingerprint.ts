import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
async function hardware() {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED_FOR_DEVICE_BINDING');
  const script =
    "$ErrorActionPreference='Stop'; $a=''; $b=''; try {$a=(Get-CimInstance Win32_ComputerSystemProduct).UUID} catch {}; try {$b=(Get-CimInstance Win32_BaseBoard).SerialNumber} catch {}; @{uuid=$a;board=$b;guid=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid}|ConvertTo-Json -Compress";
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 65536,
  }).then(({ stdout }) => JSON.parse(stdout) as Record<string, string>);
}
export function createFingerprintReader(collect: () => Promise<Record<string, string>>) {
  let collecting: Promise<Record<string, string>> | undefined;
  // Share only an in-flight hardware read, never a completed result or license decision.
  return async (installationId: string): Promise<{ hash: string; mode: string }> => {
    if (!collecting) {
      collecting = Promise.resolve().then(collect);
      void collecting
        .finally(() => {
          collecting = undefined;
        })
        .catch(() => {});
    }
    const v = await collecting;
    const clean = (s?: string) => (s ?? '').trim().toUpperCase();
    const valid = (s: string) =>
      s.length > 3 && !/DEFAULT|UNKNOWN|TO BE FILLED|NOT SPECIFIED|^0+(-0+)*$|^F+(-F+)*$/.test(s);
    const a = clean(v.uuid),
      b = clean(v.board),
      g = clean(v.guid);
    const mode = valid(a) && valid(b) ? 'smbios' : 'machine-guid';
    if (mode === 'machine-guid' && !valid(g)) throw new Error('NO_STABLE_DEVICE_ID');
    return {
      mode,
      hash: createHash('sha256')
        .update(JSON.stringify([1, installationId, mode, mode === 'smbios' ? [a, b] : [g]]))
        .digest('hex'),
    };
  };
}
export const fingerprint = createFingerprintReader(hardware);
