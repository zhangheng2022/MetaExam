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
  const config = { ...original, database: { ...original.database, database: name } };
  const db = createDatabase(config);
  return {
    db,
    config,
    async close() {
      await db.pool.end();
      if (!/^metaexam_test_[a-f0-9]{32}$/.test(name)) throw new Error('Unsafe test database');
      await owner.pool.query('DROP DATABASE ' + name + ' WITH (FORCE)');
      await owner.pool.end();
    },
  };
}
