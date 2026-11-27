import { z } from 'zod';
import { issuerCustomerSchema, issuerEnvironmentSchema } from '@metaexam/contracts';

const id = z.string().min(1).max(128),
  bit = z.union([z.literal(0), z.literal(1)]);
export const backupSchema = z
  .object({
    version: z.literal(1),
    ledgerId: z.string().uuid(),
    master: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    customers: z.array(issuerCustomerSchema).max(100000),
    instances: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            customer_id: id,
            device_hash: z.string().regex(/^[a-f0-9]{64}$/),
            floor: z.number().int().nonnegative().safe(),
            reconciled: bit,
          })
          .strict(),
      )
      .max(100000),
    keys: z
      .array(
        z
          .object({
            kid: id,
            environment: issuerEnvironmentSchema,
            public_key: z.string().max(4096),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            secret: z.string().max(16384),
            enabled: bit,
          })
          .strict(),
      )
      .max(1000),
    requests: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            instance_id: z.string().uuid(),
            raw: z.string().max(65536),
          })
          .strict(),
      )
      .max(100000),
    packages: z
      .array(
        z
          .object({
            id,
            environment: issuerEnvironmentSchema,
            version: z.string(),
            raw: z.string().max(65536),
          })
          .strict(),
      )
      .max(10000),
    licenses: z
      .array(
        z
          .object({
            id,
            operation_id: id,
            instance_id: z.string().uuid(),
            kid: id,
            sequence: z.number().int().positive().safe(),
            raw: z.string().max(65536),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
            created_at: z.string().datetime(),
          })
          .strict(),
      )
      .max(100000),
    events: z
      .array(
        z
          .object({
            id: z.number().int(),
            at: z.string().datetime(),
            kind: z.string().max(64),
            object_id: id,
            note: z.string().max(1000),
          })
          .strict(),
      )
      .max(500000),
  })
  .strict();
