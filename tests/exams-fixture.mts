import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { LicensePayload } from '../packages/contracts/dist/index.js';
import { licenseRequest, importLicense } from '../packages/db/dist/index.js';
import { questionFixture } from './questions-fixture.mts';
export async function examFixture() {
  const t = await questionFixture();
  try {
    const bank = await t.create('/question-banks', {
      name: '考试题库',
      courseId: t.courseId,
      visibility: 'public',
    });
    await t.create(`/question-banks/${bank}/questions`, {
      stem: '仅教师可见的考题',
      content: { type: 'boolean', answer: true },
      explanation: '仅教师可见的答案解析',
      difficulty: 2,
      tags: [],
      knowledgePoints: [],
    });
    const cookie = t.people.teacher!.cookie;
    const p = await t.request(
      '/papers',
      'POST',
      { name: '数学冻结试卷', courseId: t.courseId },
      cookie,
    );
    assert.equal(p.statusCode, 201, p.body);
    const paperId = p.json().id;
    assert.equal(
      (
        await t.request(
          `/papers/${paperId}/draw`,
          'POST',
          { revision: 1, bankId: bank, type: 'boolean', count: 1, score: 5 },
          cookie,
        )
      ).statusCode,
      200,
    );
    const frozen = await t.request(`/papers/${paperId}/freeze`, 'POST', { revision: 2 }, cookie);
    assert.equal(frozen.statusCode, 200, frozen.body);
    await t.db.pool.query('INSERT INTO class_members(class_id,student_id) VALUES($1,$2)', [
      t.classId,
      t.people.student!.id,
    ]);
    const keys = generateKeyPairSync('ed25519'),
      kid = 'exam-test';
    let sequence = 0;
    writeFileSync(
      t.config.trustFile,
      JSON.stringify({ [kid]: keys.publicKey.export({ type: 'spki', format: 'pem' }) }),
    );
    const request = await licenseRequest(t.db);
    async function activate(overrides: Partial<LicensePayload> = {}, persist = true) {
      const payload: LicensePayload = {
        schemaVersion: 1,
        product: 'MetaExam',
        licenseId: 'EXAM-TEST',
        customerId: 'test',
        installationId: request.installationId,
        fingerprintVersion: 1,
        deviceHash: request.deviceHash,
        sequence: ++sequence,
        issuedAt: new Date(Date.now() - 120000).toISOString(),
        notBefore: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        maxConcurrentAttempts: 1,
        features: ['exam.core'],
        minAppVersion: '0.1.0',
        maxAppMajor: 0,
        ...overrides,
      };
      const h = Buffer.from(
          JSON.stringify({ typ: 'MetaExam-License-v1', alg: 'Ed25519', kid }),
        ).toString('base64url'),
        p = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const raw = JSON.stringify({
        protected: h,
        payload: p,
        signature: sign(
          null,
          Buffer.from('MetaExam-License-v1.' + h + '.' + p),
          keys.privateKey,
        ).toString('base64url'),
      });
      if (persist) await importLicense(t.db, raw);
      return raw;
    }
    const input = {
      name: '数学阶段考试',
      paperVersionId: frozen.json().id as string,
      startsAt: new Date(Date.now() + 3600000).toISOString(),
      endsAt: new Date(Date.now() + 10800000).toISOString(),
      durationMinutes: 60,
      classIds: [t.classId],
    };
    return { ...t, activate, input, paperId, bank };
  } catch (e) {
    await t.close();
    throw e;
  }
}
