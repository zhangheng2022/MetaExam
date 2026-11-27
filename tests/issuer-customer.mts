import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IssuerService } from '../apps/issuer/dist/service.js';
import {
  migrate,
  licenseRequest,
  importLicense,
  licenseStatus,
  createDatabase,
} from '../packages/db/dist/index.js';
import { LicenseOperations } from '../apps/desktop/dist/license-operations.js';
import { previewLicenseImport, licenseDetails } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';
const t = await isolatedDatabase();
const home = mkdtempSync(path.join(tmpdir(), 'MetaExam-issuer-customer-'));
const issuer = new IssuerService(home);
function cleanup() {
  if (
    path.dirname(home) !== path.resolve(tmpdir()) ||
    !path.basename(home).startsWith('MetaExam-issuer-customer-')
  )
    throw new Error('Unsafe cleanup');
  rmSync(home, { recursive: true, force: true });
}
try {
  await migrate(t.db);
  const request = await licenseRequest(t.db);
  await issuer.unlock('isolated supplier password 12345');
  const key = await issuer.createKey('production');
  const trust = issuer.exportTrust(key.kid, request.appVersion);
  const pkg = issuer.importTrust(JSON.stringify(trust));
  writeFileSync(
    t.config.trustFile,
    JSON.stringify(Object.fromEntries(trust.keys.map((k) => [k.kid, k.publicKey]))),
  );
  issuer.saveCustomer({ id: 'CUSTOMER-INTEGRATION', name: '隔离测试学校', note: '' });
  issuer.importRequest(JSON.stringify(request), 'CUSTOMER-INTEGRATION');
  issuer.setFloor(request.installationId, 0, '全新隔离安装', true);
  const preview = await issuer.preview({
    requestId: request.requestId,
    kid: key.kid,
    packageId: pkg.id,
    environment: 'production',
    notBefore: null,
    expiresAt: null,
    permanentConfirmed: true,
    maxConcurrentAttempts: 2,
    minAppVersion: request.appVersion,
    maxAppMajor: 0,
  });
  const record = await issuer.confirm(preview.id, preview.operationId);
  const raw = issuer.license(record.id),
    file = path.join(home, 'customer.mlic');
  writeFileSync(file, raw);
  const manager = new LicenseOperations({
    authorize: async () => {},
    chooseSave: async () => null,
    chooseOpen: async () => file,
    request: () => licenseRequest(t.db),
    preview: (raw) => previewLicenseImport(t.db, raw),
    import: async (raw, expectedDigest) =>
      licenseDetails((await importLicense(t.db, raw, { expectedDigest })).payload),
  });
  const selected = await manager.preview();
  assert.equal(selected.status, 'success');
  if (selected.status !== 'success') throw new Error('Preview failed');
  assert.equal((await manager.confirm(selected.value.id)).status, 'success');
  assert.equal((await licenseStatus(t.db)).maxConcurrentAttempts, 2);
  const reopened = createDatabase(t.config);
  try {
    assert.equal((await licenseStatus(reopened)).state, 'valid');
  } finally {
    await reopened.pool.end();
  }
  console.log(
    'PASS supplier-signed license through actual customer manager operations, real Windows fingerprint and restarted database connection',
  );
} finally {
  issuer.close();
  await t.close();
  cleanup();
}
