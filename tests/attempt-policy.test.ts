import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canStartAttempt,
  canContinueAttempt,
  type AttemptGrant,
} from '../packages/domain/src/attempt-policy';
import type { LicenseSummary } from '../packages/contracts/src';
const license: LicenseSummary = {
  state: 'valid',
  expiresAt: '2026-01-02T00:00:00Z',
  maxConcurrentAttempts: 2,
  features: ['exam.core'],
};
test('new attempt requires valid license, feature and available seat', () => {
  assert.deepEqual(canStartAttempt(license, 1), { allowed: true });
  assert.deepEqual(canStartAttempt(license, 2), { allowed: false, reason: 'CAPACITY_REACHED' });
  assert.deepEqual(canStartAttempt({ ...license, state: 'expired' }, 0), {
    allowed: false,
    reason: 'LICENSE_INVALID',
  });
  assert.deepEqual(canStartAttempt({ ...license, features: [] }, 0), {
    allowed: false,
    reason: 'FEATURE_MISSING',
  });
  assert.equal(canStartAttempt(license, -1).allowed, false);
});
test('trusted active grant can continue beyond expiry but cannot admit or resurrect another attempt', () => {
  const grant: AttemptGrant = {
    attemptId: 'a',
    licenseId: 'l',
    licenseSequence: 1,
    startedAt: '2026-01-01T01:00:00Z',
    licenseNotBefore: '2026-01-01T00:00:00Z',
    licenseExpiresAt: '2026-01-02T00:00:00Z',
    completedAt: null,
  };
  assert.equal(canContinueAttempt(grant, 'a').allowed, true);
  assert.equal(canContinueAttempt(grant, 'other').allowed, false);
  assert.equal(canContinueAttempt(null, 'a').allowed, false);
  assert.equal(
    canContinueAttempt({ ...grant, completedAt: '2026-01-02T01:00:00Z' }, 'a').allowed,
    false,
  );
  assert.equal(
    canContinueAttempt({ ...grant, startedAt: grant.licenseExpiresAt! }, 'a').allowed,
    false,
  );
});
