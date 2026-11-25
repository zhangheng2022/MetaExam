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
export const MIGRATIONS = [MIGRATION, identity, teaching].map((sql, index) => ({
  version: index + 1,
  sql,
  checksum: createHash('sha256').update(sql).digest('hex'),
}));
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
];
// Fixed identifiers only. Never grant DDL or future tables implicitly.
export async function grantRuntimeAccess(c: Pick<PoolClient, 'query'>) {
  await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC,metaexam_app');
  await c.query(
    'GRANT CONNECT ON DATABASE metaexam TO metaexam_app; GRANT USAGE ON SCHEMA public TO metaexam_app; GRANT SELECT ON schema_migrations TO metaexam_app',
  );
  await c.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON ' + RUNTIME_TABLES.join(',') + ' TO metaexam_app',
  );
}
