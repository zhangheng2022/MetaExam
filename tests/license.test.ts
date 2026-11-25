import test from 'node:test';
import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
import { verifyLicense, LicenseError, strictJson } from '../packages/domain/src';
const keys = generateKeyPairSync('ed25519'),
  pub = new Map([['test', keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()]]);
const now = new Date('2026-11-25T12:00:00Z');
const ctx = { installationId: randomUUID(), deviceHash: 'a'.repeat(64), appVersion: '0.1.0', now };
const base = {
  schemaVersion: 1,
  product: 'MetaExam',
  licenseId: 'TEST',
  customerId: 'INTERNAL',
  installationId: ctx.installationId,
  fingerprintVersion: 1,
  deviceHash: ctx.deviceHash,
  sequence: 1,
  issuedAt: '2026-11-01T00:00:00Z',
  notBefore: '2026-11-01T00:00:00Z',
  expiresAt: '2027-01-01T00:00:00Z',
  maxConcurrentAttempts: 300,
  features: ['exam.core'],
  minAppVersion: '0.1.0',
  maxAppMajor: 0,
};
function issue(changes: Record<string, unknown> = {}, head: Record<string, unknown> = {}) {
  const p = Buffer.from(
    JSON.stringify({ typ: 'MetaExam-License-v1', alg: 'Ed25519', kid: 'test', ...head }),
  ).toString('base64url');
  const b = Buffer.from(JSON.stringify({ ...base, ...changes })).toString('base64url');
  return JSON.stringify({
    protected: p,
    payload: b,
    signature: sign(
      null,
      Buffer.from('MetaExam-License-v1.' + p + '.' + b),
      keys.privateKey,
    ).toString('base64url'),
  });
}
function rejects(raw: string, code: string, context = ctx) {
  assert.throws(
    () => verifyLicense(raw, pub, context),
    (e: unknown) => e instanceof LicenseError && e.code === code,
  );
}
test('valid Ed25519 license uses local keys only', () =>
  assert.equal(verifyLicense(issue(), pub, ctx).payload.maxConcurrentAttempts, 300));
test('verification succeeds with TCP and fetch denied in the process', (t) => {
  const denied = () => {
    throw new Error('NETWORK_DISABLED_FOR_VERIFICATION_TEST');
  };
  const tcp = t.mock.method(Socket.prototype, 'connect', denied);
  const fetchMock = t.mock.method(globalThis, 'fetch', denied);
  assert.equal(verifyLicense(issue(), pub, ctx).payload.product, 'MetaExam');
  rejects(issue({ expiresAt: now.toISOString() }), 'EXPIRED');
  assert.equal(tcp.mock.callCount(), 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});
test('permanent license', () =>
  assert.equal(verifyLicense(issue({ expiresAt: null }), pub, ctx).payload.expiresAt, null));
test('payload tampering', () => {
  const e = JSON.parse(issue());
  e.payload = Buffer.from(JSON.stringify({ ...base, maxConcurrentAttempts: 9999 })).toString(
    'base64url',
  );
  rejects(JSON.stringify(e), 'BAD_SIGNATURE');
});
test('wrong public key', () => {
  const other = generateKeyPairSync('ed25519');
  assert.throws(
    () =>
      verifyLicense(
        issue(),
        new Map([['test', other.publicKey.export({ type: 'spki', format: 'pem' }).toString()]]),
        ctx,
      ),
    { code: 'BAD_SIGNATURE' },
  );
});
test('unknown key and algorithm substitution', () => {
  rejects(issue({}, { kid: '__proto__' }), 'UNKNOWN_KEY');
  rejects(issue({}, { alg: 'none' }), 'BAD_FORMAT');
});
test('wrong product', () => rejects(issue({ product: 'Other' }), 'WRONG_PRODUCT'));
test('wrong installation', () =>
  rejects(issue({ installationId: randomUUID() }), 'WRONG_INSTANCE'));
test('wrong device', () => rejects(issue({ deviceHash: 'b'.repeat(64) }), 'WRONG_DEVICE'));
test('expiry is exclusive', () => rejects(issue({ expiresAt: now.toISOString() }), 'EXPIRED'));
test('notBefore is inclusive', () =>
  assert.ok(verifyLicense(issue({ notBefore: now.toISOString() }), pub, ctx)));
test('future license rejected', () =>
  rejects(issue({ notBefore: '2026-12-01T00:00:00Z' }), 'NOT_YET_VALID'));
test('old sequence and conflicting same sequence rejected', () => {
  const raw = issue(),
    digest = createHash('sha256').update(raw).digest('hex');
  rejects(raw, 'STALE_SEQUENCE', { ...ctx, highestSequence: 2 } as typeof ctx);
  rejects(issue({ maxConcurrentAttempts: 200 }), 'SEQUENCE_CONFLICT', {
    ...ctx,
    highestSequence: 1,
    currentDigest: digest,
  } as typeof ctx);
  assert.ok(verifyLicense(raw, pub, { ...ctx, highestSequence: 1, currentDigest: digest }));
});
test('semantic version ordering', () => {
  rejects(issue({ minAppVersion: '0.10.0' }), 'VERSION_MISMATCH');
  assert.ok(
    verifyLicense(issue({ minAppVersion: '0.1.0' }), pub, { ...ctx, appVersion: '0.10.0' }),
  );
});
test('clock rollback detected', () =>
  rejects(issue(), 'CLOCK_ANOMALY', {
    ...ctx,
    lastTrustedAt: new Date(now.getTime() + 301000),
  } as typeof ctx));
test('duplicate keys and oversized payload rejected', () => {
  rejects(issue().replace('{"protected":', '{"payload":"x","protected":'), 'BAD_FORMAT');
  rejects(' '.repeat(65537), 'BAD_FORMAT');
  assert.throws(() => strictJson('{"x":{"a":1,"a":2}}'));
});
test('noncanonical base64 rejected', () => {
  const e = JSON.parse(issue());
  e.signature += '=';
  rejects(JSON.stringify(e), 'BAD_FORMAT');
});
test('malformed intervals and unbounded entitlements rejected', () => {
  rejects(issue({ expiresAt: '2026-10-01T00:00:00Z' }), 'BAD_FORMAT');
  rejects(issue({ maxConcurrentAttempts: 0 }), 'BAD_FORMAT');
  rejects(issue({ features: ['exam.core', 'exam.core'] }), 'BAD_FORMAT');
});
