import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';

export const passwordSchema = z.string().min(12).max(128);
const envelopeSchema = z
  .object({
    version: z.literal(1),
    kdf: z.literal('scrypt'),
    n: z.literal(32768),
    r: z.literal(8),
    p: z.literal(1),
    salt: z.string().regex(/^[a-f0-9]{32}$/),
    iv: z.string().regex(/^[a-f0-9]{24}$/),
    tag: z.string().regex(/^[a-f0-9]{32}$/),
    data: z
      .string()
      .max(180_000_000)
      .regex(/^(?:[a-f0-9]{2})*$/),
  })
  .strict();
async function key(password: string, salt: string) {
  passwordSchema.parse(password);
  return await new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      Buffer.from(salt, 'hex'),
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
}
export async function seal(bytes: Buffer, password: string, purpose: string) {
  const salt = randomBytes(16).toString('hex'),
    iv = randomBytes(12).toString('hex');
  const derived = await key(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', derived, Buffer.from(iv, 'hex'));
    cipher.setAAD(Buffer.from(`MetaExam-Issuer-v1:${purpose}`));
    const data = Buffer.concat([cipher.update(bytes), cipher.final()]).toString('hex');
    return JSON.stringify({
      version: 1,
      kdf: 'scrypt',
      n: 32768,
      r: 8,
      p: 1,
      salt,
      iv,
      tag: cipher.getAuthTag().toString('hex'),
      data,
    });
  } finally {
    derived.fill(0);
  }
}
export async function unseal(raw: string, password: string, purpose: string) {
  try {
    const envelope = envelopeSchema.parse(JSON.parse(raw));
    const derived = await key(password, envelope.salt);
    try {
      const cipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(envelope.iv, 'hex'));
      cipher.setAAD(Buffer.from(`MetaExam-Issuer-v1:${purpose}`));
      cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      return Buffer.concat([cipher.update(Buffer.from(envelope.data, 'hex')), cipher.final()]);
    } finally {
      derived.fill(0);
    }
  } catch {
    throw new Error('UNLOCK_FAILED');
  }
}
