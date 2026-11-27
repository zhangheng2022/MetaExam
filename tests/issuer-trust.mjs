import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { validateTrust, loadBuildTrust } from '../installer/trust.mjs';
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = createHash('sha256')
  .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const manifest = {
  schemaVersion: 1,
  product: 'MetaExam',
  environment: 'production',
  version: '0.1.3',
  keys: [{ kid: 'production-isolated-test', publicKey, fingerprint }],
};
assert.throws(
  () =>
    validateTrust(
      {
        ...manifest,
        keys: [
          {
            ...manifest.keys[0],
            publicKey: publicKey + pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
          },
        ],
      },
      'production',
      '0.1.3',
    ),
  /TRUST_KEY_INVALID/,
);
assert.equal(
  validateTrust(manifest, 'production', '0.1.3').manifest.keys[0].fingerprint,
  fingerprint,
);
assert.throws(
  () => loadBuildTrust(process.cwd(), '0.1.3', 'production'),
  /PRODUCTION_TRUST_MANIFEST_REQUIRED/,
);
assert.throws(() => loadBuildTrust(process.cwd(), '0.1.3'), /TRUST_PROFILE_REQUIRED/);
assert.throws(() => validateTrust(manifest, 'test', '0.1.3'), /TRUST_MANIFEST_INVALID/);
assert.throws(() => validateTrust(manifest, 'production', '0.1.2'), /TRUST_MANIFEST_INVALID/);
assert.throws(
  () =>
    validateTrust(
      { ...manifest, keys: [{ ...manifest.keys[0], kid: 'internal-test' }] },
      'production',
      '0.1.3',
    ),
  /TRUST_KEY_INVALID/,
);
assert.throws(
  () =>
    validateTrust(
      { ...manifest, keys: [{ ...manifest.keys[0], fingerprint: '0'.repeat(64) }] },
      'production',
      '0.1.3',
    ),
  /TRUST_FINGERPRINT_MISMATCH/,
);
assert.throws(
  () =>
    validateTrust(
      { ...manifest, keys: [manifest.keys[0], manifest.keys[0]] },
      'production',
      '0.1.3',
    ),
  /TRUST_KEY_INVALID/,
);
console.log(
  'PASS explicit production/test trust, key types/fingerprints, duplicate rejection and no production fallback',
);
