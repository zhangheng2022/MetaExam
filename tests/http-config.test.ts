import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../packages/db/src/config';

test('production HTTP config loads without certificates; legacy TLS requires installer conversion', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'MetaExam-http-config-'));
  const previous = process.env.METAEXAM_CONFIG;
  const file = path.join(home, 'config.json');
  process.env.METAEXAM_CONFIG = file;
  const raw = {
    home,
    database: { host: '127.0.0.1', port: 55432 },
    api: { host: '0.0.0.0', port: 3000, managementToken: 'test-only-'.repeat(4) },
    production: true,
  };
  try {
    writeFileSync(file, JSON.stringify(raw));
    assert.equal(loadConfig().api.host, '0.0.0.0');
    for (const field of ['tlsCert', 'tlsKey']) {
      writeFileSync(file, JSON.stringify({ ...raw, api: { ...raw.api, [field]: '' } }));
      assert.throws(() => loadConfig(), /HTTP_CONFIGURATION_UPGRADE_REQUIRED/);
    }
    writeFileSync(file, JSON.stringify({ ...raw, production: false }));
    assert.throws(() => loadConfig(), /LAN binding requires production mode/);
    writeFileSync(
      file,
      JSON.stringify({ ...raw, database: { ...raw.database, host: '192.168.1.2' } }),
    );
    assert.throws(() => loadConfig(), /Database must be local/);
  } finally {
    if (previous === undefined) delete process.env.METAEXAM_CONFIG;
    else process.env.METAEXAM_CONFIG = previous;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('MetaExam-http-config-'));
    rmSync(home, { recursive: true, force: true });
  }
});
