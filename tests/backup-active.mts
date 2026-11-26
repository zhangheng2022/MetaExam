import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import { BackupService } from '../packages/db/dist/index.js';
import { examFixture } from './exams-fixture.mts';

const t = await examFixture();
const output = mkdtempSync(path.join(tmpdir(), 'MetaExam-backup-active-'));
try {
  await t.activate();
  const starts = Date.now() + 10000;
  const id = await t.create('/exams', {
    ...t.input,
    startsAt: new Date(starts).toISOString(),
    endsAt: new Date(starts + 120000).toISOString(),
    durationMinutes: 1,
  });
  const published = await t.request(
    `/exams/${id}/publish`,
    'POST',
    { revision: 1 },
    t.people.admin!.cookie,
  );
  assert.equal(published.statusCode, 200, published.body);
  await t.app.close();
  await t.db.pool.end();
  await setTimeout(Math.max(0, starts - Date.now() + 100));
  const service = new BackupService(t.config, {
    bin: path.resolve('.tools/pgsql/bin'),
    key: randomBytes(32),
    runtimeRole: t.config.database.user,
    secureDirectory: async () => {},
  });
  await assert.rejects(service.create(output), /EXAMS_ACTIVE/);
  console.log('PASS published ongoing exam prevents maintenance even without online students');
} finally {
  await t.close();
  if (
    path.dirname(output) === path.resolve(tmpdir()) &&
    path.basename(output).startsWith('MetaExam-backup-active-')
  )
    rmSync(output, { recursive: true, force: true });
}
