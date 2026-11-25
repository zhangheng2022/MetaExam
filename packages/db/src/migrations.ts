import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
export const MIGRATION = `
CREATE TABLE instance_info(id integer PRIMARY KEY CHECK(id=1), installation_id uuid NOT NULL UNIQUE, device_hash text NOT NULL, fingerprint_mode text NOT NULL);
CREATE TABLE license_state(id integer PRIMARY KEY CHECK(id=1), highest_sequence bigint NOT NULL DEFAULT 0, digest text, raw text, last_trusted_at timestamptz NOT NULL DEFAULT now());
INSERT INTO license_state(id) VALUES (1);
CREATE TABLE license_history(id uuid PRIMARY KEY, sequence bigint NOT NULL UNIQUE, digest text NOT NULL, raw text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE jobs(id uuid PRIMARY KEY, business_key text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind='diagnostic.echo'), payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')), attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz, result jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
CREATE INDEX jobs_claim_idx ON jobs(status,lease_until,created_at);
CREATE TABLE worker_heartbeat(id integer PRIMARY KEY CHECK(id=1), seen_at timestamptz NOT NULL);
`;

const identity = `
CREATE TABLE users(id uuid PRIMARY KEY, username text NOT NULL UNIQUE CHECK(username=lower(btrim(username)) AND username ~ '^[a-z0-9._-]{3,64}$'), display_name text NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE user_credentials(user_id uuid PRIMARY KEY REFERENCES users(id), password_hash text NOT NULL, version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE roles(code text PRIMARY KEY, name text NOT NULL);
CREATE TABLE permissions(code text PRIMARY KEY, name text NOT NULL);
CREATE TABLE user_roles(user_id uuid NOT NULL REFERENCES users(id), role_code text NOT NULL REFERENCES roles(code), PRIMARY KEY(user_id,role_code));
CREATE TABLE role_permissions(role_code text NOT NULL REFERENCES roles(code), permission_code text NOT NULL REFERENCES permissions(code), PRIMARY KEY(role_code,permission_code));
INSERT INTO roles VALUES ('admin','管理员'),('teacher','教师'),('student','学生');
INSERT INTO permissions VALUES ('admin.overview','查看管理概览'),('profile.read','读取本人资料'),('profile.password','修改本人密码');
INSERT INTO role_permissions SELECT 'admin',code FROM permissions;
INSERT INTO role_permissions SELECT r.code,p.code FROM roles r CROSS JOIN permissions p WHERE r.code IN ('teacher','student') AND p.code LIKE 'profile.%';
CREATE TABLE auth_sessions(id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL, last_active_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, record jsonb NOT NULL);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE bootstrap_state(id integer PRIMARY KEY CHECK(id=1), token_hash text, expires_at timestamptz, completed_at timestamptz, completed_by uuid REFERENCES users(id));
INSERT INTO bootstrap_state(id) VALUES(1);
CREATE TABLE auth_throttle_buckets(key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX auth_throttle_expiry_idx ON auth_throttle_buckets(expires_at);
CREATE TABLE audit_events(id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), event text NOT NULL, outcome text NOT NULL, request_id text NOT NULL, source_ip text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_events_created_idx ON audit_events(created_at);
`;
const teaching = `
CREATE TABLE classes(id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE courses(id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE class_members(class_id uuid NOT NULL REFERENCES classes(id), student_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(class_id,student_id));
CREATE TABLE teaching_assignments(teacher_id uuid NOT NULL REFERENCES users(id), course_id uuid NOT NULL REFERENCES courses(id), class_id uuid NOT NULL REFERENCES classes(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(teacher_id,course_id,class_id));
`;
const management = `
ALTER TABLE users ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE classes ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE courses ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE user_credentials ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE audit_events ADD COLUMN target_type text, ADD COLUMN target_id text, ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
CREATE INDEX users_listing_idx ON users(created_at,id);
CREATE INDEX class_members_student_idx ON class_members(student_id);
CREATE INDEX teaching_assignments_class_idx ON teaching_assignments(class_id);
CREATE INDEX teaching_assignments_course_idx ON teaching_assignments(course_id);
CREATE INDEX audit_events_target_idx ON audit_events(target_type,target_id,created_at);
INSERT INTO permissions VALUES ('users.manage','管理账号'),('organizations.manage','管理教学组织'),('audit.read','查看操作日志'),('teaching.self','查看本人教学信息');
INSERT INTO role_permissions SELECT 'admin',code FROM permissions WHERE code IN ('users.manage','organizations.manage','audit.read','teaching.self');
INSERT INTO role_permissions VALUES ('teacher','teaching.self'),('student','teaching.self');
`;
const questions = `
CREATE TABLE question_banks (
  id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '',
  course_id uuid NOT NULL REFERENCES courses(id), owner_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK(visibility IN ('public','private')),
  archived boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX question_banks_course_idx ON question_banks(course_id,created_at,id);
CREATE INDEX question_banks_owner_idx ON question_banks(owner_id);
CREATE TABLE questions (
  id uuid PRIMARY KEY, bank_id uuid NOT NULL REFERENCES question_banks(id),
  current_version integer NOT NULL DEFAULT 1 CHECK(current_version>0),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0), archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_bank_idx ON questions(bank_id,created_at,id);
CREATE TABLE question_versions (
  id uuid PRIMARY KEY, question_id uuid NOT NULL REFERENCES questions(id),
  version integer NOT NULL CHECK(version>0), content jsonb NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(question_id,version)
);
ALTER TABLE questions ADD CONSTRAINT questions_current_version_fk FOREIGN KEY(id,current_version) REFERENCES question_versions(question_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION reject_question_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'QUESTION_VERSION_IMMUTABLE'; END;
$$;
CREATE TRIGGER question_versions_immutable BEFORE UPDATE OR DELETE ON question_versions FOR EACH ROW EXECUTE FUNCTION reject_question_version_change();
INSERT INTO permissions VALUES ('questions.use','使用课程题库');
INSERT INTO role_permissions VALUES ('admin','questions.use'),('teacher','questions.use');
`;
const imports = `
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('diagnostic.echo','question.preflight','question.apply'));
CREATE TABLE question_imports(
 id uuid PRIMARY KEY,bank_id uuid NOT NULL REFERENCES question_banks(id),actor_id uuid NOT NULL REFERENCES users(id),
 filename text NOT NULL,source_digest text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','queued','completed','failed')),
 total integer NOT NULL DEFAULT 0,errors integer NOT NULL DEFAULT 0,duplicates integer NOT NULL DEFAULT 0,imported integer NOT NULL DEFAULT 0,skipped integer NOT NULL DEFAULT 0,
 duplicate_policy text CHECK(duplicate_policy IN ('skip','keep')),error_code text,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE INDEX question_imports_owner_idx ON question_imports(actor_id,bank_id,created_at);
CREATE TABLE question_import_rows(
 import_id uuid NOT NULL REFERENCES question_imports(id),row_number integer NOT NULL,content jsonb,errors jsonb NOT NULL,duplicate boolean NOT NULL DEFAULT false,
 question_id uuid REFERENCES questions(id),PRIMARY KEY(import_id,row_number)
);
CREATE TABLE question_attachments(
 id uuid PRIMARY KEY,bank_id uuid NOT NULL REFERENCES question_banks(id),actor_id uuid NOT NULL REFERENCES users(id),digest text NOT NULL,
 width integer NOT NULL CHECK(width>0),height integer NOT NULL CHECK(height>0),bytes integer NOT NULL CHECK(bytes>0),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX question_attachments_bank_idx ON question_attachments(bank_id);
CREATE TABLE question_version_attachments(
 version_id uuid NOT NULL REFERENCES question_versions(id),attachment_id uuid NOT NULL REFERENCES question_attachments(id),PRIMARY KEY(version_id,attachment_id)
);
CREATE INDEX question_version_attachments_file_idx ON question_version_attachments(attachment_id);
CREATE TRIGGER question_version_attachments_immutable BEFORE UPDATE OR DELETE ON question_version_attachments FOR EACH ROW EXECUTE FUNCTION reject_question_version_change();
`;
export const MIGRATIONS = [MIGRATION, identity, teaching, management, questions, imports].map(
  (sql, index) => ({
    version: index + 1,
    sql,
    checksum: createHash('sha256').update(sql).digest('hex'),
  }),
);
export const SCHEMA_VERSION = MIGRATIONS.length;
export type AppliedMigration = { version: number; checksum: string };
export function validateMigrations(rows: AppliedMigration[], complete: boolean) {
  if (rows.length > MIGRATIONS.length || (complete && rows.length !== MIGRATIONS.length))
    throw new Error('MIGRATION_VERSION_MISMATCH');
  rows.forEach((row, index) => {
    if (row.version !== index + 1) throw new Error('MIGRATION_SEQUENCE_MISMATCH');
    if (row.checksum !== MIGRATIONS[index]?.checksum)
      throw new Error('MIGRATION_CHECKSUM_MISMATCH');
  });
}
export async function migrationRows(c: Pick<PoolClient, 'query'>) {
  return (
    await c.query<AppliedMigration>(
      'SELECT version,checksum FROM schema_migrations ORDER BY version',
    )
  ).rows;
}
export const RUNTIME_TABLES = [
  'instance_info',
  'license_state',
  'license_history',
  'jobs',
  'worker_heartbeat',
  'users',
  'user_credentials',
  'roles',
  'permissions',
  'user_roles',
  'role_permissions',
  'auth_sessions',
  'bootstrap_state',
  'auth_throttle_buckets',
  'audit_events',
  'classes',
  'courses',
  'class_members',
  'teaching_assignments',
  'question_banks',
  'questions',
  'question_imports',
  'question_import_rows',
  'question_attachments',
];
// Fixed identifiers only. Never grant DDL or future tables implicitly.
export async function grantRuntimeAccess(
  c: Pick<PoolClient, 'query'>,
  role = 'metaexam_app',
  database = 'metaexam',
) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || !/^[a-z][a-z0-9_]{0,62}$/.test(database))
    throw new Error('INVALID_DATABASE_IDENTIFIER');
  await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC,' + role);
  await c.query(
    'GRANT CONNECT ON DATABASE ' +
      database +
      ' TO ' +
      role +
      '; GRANT USAGE ON SCHEMA public TO ' +
      role +
      '; GRANT SELECT ON schema_migrations TO ' +
      role,
  );
  await c.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ' + RUNTIME_TABLES.join(',') + ' TO ' + role);
  await c.query('REVOKE ALL ON question_versions FROM ' + role);
  await c.query('GRANT SELECT,INSERT ON question_versions TO ' + role);
  await c.query('REVOKE ALL ON question_version_attachments FROM ' + role);
  await c.query('GRANT SELECT,INSERT ON question_version_attachments TO ' + role);
}
