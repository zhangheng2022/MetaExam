// PROVIDER-ONLY TEST TOOL. Never copied into the customer payload.
import { generateKeyPairSync, sign, createPrivateKey, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [cmd, dirArg, requestFile, output] = process.argv.slice(2);
if (!dirArg)
  throw new Error(
    'Usage: provider/test-license.mjs keygen <private-dir> OR sign <private-dir> <request.mreq> <output.mlic>',
  );
const dir = path.resolve(dirArg);
if (cmd === 'keygen') {
  mkdirSync(dir, { recursive: true });
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(
    path.join(dir, 'private.pem'),
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { flag: 'wx', mode: 0o600 },
  );
  writeFileSync(
    path.join(dir, 'public-keys.json'),
    JSON.stringify(
      { 'internal-test': keys.publicKey.export({ type: 'spki', format: 'pem' }) },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log('TEST_KEYS_CREATED: do not distribute private.pem');
} else if (cmd === 'sign') {
  if (!requestFile || !output) throw new Error('Missing request/output path');
  const r = JSON.parse(readFileSync(requestFile, 'utf8')),
    now = new Date(),
    expiry = new Date(now.getTime() + 30 * 86400000);
  const payload = {
    schemaVersion: 1,
    product: 'MetaExam',
    licenseId: 'TEST-' + randomUUID(),
    customerId: 'INTERNAL-TEST',
    installationId: r.installationId,
    fingerprintVersion: 1,
    deviceHash: r.deviceHash,
    sequence: Number(process.env.LICENSE_SEQUENCE ?? 1),
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt: expiry.toISOString(),
    maxConcurrentAttempts: 300,
    features: ['exam.core', 'reports.basic'],
    minAppVersion: '0.1.0',
    maxAppMajor: 0,
  };
  const protectedPart = Buffer.from(
    JSON.stringify({ typ: 'MetaExam-License-v1', alg: 'Ed25519', kid: 'internal-test' }),
  ).toString('base64url');
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(
    null,
    Buffer.from('MetaExam-License-v1.' + protectedPart + '.' + payloadPart, 'ascii'),
    createPrivateKey(readFileSync(path.join(dir, 'private.pem'))),
  ).toString('base64url');
  writeFileSync(
    output,
    JSON.stringify({ protected: protectedPart, payload: payloadPart, signature }),
    { flag: 'wx' },
  );
  console.log('TEST_LICENSE_SIGNED');
} else throw new Error('Unknown command');
