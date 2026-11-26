import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDatabase, loadConfig } from '../packages/db/dist/index.js';
export async function isolatedDatabase() {
  const original = loadConfig();
  const name = 'metaexam_test_' + randomUUID().replaceAll('-', '');
  const owner = createDatabase({
    ...original,
    database: { ...original.database, database: 'postgres' },
  });
  await owner.pool.query('CREATE DATABASE ' + name);
  const home = mkdtempSync(path.join(tmpdir(), 'MetaExam-db-test-'));
  const trustFile = path.join(home, 'public-keys.json');
  writeFileSync(trustFile, '{}');
  const config = {
    ...original,
    home,
    trustFile,
    database: { ...original.database, database: name },
  };
  const db = createDatabase(config);
  return {
    db,
    config,
    async close() {
      if (!db.pool.ended) await db.pool.end();
      if (!/^metaexam_test_[a-f0-9]{32}$/.test(name)) throw new Error('Unsafe test database');
      await owner.pool.query('DROP DATABASE ' + name + ' WITH (FORCE)');
      await owner.pool.end();
      if (
        path.dirname(home) === path.resolve(tmpdir()) &&
        path.basename(home).startsWith('MetaExam-db-test-')
      )
        rmSync(home, { recursive: true, force: true });
    },
  };
}
