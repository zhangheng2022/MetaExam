import { pgTable, integer, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
export const instanceInfo = pgTable('instance_info', {
  id: integer('id').primaryKey(),
  installationId: uuid('installation_id').notNull(),
  deviceHash: text('device_hash').notNull(),
  fingerprintMode: text('fingerprint_mode').notNull(),
});
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey(),
  businessKey: text('business_key').notNull().unique(),
  status: text('status').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
