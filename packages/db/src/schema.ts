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
  uniqueIndex,
  foreignKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
const time = (name: string) => timestamp(name, { withTimezone: true });
const dates = () => ({
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});
export const examGrading = pgTable(
  'exam_grading',
  {
    examId: uuid('exam_id')
      .primaryKey()
      .references(() => exams.id),
    revision: integer('revision').notNull().default(0),
    policyVersion: integer('policy_version').notNull().default(1),
    publishedAt: time('published_at'),
    publishedBy: uuid('published_by').references(() => users.id),
  },
  (t) => [
    check('exam_grading_revision', sql`${t.revision}>=0`),
    check('exam_grading_policy', sql`${t.policyVersion}=1`),
    check('exam_grading_release', sql`(${t.publishedAt} IS NULL)=(${t.publishedBy} IS NULL)`),
  ],
);
export const attemptScores = pgTable(
  'attempt_scores',
  {
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => examAttempts.id),
    position: integer('position').notNull(),
    scoreUnits: integer('score_units'),
    mode: text('mode').notNull(),
    revision: integer('revision').notNull().default(1),
    comment: text('comment').notNull().default(''),
    gradedBy: uuid('graded_by').references(() => users.id),
    updatedAt: time('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.position] }),
    check('attempt_scores_nonnegative', sql`${t.scoreUnits}>=0`),
    check('attempt_scores_mode', sql`${t.mode} IN ('auto','manual')`),
    check('attempt_scores_revision', sql`${t.revision}>0`),
    check('attempt_scores_comment', sql`length(${t.comment})<=2000`),
  ],
);
export const examAttempts = pgTable(
  'exam_attempts',
  {
    id: uuid('id').primaryKey(),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    paperVersionId: uuid('paper_version_id')
      .notNull()
      .references(() => paperVersions.id),
    status: text('status').notNull().default('active'),
    startedAt: time('started_at').notNull(),
    deadlineAt: time('deadline_at').notNull(),
    submittedAt: time('submitted_at'),
    submitReason: text('submit_reason'),
    revision: integer('revision').notNull().default(0),
    licenseId: text('license_id').notNull(),
    licenseSequence: bigint('license_sequence', { mode: 'number' }).notNull(),
    licenseNotBefore: time('license_not_before').notNull(),
    licenseExpiresAt: time('license_expires_at'),
  },
  (t) => [
    unique().on(t.examId, t.userId),
    uniqueIndex('exam_attempts_one_active_user')
      .on(t.userId)
      .where(sql`${t.status}='active'`),
    index('exam_attempts_deadline_idx')
      .on(t.deadlineAt)
      .where(sql`${t.status}='active'`),
    check('exam_attempts_status_check', sql`${t.status} IN ('active','submitted')`),
    check('exam_attempts_revision_check', sql`${t.revision}>=0`),
    check('exam_attempts_license_sequence_check', sql`${t.licenseSequence}>0`),
    check('exam_attempts_submit_reason_check', sql`${t.submitReason} IN ('manual','timeout')`),
    check('exam_attempts_check', sql`${t.deadlineAt}>${t.startedAt}`),
    check(
      'exam_attempts_check1',
      sql`${t.startedAt}>=${t.licenseNotBefore} AND (${t.licenseExpiresAt} IS NULL OR ${t.startedAt}<${t.licenseExpiresAt})`,
    ),
    check(
      'exam_attempts_check2',
      sql`(${t.status}='active' AND ${t.submittedAt} IS NULL AND ${t.submitReason} IS NULL) OR (${t.status}='submitted' AND ${t.submittedAt} IS NOT NULL AND ${t.submitReason} IS NOT NULL)`,
    ),
  ],
);
export const attemptAnswers = pgTable(
  'attempt_answers',
  {
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => examAttempts.id),
    position: integer('position').notNull(),
    answer: jsonb('answer'),
    revision: integer('revision').notNull(),
    mutationId: uuid('mutation_id').notNull(),
    savedAt: time('saved_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.position] }),
    check('attempt_answers_position_check', sql`${t.position} BETWEEN 1 AND 200`),
    check('attempt_answers_revision_check', sql`${t.revision}>0`),
  ],
);
export const exams = pgTable(
  'exams',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    paperVersionId: uuid('paper_version_id')
      .notNull()
      .references(() => paperVersions.id),
    name: text('name').notNull(),
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    status: text('status').notNull().default('draft'),
    revision: integer('revision').notNull().default(1),
    publishedAt: time('published_at'),
    cancelledAt: time('cancelled_at'),
    cancellationReason: text('cancellation_reason'),
    licenseId: text('license_id'),
    licenseSequence: bigint('license_sequence', { mode: 'number' }),
    publicationCapacity: integer('publication_capacity'),
    licenseExpiresAt: time('license_expires_at'),
    ...dates(),
  },
  (t) => [
    index('exams_owner_time_idx').on(t.ownerId, t.startsAt),
    check('exams_duration_minutes_check', sql`${t.durationMinutes} BETWEEN 1 AND 480`),
    check('exams_status_check', sql`${t.status} IN ('draft','published','cancelled')`),
    check('exams_revision_check', sql`${t.revision}>0`),
    check(
      'exams_check',
      sql`${t.endsAt}-${t.startsAt}>=${t.durationMinutes}*interval '1 minute' AND ${t.endsAt}-${t.startsAt}<=interval '7 days'`,
    ),
    check(
      'exams_check1',
      sql`${t.status}='draft' OR (${t.publishedAt} IS NOT NULL AND ${t.licenseId} IS NOT NULL AND ${t.licenseSequence} IS NOT NULL AND ${t.licenseSequence}>0 AND ${t.publicationCapacity} IS NOT NULL AND ${t.publicationCapacity}>0)`,
    ),
    check(
      'exams_check2',
      sql`${t.status}<>'cancelled' OR (${t.cancelledAt} IS NOT NULL AND length(${t.cancellationReason})>0)`,
    ),
  ],
);
export const examClasses = pgTable(
  'exam_classes',
  {
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.examId, t.classId] })],
);
export const examRoster = pgTable(
  'exam_roster',
  {
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.examId, t.userId] }),
    index('exam_roster_user_idx').on(t.userId, t.examId),
  ],
);
export const papers = pgTable(
  'papers',
  {
    id: uuid('id').primaryKey(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    instructions: text('instructions').notNull().default(''),
    status: text('status').notNull().default('draft'),
    revision: integer('revision').notNull().default(1),
    sourceVersionId: uuid('source_version_id').references((): AnyPgColumn => paperVersions.id),
    ...dates(),
  },
  (t) => [
    index('papers_owner_course_idx').on(t.ownerId, t.courseId, t.createdAt),
    check('papers_status_check', sql`${t.status} IN ('draft','frozen')`),
    check('papers_revision_check', sql`${t.revision}>0`),
  ],
);
export const paperDraftItems = pgTable(
  'paper_draft_items',
  {
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id),
    position: integer('position').notNull(),
    questionVersionId: uuid('question_version_id')
      .notNull()
      .references(() => questionVersions.id),
    scoreUnits: integer('score_units').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.paperId, t.position] }),
    unique().on(t.paperId, t.questionVersionId),
    check('paper_draft_items_position_check', sql`${t.position} BETWEEN 1 AND 200`),
    check('paper_draft_items_score_units_check', sql`${t.scoreUnits} BETWEEN 1 AND 2000`),
  ],
);
export const paperVersions = pgTable(
  'paper_versions',
  {
    id: uuid('id').primaryKey(),
    paperId: uuid('paper_id')
      .notNull()
      .unique()
      .references(() => papers.id),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    name: text('name').notNull(),
    instructions: text('instructions').notNull(),
    totalUnits: integer('total_units').notNull(),
    digest: text('digest').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [check('paper_versions_total_units_check', sql`${t.totalUnits}>0`)],
);
export const paperVersionItems = pgTable(
  'paper_version_items',
  {
    paperVersionId: uuid('paper_version_id')
      .notNull()
      .references(() => paperVersions.id),
    position: integer('position').notNull(),
    questionVersionId: uuid('question_version_id')
      .notNull()
      .references(() => questionVersions.id),
    scoreUnits: integer('score_units').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.paperVersionId, t.position] }),
    unique().on(t.paperVersionId, t.questionVersionId),
    check('paper_version_items_position_check', sql`${t.position} BETWEEN 1 AND 200`),
    check('paper_version_items_score_units_check', sql`${t.scoreUnits} BETWEEN 1 AND 2000`),
  ],
);
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
export const questionImports = pgTable(
  'question_imports',
  {
    id: uuid('id').primaryKey(),
    bankId: uuid('bank_id')
      .notNull()
      .references(() => questionBanks.id),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    filename: text('filename').notNull(),
    sourceDigest: text('source_digest').notNull(),
    status: text('status').notNull().default('pending'),
    total: integer('total').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    imported: integer('imported').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    duplicatePolicy: text('duplicate_policy'),
    errorCode: text('error_code'),
    createdAt: time('created_at').notNull().defaultNow(),
    expiresAt: time('expires_at')
      .notNull()
      .default(sql`now()+interval '24 hours'`),
  },
  (t) => [
    index('question_imports_owner_idx').on(t.actorId, t.bankId, t.createdAt),
    check(
      'question_imports_status_check',
      sql`${t.status} IN ('pending','processing','ready','queued','completed','failed')`,
    ),
    check('question_imports_duplicate_policy_check', sql`${t.duplicatePolicy} IN ('skip','keep')`),
  ],
);
export const questionImportRows = pgTable(
  'question_import_rows',
  {
    importId: uuid('import_id')
      .notNull()
      .references(() => questionImports.id),
    rowNumber: integer('row_number').notNull(),
    content: jsonb('content'),
    errors: jsonb('errors').notNull(),
    duplicate: boolean('duplicate').notNull().default(false),
    questionId: uuid('question_id').references(() => questions.id),
  },
  (t) => [primaryKey({ columns: [t.importId, t.rowNumber] })],
);
export const questionAttachments = pgTable(
  'question_attachments',
  {
    id: uuid('id').primaryKey(),
    bankId: uuid('bank_id')
      .notNull()
      .references(() => questionBanks.id),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    digest: text('digest').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('question_attachments_bank_idx').on(t.bankId),
    check('question_attachments_width_check', sql`${t.width}>0`),
    check('question_attachments_height_check', sql`${t.height}>0`),
    check('question_attachments_bytes_check', sql`${t.bytes}>0`),
  ],
);
export const questionVersionAttachments = pgTable(
  'question_version_attachments',
  {
    versionId: uuid('version_id')
      .notNull()
      .references(() => questionVersions.id),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => questionAttachments.id),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.attachmentId] }),
    index('question_version_attachments_file_idx').on(t.attachmentId),
  ],
);
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
    check(
      'jobs_kind_check',
      sql`${t.kind} IN ('diagnostic.echo','question.preflight','question.apply')`,
    ),
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
