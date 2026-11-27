import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function validateTrust(manifest, profile, version) {
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.product !== 'MetaExam' ||
    manifest.environment !== profile ||
    manifest.version !== version ||
    !Array.isArray(manifest.keys) ||
    manifest.keys.length < 1 ||
    manifest.keys.length > 20
  )
    throw new Error('TRUST_MANIFEST_INVALID');
  const keys = Object.create(null),
    rows = [];
  for (const row of manifest.keys) {
    if (
      !row ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(row.kid) ||
      Object.hasOwn(keys, row.kid) ||
      (profile === 'production' && /^(?:internal-test|test(?:-|$))/.test(row.kid))
    )
      throw new Error('TRUST_KEY_INVALID');
    const key = createPublicKey(row.publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || !/^-----BEGIN PUBLIC KEY-----/.test(row.publicKey))
      throw new Error('TRUST_KEY_INVALID');
    const fingerprint = createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (
      row.publicKey.replaceAll('\r\n', '\n').trim() !==
      key.export({ type: 'spki', format: 'pem' }).toString().trim()
    )
      throw new Error('TRUST_KEY_INVALID');
    if (fingerprint !== row.fingerprint) throw new Error('TRUST_FINGERPRINT_MISMATCH');
    keys[row.kid] = row.publicKey;
    rows.push({ kid: row.kid, publicKey: row.publicKey, fingerprint });
  }
  return {
    keys,
    manifest: { schemaVersion: 1, product: 'MetaExam', environment: profile, version, keys: rows },
  };
}
export function loadBuildTrust(root, version, profile, manifestFile) {
  if (!['test', 'production'].includes(profile)) throw new Error('TRUST_PROFILE_REQUIRED');
  if (manifestFile)
    return validateTrust(
      JSON.parse(readFileSync(path.resolve(manifestFile), 'utf8')),
      profile,
      version,
    );
  if (profile === 'production') throw new Error('PRODUCTION_TRUST_MANIFEST_REQUIRED');
  const publicKeys = JSON.parse(
    readFileSync(path.join(root, '.local/provider/public-keys.json'), 'utf8'),
  );
  const keys = Object.entries(publicKeys).map(([kid, publicKey]) => ({
    kid,
    publicKey,
    fingerprint: createHash('sha256')
      .update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))
      .digest('hex'),
  }));
  return validateTrust(
    { schemaVersion: 1, product: 'MetaExam', environment: 'test', version, keys },
    'test',
    version,
  );
}
