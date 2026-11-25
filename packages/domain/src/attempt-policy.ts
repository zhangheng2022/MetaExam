import type { LicensePayload, LicenseSummary } from '@metaexam/contracts';

// Contract for the exam transaction. Inputs must come from trusted server
// state; accepting a client-provided grant would bypass authorization entirely.
export interface AttemptGrant {
  attemptId: string;
  licenseId: string;
  licenseSequence: number;
  startedAt: string;
  licenseNotBefore: string;
  licenseExpiresAt: string | null;
  completedAt: string | null;
}
export type AttemptDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'LICENSE_INVALID' | 'FEATURE_MISSING' | 'CAPACITY_REACHED' | 'NO_ACTIVE_GRANT';
    };
export function canStartAttempt(license: LicenseSummary, activeAttempts: number): AttemptDecision {
  if (license.state !== 'valid' || !license.maxConcurrentAttempts)
    return { allowed: false, reason: 'LICENSE_INVALID' };
  if (!license.features.includes('exam.core')) return { allowed: false, reason: 'FEATURE_MISSING' };
  if (
    !Number.isSafeInteger(activeAttempts) ||
    activeAttempts < 0 ||
    activeAttempts >= license.maxConcurrentAttempts
  )
    return { allowed: false, reason: 'CAPACITY_REACHED' };
  return { allowed: true };
}
export function snapshotAttemptGrant(
  attemptId: string,
  license: LicensePayload,
  startedAt: Date,
): AttemptGrant {
  return {
    attemptId,
    licenseId: license.licenseId,
    licenseSequence: license.sequence,
    startedAt: startedAt.toISOString(),
    licenseNotBefore: license.notBefore,
    licenseExpiresAt: license.expiresAt,
    completedAt: null,
  };
}
export function canContinueAttempt(grant: AttemptGrant | null, attemptId: string): AttemptDecision {
  if (!grant || grant.attemptId !== attemptId || grant.completedAt !== null)
    return { allowed: false, reason: 'NO_ACTIVE_GRANT' };
  const started = Date.parse(grant.startedAt),
    begin = Date.parse(grant.licenseNotBefore),
    end = grant.licenseExpiresAt === null ? Infinity : Date.parse(grant.licenseExpiresAt);
  if (!Number.isFinite(started) || !Number.isFinite(begin) || !(started >= begin && started < end))
    return { allowed: false, reason: 'NO_ACTIVE_GRANT' };
  // A persisted grant valid at admission survives license expiry during the exam.
  // The repository enforces seat allocation, ownership, identity and deadline checks.
  return { allowed: true };
}
