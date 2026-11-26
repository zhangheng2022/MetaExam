import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { migrate, licenseRequest } from '../packages/db/dist/index.js';
import { isolatedDatabase } from './database-fixture.mts';

export async function licenseManagerFixture() {
  const t = await isolatedDatabase();
  try {
    await migrate(t.db);
    const request = await licenseRequest(t.db);
    const keys = generateKeyPairSync('ed25519');
    writeFileSync(
      t.config.trustFile,
      JSON.stringify({ test: keys.publicKey.export({ type: 'spki', format: 'pem' }) }),
    );
    const issue = (sequence: number, changes: Record<string, unknown> = {}, kid = 'test') => {
      const header = Buffer.from(
        JSON.stringify({ typ: 'MetaExam-License-v1', alg: 'Ed25519', kid }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          product: 'MetaExam',
          licenseId: 'INTERNAL-TEST',
          customerId: 'test',
          installationId: request.installationId,
          fingerprintVersion: 1,
          deviceHash: request.deviceHash,
          sequence,
          issuedAt: new Date(Date.now() - 120000).toISOString(),
          notBefore: new Date(Date.now() - 60000).toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          maxConcurrentAttempts: 100,
          features: ['exam.core'],
          minAppVersion: '0.1.0',
          maxAppMajor: 0,
          ...changes,
        }),
      ).toString('base64url');
      return JSON.stringify({
        protected: header,
        payload,
        signature: sign(
          null,
          Buffer.from('MetaExam-License-v1.' + header + '.' + payload),
          keys.privateKey,
        ).toString('base64url'),
      });
    };
    return { ...t, request, issue };
  } catch (error) {
    await t.close();
    throw error;
  }
}
