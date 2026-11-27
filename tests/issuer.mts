import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { IssuerService } from '../apps/issuer/dist/service.js';
import { IssuerHost } from '../apps/issuer/dist/host.js';
import { verifyLicense } from '../packages/domain/dist/index.js';
import type { IssuerDraft } from '../packages/contracts/dist/index.js';
const home = mkdtempSync(path.join(tmpdir(), 'MetaExam-issuer-test-'));
const password = '测试签发器独立口令 123456',
  secondPassword = '第二个密钥库口令 987654';
let now = Date.now();
let service = new IssuerService(path.join(home, 'ledger'), () => now);
const host = new IssuerHost(
  path.resolve('.tools/node/node.exe'),
  path.resolve('apps/issuer/dist/worker.js'),
  path.join(home, 'ledger'),
);
let restored: IssuerService | undefined;
function cleanup() {
  if (
    path.dirname(home) !== path.resolve(tmpdir()) ||
    !path.basename(home).startsWith('MetaExam-issuer-test-')
  )
    throw new Error('Unsafe cleanup');
  rmSync(home, { recursive: true, force: true });
}
try {
  await assert.rejects(service.unlock('short'));
  await service.unlock(password);
  assert.equal(service.snapshot().keys.length, 0, 'no automatic signing key');
  const key = await service.createKey('test');
  const prod = await service.createKey('production');
  const pair = generateKeyPairSync('ed25519');
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const pub = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await service.importTestKey(pem, JSON.stringify({ 'internal-test': pub }));
  await assert.rejects(
    service.importTestKey(pem, JSON.stringify({ 'internal-test': pub + pem })),
    /KEY_INVALID/,
  );
  await assert.rejects(
    service.importTestKey(pem, JSON.stringify({ 'internal-test': pem })),
    /KEY_INVALID/,
  );
  await assert.rejects(
    service.importTestKey(
      pem,
      JSON.stringify({
        'internal-test': service.exportTrust(prod.kid, '0.1.2').keys[0]!.publicKey,
      }),
    ),
    /KEY_MISMATCH/,
  );
  service.saveCustomer({ id: 'CUSTOMER-001', name: '测试学校', note: '隔离数据' });
  const request = {
    schemaVersion: 1,
    product: 'MetaExam',
    requestId: randomUUID(),
    installationId: randomUUID(),
    fingerprintVersion: 1,
    deviceHash: 'a'.repeat(64),
    fingerprintMode: 'smbios',
    appVersion: '0.1.2',
  };
  service.importRequest(JSON.stringify(request), 'CUSTOMER-001');
  assert.throws(
    () =>
      service.importRequest(
        JSON.stringify({ ...request, deviceHash: 'b'.repeat(64) }),
        'CUSTOMER-001',
      ),
    /INSTANCE_MISMATCH/,
  );
  assert.throws(() =>
    service.importRequest(JSON.stringify({ ...request, extra: true }), 'CUSTOMER-001'),
  );
  const trust = service.exportTrust(key.kid, '0.1.2');
  const pkg = service.importTrust(JSON.stringify(trust));
  const draft: IssuerDraft = {
    requestId: request.requestId,
    kid: key.kid,
    packageId: pkg.id,
    environment: 'test',
    notBefore: null,
    expiresAt: new Date(now + 86400000).toISOString(),
    permanentConfirmed: false,
    maxConcurrentAttempts: 30,
    minAppVersion: '0.1.0',
    maxAppMajor: 0,
  };
  await assert.rejects(service.preview(draft), /SEQUENCE_UNKNOWN/);
  assert.throws(
    () => service.setFloor(request.installationId, 0, '首次接入', false),
    /SEQUENCE_INVALID/,
  );
  service.setFloor(request.installationId, 0, '确认从未签发', true);
  await assert.rejects(service.preview({ ...draft, minAppVersion: '0.2.0' }), /VERSION_MISMATCH/);
  await assert.rejects(service.preview({ ...draft, kid: prod.kid }), /KEY_DISABLED/);
  await assert.rejects(
    service.preview({ ...draft, expiresAt: null }),
    /PERMANENT_CONFIRMATION_REQUIRED/,
  );
  const preview = await service.preview(draft);
  service.store.db.exec(
    "CREATE TRIGGER test_fail_sign BEFORE INSERT ON licenses BEGIN SELECT RAISE(ABORT,'SIMULATED_COMMIT_FAILURE'); END",
  );
  await assert.rejects(
    service.confirm(preview.id, preview.operationId),
    /SIMULATED_COMMIT_FAILURE/,
  );
  assert.equal(service.snapshot().instances[0]!.floor, 0);
  assert.equal(service.snapshot().licenses.length, 0);
  service.store.db.exec('DROP TRIGGER test_fail_sign');
  const retryPreview = await service.preview(draft);
  Object.assign(preview, retryPreview);
  const one = await service.confirm(preview.id, preview.operationId);
  assert.equal(one.id, preview.payload.licenseId);
  assert.deepEqual(await service.confirm(preview.id, preview.operationId), one);
  const raw = service.license(one.id);
  const context = {
    installationId: request.installationId,
    deviceHash: request.deviceHash,
    appVersion: '0.1.2',
    now: new Date(now),
  };
  const keys = new Map(trust.keys.map((k) => [k.kid, k.publicKey]));
  assert.equal(verifyLicense(raw, keys, context).payload.sequence, 1);
  assert.throws(
    () => verifyLicense(raw, keys, { ...context, deviceHash: 'b'.repeat(64) }),
    /WRONG_DEVICE/,
  );
  assert.throws(
    () => verifyLicense(raw, keys, { ...context, highestSequence: 2 }),
    /STALE_SEQUENCE/,
  );
  assert.throws(
    () => verifyLicense(raw, keys, { ...context, now: new Date(now + 86400000) }),
    /EXPIRED/,
  );
  assert.throws(() => verifyLicense(raw, new Map(), context), /UNKNOWN_KEY/);
  const envelope = JSON.parse(raw);
  envelope.signature = 'A'.repeat(86);
  assert.throws(() => verifyLicense(JSON.stringify(envelope), keys, context));
  const oldBackup = await service.backup(password);
  const permanentPreview = await service.preview({
    ...draft,
    expiresAt: null,
    permanentConfirmed: true,
  });
  const two = await service.confirm(permanentPreview.id, permanentPreview.operationId);
  assert.equal(verifyLicense(service.license(two.id), keys, context).payload.expiresAt, null);
  assert.equal(service.snapshot().instances[0]!.floor, 2);
  const backupBefore = service.snapshot();
  await assert.rejects(service.restore(oldBackup, secondPassword), /UNLOCK_FAILED/);
  assert.deepEqual(service.snapshot(), backupBefore);
  const corrupt = JSON.parse(oldBackup);
  corrupt.tag = '0'.repeat(32);
  await assert.rejects(service.restore(JSON.stringify(corrupt), password), /UNLOCK_FAILED/);
  await service.restore(oldBackup, password);
  assert.equal(service.snapshot().instances[0]!.floor, 2);
  assert.equal(service.snapshot().licenses.length, 2, 'newer records retained');
  await assert.rejects(service.preview(draft), /REVIEW_REQUIRED/);
  assert.throws(() => service.completeReview('核对完成'), /SEQUENCE_UNKNOWN/);
  service.setFloor(request.installationId, 2, '已核对最新签发文件', false);
  service.completeReview('核对了备份后签发记录');
  const future = await service.preview({
    ...draft,
    notBefore: new Date(now + 3600000).toISOString(),
  });
  const three = await service.confirm(future.id, future.operationId);
  assert.throws(() => verifyLicense(service.license(three.id), keys, context), /NOT_YET_VALID/);
  assert.equal(
    verifyLicense(service.license(three.id), keys, { ...context, now: new Date(now + 3600000) })
      .payload.sequence,
    3,
  );
  const expiredPreview = await service.preview(draft);
  now += 600001;
  await assert.rejects(
    service.confirm(expiredPreview.id, expiredPreview.operationId),
    /PREVIEW_EXPIRED/,
  );
  now -= 600001;
  assert.throws(
    () => service.setFloor(request.installationId, 1, '降低序号', false),
    /SEQUENCE_INVALID/,
  );
  const backup = await service.backup(password);
  restored = new IssuerService(path.join(home, 'restored'));
  await restored.unlock(secondPassword);
  await restored.restore(backup, password);
  assert.equal(restored.license(one.id), raw);
  assert.equal(restored.snapshot().instances[0]!.floor, 3);
  restored.setFloor(request.installationId, 3, '恢复后核对', false);
  restored.completeReview('核对完成');
  restored.importHistory(raw); // expired historical records are acceptable at issuance time
  const p4 = await restored.preview(draft);
  const fourth = await restored.confirm(p4.id, p4.operationId);
  assert.equal(restored.snapshot().instances[0]!.floor, 4);
  assert.throws(
    () => restored.store.db.prepare('UPDATE licenses SET raw=? WHERE id=?').run('{}', fourth.id),
    /IMMUTABLE_LICENSE/,
  );
  assert.throws(() => restored.store.db.prepare('DELETE FROM licenses').run(), /IMMUTABLE_LICENSE/);
  await service.changePassword(secondPassword);
  service.close();
  service = new IssuerService(path.join(home, 'ledger'), () => now);
  await assert.rejects(service.unlock(password), /UNLOCK_FAILED/);
  await service.unlock(secondPassword);
  assert.equal(service.license(one.id), raw);
  service.close();
  await host.call('unlock', secondPassword);
  assert.deepEqual(
    await host.call('confirm', preview.id, preview.operationId),
    one,
    'commit survives process restart',
  );
  const uncommitted = await host.call<{ id: string; operationId: string }>('preview', draft);
  host.lock();
  await host.call('unlock', secondPassword);
  await assert.rejects(
    host.call('confirm', uncommitted.id, uncommitted.operationId),
    /PREVIEW_EXPIRED/,
  );
  const disk = readFileSync(path.join(home, 'ledger/issuer.sqlite'));
  assert.equal(disk.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')), false);
  assert.equal(disk.includes(Buffer.from(password)), false);
  assert.equal(disk.includes(Buffer.from(secondPassword)), false);
  console.log(
    'PASS issuer vault, trust, signing, sequence, replay, dates, backup, restoration, restart and secret exclusion',
  );
} finally {
  host.lock();
  try {
    service.close();
  } catch {
    /* already closed */
  }
  restored?.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  cleanup();
}
