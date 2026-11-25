import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, lstatSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { BootstrapRepository, digestToken } from './identity';
import type { Database } from './index';
export function requireAdministrator() {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED');
  const result = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  );
  if (result.trim() !== 'True') throw new Error('ADMINISTRATOR_REQUIRED');
}
export async function issueBootstrapFile(db: Database) {
  requireAdministrator();
  const dir = path.join(db.config.home, 'bootstrap');
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
    throw new Error('UNSAFE_BOOTSTRAP_DIRECTORY');
  mkdirSync(dir, { recursive: true });
  // Replace the DACL, not just inherited rules: only Administrators and SYSTEM retain access.
  const script =
    "$p=[Console]::In.ReadToEnd(); $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @('S-1-5-18','S-1-5-32-544')) { $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl -ErrorAction Stop";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: dir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
  const c = await db.pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(184427)');
    const token = randomBytes(32).toString('hex'),
      expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const file = path.join(dir, 'token.json'),
      tmp = path.join(dir, randomUUID() + '.tmp');
    writeFileSync(tmp, JSON.stringify({ token, expiresAt: expiresAt.toISOString() }), {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await new BootstrapRepository(db).issue(digestToken(token), expiresAt, {
        requestId: randomUUID(),
      });
      renameSync(tmp, file);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  } finally {
    try {
      await c.query('SELECT pg_advisory_unlock(184427)');
    } finally {
      c.release();
    }
  }
}
