import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url),
  { createDatabase, licenseStatus } = require('../packages/db/dist/index.js');
let db = createDatabase();
const before = (
  await db.pool.query(
    'SELECT i.installation_id,i.fingerprint_mode,l.digest,l.highest_sequence,(SELECT count(*)::int FROM jobs) AS jobs FROM instance_info i CROSS JOIN license_state l WHERE i.id=1 AND l.id=1',
  )
).rows[0];
await db.pool.end();
try {
  execFileSync(process.execPath, ['tools/postgres.mjs', 'stop'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  execFileSync(process.execPath, ['tools/postgres.mjs', 'start'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  db = createDatabase();
  const after = (
    await db.pool.query(
      'SELECT i.installation_id,i.fingerprint_mode,l.digest,l.highest_sequence,(SELECT count(*)::int FROM jobs) AS jobs FROM instance_info i CROSS JOIN license_state l WHERE i.id=1 AND l.id=1',
    )
  ).rows[0];
  assert.deepEqual(after, before);
  assert.equal((await licenseStatus(db)).state, 'valid');
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(root, 'artifacts/database-restart-results.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        ordinaryProcessRestart: true,
        persisted: ['installation ID', 'license digest and sequence', 'task rows'],
        fingerprintMode: after.fingerprint_mode,
        licenseAfterRestart: 'valid',
      },
      null,
      2,
    ),
  );
  console.log('DATABASE_RESTART_PERSISTENCE_PASSED');
} finally {
  await db.pool.end();
}
