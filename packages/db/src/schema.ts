import {
  pgTable,
  integer,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  bigint,
  primaryKey,
  index,
  check,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
const time = (name: string) => timestamp(name, { withTimezone: true });
const dates = () => ({
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});
export const questionBanks = pgTable(
  'question_banks',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    visibility: text('visibility').notNull(),
    archived: boolean('archived').notNull().default(false),
    revision: integer('revision').notNull().default(1),
    ...dates(),
  },
  (t) => [
    index('question_banks_course_idx').on(t.courseId, t.createdAt, t.id),
    index('question_banks_owner_idx').on(t.ownerId),
    check('question_banks_visibility_check', sql`${t.visibility} IN ('public','private')`),
    check('question_banks_revision_check', sql`${t.revision}>0`),
  ],
);
export const questions = pgTable(
  'questions',
  {
    id: uuid('id').primaryKey(),
    bankId: uuid('bank_id')
      .notNull()
      .references(() => questionBanks.id),
    currentVersion: integer('current_version').notNull().default(1),
    revision: integer('revision').notNull().default(1),
    archived: boolean('archived').notNull().default(false),
    ...dates(),
  },
  (t) => [
    index('questions_bank_idx').on(t.bankId, t.createdAt, t.id),
    check('questions_revision_check', sql`${t.revision}>0`),
    check('questions_current_version_check', sql`${t.currentVersion}>0`),
    foreignKey({
      name: 'questions_current_version_fk',
      columns: [t.id, t.currentVersion],
      foreignColumns: [questionVersions.questionId, questionVersions.version],
    }),
  ],
);
export const questionVersions = pgTable(
  'question_versions',
  {
    id: uuid('id').primaryKey(),
    questionId: uuid('question_id')
      .notNull()
      .references((): import('drizzle-orm/pg-core').AnyPgColumn => questions.id),
    version: integer('version').notNull(),
    content: jsonb('content').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.questionId, t.version),
    check('question_versions_version_check', sql`${t.version}>0`),
  ],
);
// The deferred current-version FK and immutable-version trigger are maintained by explicit SQL.
export const schemaMigrations = pgTable('schema_migrations', {
  version: integer('version').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: time('applied_at').notNull().defaultNow(),
});
export const instanceInfo = pgTable(
  'instance_info',
  {
    id: integer('id').primaryKey(),
    installationId: uuid('installation_id').notNull().unique(),
    deviceHash: text('device_hash').notNull(),
    fingerprintMode: text('fingerprint_mode').notNull(),
  },
  (t) => [check('instance_info_id_check', sql`${t.id}=1`)],
);
export const licenseState = pgTable(
  'license_state',
  {
    id: integer('id').primaryKey(),
    highestSequence: bigint('highest_sequence', { mode: 'bigint' }).notNull().default(0n),
    digest: text('digest'),
    raw: text('raw'),
    lastTrustedAt: time('last_trusted_at').notNull().defaultNow(),
  },
  (t) => [check('license_state_id_check', sql`${t.id}=1`)],
);
export const licenseHistory = pgTable('license_history', {
  id: uuid('id').primaryKey(),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull().unique(),
  digest: text('digest').notNull(),
  raw: text('raw').notNull(),
  importedAt: time('imported_at').notNull().defaultNow(),
});
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    businessKey: text('business_key').notNull().unique(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    leaseToken: uuid('lease_token'),
    leaseUntil: time('lease_until'),
    result: jsonb('result'),
    errorCode: text('error_code'),
    createdAt: time('created_at').notNull().defaultNow(),
    completedAt: time('completed_at'),
  },
  (t) => [
    index('jobs_claim_idx').on(t.status, t.leaseUntil, t.createdAt),
    check('jobs_kind_check', sql`${t.kind}='diagnostic.echo'`),
    check('jobs_status_check', sql`${t.status} IN ('pending','running','completed','failed')`),
  ],
);
export const workerHeartbeat = pgTable(
  'worker_heartbeat',
  { id: integer('id').primaryKey(), seenAt: time('seen_at').notNull() },
  (t) => [check('worker_heartbeat_id_check', sql`${t.id}=1`)],
);
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    username: text('username').notNull().unique(),
    displayName: text('display_name').notNull(),
    revision: integer('revision').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    ...dates(),
  },
  (t) => [
    index('users_listing_idx').on(t.createdAt, t.id),
    check(
      'users_username_check',
      sql`${t.username}=lower(btrim(${t.username})) AND ${t.username} ~ '^[a-z0-9._-]{3,64}$'`,
    ),
  ],
);
export const userCredentials = pgTable('user_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  version: integer('version').notNull().default(1),
  updatedAt: time('updated_at').notNull().defaultNow(),
});
export const roles = pgTable('roles', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
});
export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
});
export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    roleCode: text('role_code')
      .notNull()
      .references(() => roles.code),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleCode] })],
);
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleCode: text('role_code')
      .notNull()
      .references(() => roles.code),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code),
  },
  (t) => [primaryKey({ columns: [t.roleCode, t.permissionCode] })],
);
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull(),
    lastActiveAt: time('last_active_at').notNull(),
    expiresAt: time('expires_at').notNull(),
    record: jsonb('record').notNull(),
  },
  (t) => [
    index('auth_sessions_user_idx').on(t.userId),
    index('auth_sessions_expiry_idx').on(t.expiresAt),
  ],
);
export const bootstrapState = pgTable(
  'bootstrap_state',
  {
    id: integer('id').primaryKey(),
    tokenHash: text('token_hash'),
    expiresAt: time('expires_at'),
    completedAt: time('completed_at'),
    completedBy: uuid('completed_by').references(() => users.id),
  },
  (t) => [check('bootstrap_state_id_check', sql`${t.id}=1`)],
);
export const authThrottleBuckets = pgTable(
  'auth_throttle_buckets',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    expiresAt: time('expires_at').notNull(),
  },
  (t) => [index('auth_throttle_expiry_idx').on(t.expiresAt)],
);
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    actorId: uuid('actor_id').references(() => users.id),
    event: text('event').notNull(),
    outcome: text('outcome').notNull(),
    requestId: text('request_id').notNull(),
    sourceIp: text('source_ip'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: jsonb('details').notNull().default({}),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_created_idx').on(t.createdAt),
    index('audit_events_target_idx').on(t.targetType, t.targetId, t.createdAt),
  ],
);
export const classes = pgTable('classes', {
  revision: integer('revision').notNull().default(1),
  id: uuid('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ...dates(),
});
export const courses = pgTable('courses', {
  revision: integer('revision').notNull().default(1),
  id: uuid('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ...dates(),
});
export const classMembers = pgTable(
  'class_members',
  {
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    studentId: uuid('student_id')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.classId, t.studentId] }),
    index('class_members_student_idx').on(t.studentId),
  ],
);
export const teachingAssignments = pgTable(
  'teaching_assignments',
  {
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => users.id),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teacherId, t.courseId, t.classId] }),
    index('teaching_assignments_class_idx').on(t.classId),
    index('teaching_assignments_course_idx').on(t.courseId),
  ],
);
