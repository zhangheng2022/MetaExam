import { createHash, createPublicKey, verify } from 'node:crypto';
export * from './exam-policy';
export * from './candidate';
import { TextDecoder } from 'node:util';
import {
  licenseHeaderSchema,
  licensePayloadSchema,
  type LicensePayload,
} from '@metaexam/contracts';
import { strictJson } from './strict-json';
export { strictJson } from './strict-json';
export {
  canStartAttempt,
  canContinueAttempt,
  snapshotAttemptGrant,
  type AttemptGrant,
  type AttemptDecision,
} from './attempt-policy';
export type LicenseCode =
  | 'BAD_FORMAT'
  | 'UNKNOWN_KEY'
  | 'BAD_SIGNATURE'
  | 'WRONG_PRODUCT'
  | 'WRONG_INSTANCE'
  | 'WRONG_DEVICE'
  | 'VERSION_MISMATCH'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'STALE_SEQUENCE'
  | 'SEQUENCE_CONFLICT'
  | 'CLOCK_ANOMALY';
export class LicenseError extends Error {
  constructor(public readonly code: LicenseCode) {
    super(code);
    this.name = 'LicenseError';
  }
}
export interface LicenseContext {
  installationId: string;
  deviceHash: string;
  appVersion: string;
  now?: Date;
  highestSequence?: number;
  currentDigest?: string | null;
  lastTrustedAt?: Date | null;
}
export interface VerifiedLicense {
  payload: LicensePayload;
  digest: string;
  raw: string;
}
function decode(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new LicenseError('BAD_FORMAT');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new LicenseError('BAD_FORMAT');
  return bytes;
}
function json(bytes: Buffer) {
  return strictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function version(s: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(s)) throw new LicenseError('VERSION_MISMATCH');
  const parts = s.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new LicenseError('VERSION_MISMATCH');
  return parts;
}
export function verifyLicense(
  raw: string,
  keys: ReadonlyMap<string, string>,
  context: LicenseContext,
): VerifiedLicense {
  try {
    if (Buffer.byteLength(raw) > 65536) throw new LicenseError('BAD_FORMAT');
    const envelope = strictJson(raw);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
      throw new LicenseError('BAD_FORMAT');
    const e = envelope as Record<string, unknown>;
    if (Object.keys(e).sort().join(',') !== 'payload,protected,signature')
      throw new LicenseError('BAD_FORMAT');
    const header = licenseHeaderSchema.parse(json(decode(e.protected)));
    const pem = keys.get(header.kid);
    if (!pem) throw new LicenseError('UNKNOWN_KEY');
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new LicenseError('BAD_SIGNATURE');
    const signature = decode(e.signature);
    const message = Buffer.from('MetaExam-License-v1.' + e.protected + '.' + e.payload, 'ascii');
    if (signature.length !== 64 || !verify(null, message, key, signature))
      throw new LicenseError('BAD_SIGNATURE');
    const decoded = json(decode(e.payload));
    if (
      decoded &&
      typeof decoded === 'object' &&
      'product' in decoded &&
      decoded.product !== 'MetaExam'
    )
      throw new LicenseError('WRONG_PRODUCT');
    const payload = licensePayloadSchema.parse(decoded);
    if (payload.installationId !== context.installationId) throw new LicenseError('WRONG_INSTANCE');
    if (payload.deviceHash !== context.deviceHash) throw new LicenseError('WRONG_DEVICE');
    const actual = version(context.appVersion),
      min = version(payload.minAppVersion);
    let compare = 0;
    for (let n = 0; n < 3; n++) {
      compare = actual[n]! - min[n]!;
      if (compare) break;
    }
    if (compare < 0 || actual[0]! > payload.maxAppMajor || min[0]! > payload.maxAppMajor)
      throw new LicenseError('VERSION_MISMATCH');
    const start = Date.parse(payload.notBefore),
      end = payload.expiresAt ? Date.parse(payload.expiresAt) : Infinity;
    if (end <= start || Date.parse(payload.issuedAt) > start) throw new LicenseError('BAD_FORMAT');
    const now = (context.now ?? new Date()).getTime();
    if (context.lastTrustedAt && now + 300000 < context.lastTrustedAt.getTime())
      throw new LicenseError('CLOCK_ANOMALY');
    const digest = createHash('sha256').update(raw).digest('hex');
    if (payload.sequence < (context.highestSequence ?? 0)) throw new LicenseError('STALE_SEQUENCE');
    if (
      payload.sequence === context.highestSequence &&
      context.currentDigest &&
      digest !== context.currentDigest
    )
      throw new LicenseError('SEQUENCE_CONFLICT');
    if (now < start) throw new LicenseError('NOT_YET_VALID');
    if (now >= end) throw new LicenseError('EXPIRED');
    return { payload, digest, raw };
  } catch (error) {
    if (error instanceof LicenseError) throw error;
    throw new LicenseError('BAD_FORMAT');
  }
}
