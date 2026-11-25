import type { ExamPhase, LicensePayload } from '@metaexam/contracts';
export function examPhase(
  status: 'draft' | 'published' | 'cancelled',
  startsAt: string,
  endsAt: string,
  now = Date.now(),
): ExamPhase {
  if (status !== 'published') return status;
  return now < Date.parse(startsAt)
    ? 'scheduled'
    : now < Date.parse(endsAt)
      ? 'in_progress'
      : 'ended';
}
export function validExamWindow(startsAt: string, endsAt: string, durationMinutes: number) {
  const length = Date.parse(endsAt) - Date.parse(startsAt);
  return (
    Number.isFinite(length) &&
    Number.isInteger(durationMinutes) &&
    durationMinutes >= 1 &&
    durationMinutes <= 480 &&
    length >= durationMinutes * 60000 &&
    length <= 7 * 86400000
  );
}
// Only call with a payload already verified locally against current trusted state.
export function publicationLicenseError(license: LicensePayload, startsAt: string) {
  if (!license.features.includes('exam.core')) return 'EXAM_FEATURE_MISSING';
  if (license.expiresAt && Date.parse(license.expiresAt) <= Date.parse(startsAt))
    return 'EXAM_LICENSE_WINDOW';
  return null;
}
