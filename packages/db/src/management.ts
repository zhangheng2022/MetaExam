import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { transaction, type Database } from './index';
import { audit, IdentityError, type AuditContext } from './identity';
import {
  userCreateSchema,
  type AccountImportInput,
  type AccountImportRow,
  type AccountImportResult,
} from '@metaexam/contracts';

export type PreparedAccount = Omit<AccountImportInput, 'password'> & { passwordHash: string };
type ResolvedAccount = {
  userId: string | null;
  userRevision: number | null;
  classId: string | null;
  classRevision: number | null;
  member: boolean;
};
import type {
  Assignment,
  AssignmentInput,
  AuditEvent,
  AuditQuery,
  ListQuery,
  ManagedUser,
  MyTeaching,
  Organization,
  OrganizationEdit,
  OrganizationInput,
  PageResult,
  UserCreate,
  UserEdit,
} from '@metaexam/contracts';

type Kind = 'classes' | 'courses';
const userColumns = `u.id,u.username,u.display_name AS "displayName",u.enabled,u.revision,u.created_at AS "createdAt",c.must_change_password AS "mustChangePassword",ARRAY(SELECT role_code FROM user_roles WHERE user_id=u.id ORDER BY role_code) AS roles`;
const assignmentColumns = `a.teacher_id AS "teacherId",a.course_id AS "courseId",a.class_id AS "classId",u.display_name AS "teacherName",co.name AS "courseName",cl.name AS "className",u.enabled AS "teacherEnabled",co.enabled AS "courseEnabled",cl.enabled AS "classEnabled"`;
const assignmentFrom = `teaching_assignments a JOIN users u ON u.id=a.teacher_id JOIN courses co ON co.id=a.course_id JOIN classes cl ON cl.id=a.class_id`;
const orgColumns = (kind: Kind) =>
  `o.id,o.code,o.name,o.enabled,o.revision,o.created_at AS "createdAt",${kind === 'classes' ? '(SELECT count(*)::integer FROM class_members m WHERE m.class_id=o.id)' : '0'} AS "memberCount"`;
function conflict(expected: number, actual: number) {
  if (expected !== actual) throw new IdentityError('EDIT_CONFLICT', 409);
}
export class ManagementRepository {
  constructor(readonly db: Database) {}

  private async page<T extends QueryResultRow>(
    select: string,
    from: string,
    where: string,
    values: unknown[],
    q: { page: number; pageSize: number },
    order: string,
  ): Promise<PageResult<T>> {
    const total = Number(
      (await this.db.pool.query(`SELECT count(*) FROM ${from} WHERE ${where}`, values)).rows[0]
        .count,
    );
    const items = (
      await this.db.pool.query<T>(
        `SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, q.pageSize, (q.page - 1) * q.pageSize],
      )
    ).rows;
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
  users(q: ListQuery, classId?: string) {
    return this.page<ManagedUser>(
      userColumns,
      'users u JOIN user_credentials c ON c.user_id=u.id',
      `($1='' OR strpos(lower(u.username||' '||u.display_name),lower($1))>0) AND ($2::boolean IS NULL OR u.enabled=$2) AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM user_roles WHERE user_id=u.id AND role_code=$3)) AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM class_members WHERE class_id=$4 AND student_id=u.id))`,
      [q.q, q.enabled ?? null, q.role ?? null, classId ?? null],
      q,
      'u.created_at DESC,u.id',
    );
  }
  organizations(kind: Kind, q: ListQuery) {
    return this.page<Organization>(
      orgColumns(kind),
      `${kind} o`,
      `($1='' OR strpos(lower(o.code||' '||o.name),lower($1))>0) AND ($2::boolean IS NULL OR o.enabled=$2)`,
      [q.q, q.enabled ?? null],
      q,
      'o.created_at DESC,o.id',
    );
  }
  async organization(kind: Kind, id: string) {
    const row = (
      await this.db.pool.query<Organization>(
        `SELECT ${orgColumns(kind)} FROM ${kind} o WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new IdentityError('NOT_FOUND', 404);
    return row;
  }
  assignments(q: ListQuery) {
    return this.page<Assignment>(
      assignmentColumns,
      assignmentFrom,
      `($1='' OR strpos(lower(u.display_name||' '||co.name||' '||cl.name),lower($1))>0) AND ($2::uuid IS NULL OR a.class_id=$2) AND ($3::uuid IS NULL OR a.course_id=$3)`,
      [q.q, q.classId ?? null, q.courseId ?? null],
      q,
      'a.created_at DESC,a.teacher_id,a.course_id,a.class_id',
    );
  }
  audits(q: AuditQuery) {
    return this.page<AuditEvent>(
      `a.id,u.display_name AS "actorName",a.event,a.outcome,a.target_type AS "targetType",a.target_id AS "targetId",a.details,a.request_id AS "requestId",a.created_at AS "createdAt"`,
      'audit_events a LEFT JOIN users u ON u.id=a.actor_id',
      `($1='' OR strpos(lower(a.event||' '||coalesce(u.display_name,'')||' '||coalesce(a.target_id,'')||' '||a.request_id),lower($1))>0) AND ($2::text IS NULL OR a.outcome=$2) AND ($3::timestamptz IS NULL OR a.created_at >= $3) AND ($4::timestamptz IS NULL OR a.created_at <= $4)`,
      [q.q, q.outcome ?? null, q.from ?? null, q.to ?? null],
      q,
      'a.created_at DESC,a.id',
    );
  }
  async mine(id: string): Promise<MyTeaching> {
    // Account IDs always come from the authenticated principal, never from query parameters.
    const classes = (
      await this.db.pool.query<Organization>(
        `SELECT o.id,o.code,o.name,o.enabled,o.revision,o.created_at AS "createdAt",0 AS "memberCount" FROM classes o JOIN class_members m ON m.class_id=o.id WHERE m.student_id=$1 AND EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role_code='student') ORDER BY o.code`,
        [id],
      )
    ).rows;
    const assignments = (
      await this.db.pool.query<Assignment>(
        `SELECT ${assignmentColumns} FROM ${assignmentFrom} WHERE (a.teacher_id=$1 AND EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role_code='teacher')) OR (EXISTS(SELECT 1 FROM class_members WHERE class_id=a.class_id AND student_id=$1) AND EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role_code='student')) ORDER BY cl.code,co.code,u.username`,
        [id],
      )
    ).rows;
    return { classes, assignments };
  }

  private async mutate<T>(
    actorId: string,
    permission: string,
    action: (c: PoolClient) => Promise<T>,
  ) {
    try {
      return await transaction(this.db, async (c) => {
        // Low-frequency administration mutations share one transaction lock. This protects
        // last-admin and role/assignment invariants across API processes and concurrent requests.
        await c.query('SELECT pg_advisory_xact_lock(6401204)');
        const allowed = await c.query(
          `SELECT 1 FROM users u JOIN user_credentials cr ON cr.user_id=u.id WHERE u.id=$1 AND u.enabled AND NOT cr.must_change_password AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp USING(role_code) WHERE ur.user_id=u.id AND ur.role_code='admin' AND rp.permission_code=$2)`,
          [actorId, permission],
        );
        if (!allowed.rowCount) throw new IdentityError('FORBIDDEN', 403);
        return action(c);
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
        throw new IdentityError('DUPLICATE_RECORD', 409);
      throw error;
    }
  }
  async createUser(input: UserCreate, hash: string, actor: string, context: AuditContext) {
    return this.mutate(actor, 'users.manage', async (c) => {
      const id = randomUUID();
      await c.query('INSERT INTO users(id,username,display_name) VALUES($1,$2,$3)', [
        id,
        input.username,
        input.displayName,
      ]);
      await c.query(
        'INSERT INTO user_credentials(user_id,password_hash,must_change_password) VALUES($1,$2,true)',
        [id, hash],
      );
      for (const role of input.roles)
        await c.query('INSERT INTO user_roles VALUES($1,$2)', [id, role]);
      await audit(c, 'user.create', 'success', context, actor, {
        type: 'user',
        id,
        details: { username: input.username, roles: input.roles },
      });
      return { id };
    });
  }
  private async inspectAccounts(c: PoolClient, inputs: PreparedAccount[]) {
    const rows: AccountImportRow[] = [],
      resolved: ResolvedAccount[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      const errors: string[] = [];
      if (
        !userCreateSchema.safeParse({
          username: input.username,
          displayName: input.displayName,
          roles: [input.role],
          password: 'validation-only',
        }).success ||
        !['student', 'teacher'].includes(input.role)
      )
        errors.push('用户名、姓名或角色格式错误');
      if (seen.has(input.username)) errors.push('文件内用户名重复');
      seen.add(input.username);
      const u = (
        await c.query<{
          id: string;
          revision: number;
          display_name: string;
          enabled: boolean;
          roles: string[];
        }>(
          'SELECT u.id,u.revision,u.display_name,u.enabled,ARRAY(SELECT role_code FROM user_roles WHERE user_id=u.id) AS roles FROM users u WHERE username=$1',
          [input.username],
        )
      ).rows[0];
      if (
        u &&
        (!u.enabled || u.display_name !== input.displayName || !u.roles.includes(input.role))
      )
        errors.push('已有账号停用，或姓名／角色不匹配');
      if (u && input.passwordHash) errors.push('已有账号的初始密码必须留空');
      if (!u && !input.passwordHash) errors.push('新账号必须填写 6～128 字符的初始密码');
      const cl = input.classCode
        ? (
            await c.query<{ id: string; revision: number; enabled: boolean }>(
              'SELECT id,revision,enabled FROM classes WHERE code=$1',
              [input.classCode],
            )
          ).rows[0]
        : undefined;
      if (input.classCode && (!cl?.enabled || input.role !== 'student'))
        errors.push('班级须存在且启用，并且只接受学生');
      const member = !!(
        u &&
        cl &&
        (
          await c.query('SELECT 1 FROM class_members WHERE class_id=$1 AND student_id=$2', [
            cl.id,
            u.id,
          ])
        ).rowCount
      );
      rows.push({
        row: input.row,
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        classCode: input.classCode,
        action: !u ? 'create' : cl && !member ? 'member' : 'skip',
        errors,
      });
      resolved.push({
        userId: u?.id ?? null,
        userRevision: u?.revision ?? null,
        classId: cl?.id ?? null,
        classRevision: cl?.revision ?? null,
        member,
      });
    }
    return { rows, resolved };
  }
  inspectAccountImport(actor: string, inputs: PreparedAccount[]) {
    return this.mutate(actor, 'users.manage', async (c) => {
      await this.requireOrganizationPermission(c, actor);
      return this.inspectAccounts(c, inputs);
    });
  }
  private async requireOrganizationPermission(c: PoolClient, actor: string) {
    if (
      !(
        await c.query(
          "SELECT 1 FROM user_roles r JOIN role_permissions p USING(role_code) WHERE r.user_id=$1 AND r.role_code='admin' AND p.permission_code='organizations.manage'",
          [actor],
        )
      ).rowCount
    )
      throw new IdentityError('FORBIDDEN', 403);
  }
  accountImportReceipt(actor: string, id: string) {
    return this.mutate(actor, 'users.manage', async (c) => {
      await this.requireOrganizationPermission(c, actor);
      return (
        await c.query<{ details: AccountImportResult }>(
          "SELECT details FROM audit_events WHERE actor_id=$1 AND target_id=$2 AND event='accounts.import' AND outcome='success'",
          [actor, id],
        )
      ).rows[0]?.details;
    });
  }
  confirmAccountImport(
    actor: string,
    id: string,
    inputs: PreparedAccount[],
    snapshot: string,
    context: AuditContext,
    expires: number,
  ) {
    return this.mutate(actor, 'users.manage', async (c) => {
      await this.requireOrganizationPermission(c, actor);
      const receipt = (
        await c.query<{ details: AccountImportResult }>(
          "SELECT details FROM audit_events WHERE actor_id=$1 AND target_id=$2 AND event='accounts.import' AND outcome='success'",
          [actor, id],
        )
      ).rows[0];
      if (receipt) return receipt.details;
      if (Date.now() >= expires) throw new IdentityError('ACCOUNT_IMPORT_EXPIRED', 409);
      const current = await this.inspectAccounts(c, inputs);
      if (current.rows.some((r) => r.errors.length) || JSON.stringify(current) !== snapshot)
        throw new IdentityError('ACCOUNT_IMPORT_CHANGED', 409);
      const result: AccountImportResult = { created: 0, added: 0, skipped: 0 };
      for (const [i, input] of inputs.entries()) {
        const state = current.resolved[i]!;
        const userId = state.userId ?? randomUUID();
        if (!state.userId) {
          await c.query('INSERT INTO users(id,username,display_name) VALUES($1,$2,$3)', [
            userId,
            input.username,
            input.displayName,
          ]);
          await c.query(
            'INSERT INTO user_credentials(user_id,password_hash,must_change_password) VALUES($1,$2,true)',
            [userId, input.passwordHash],
          );
          await c.query('INSERT INTO user_roles VALUES($1,$2)', [userId, input.role]);
          result.created++;
        }
        if (state.classId && !state.member) {
          await c.query('INSERT INTO class_members(class_id,student_id) VALUES($1,$2)', [
            state.classId,
            userId,
          ]);
          result.added++;
        } else if (state.userId) result.skipped++;
      }
      await audit(c, 'accounts.import', 'success', context, actor, {
        type: 'account-import',
        id,
        details: { ...result },
      });
      return result;
    });
  }
  async editUser(id: string, input: UserEdit, actor: string, context: AuditContext) {
    return this.mutate(actor, 'users.manage', async (c) => {
      const old = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!old) throw new IdentityError('NOT_FOUND', 404);
      conflict(input.revision, old.revision);
      if (id === actor && !input.enabled) throw new IdentityError('SELF_DISABLE', 409);
      const previous = (
        await c.query<{ role_code: string }>('SELECT role_code FROM user_roles WHERE user_id=$1', [
          id,
        ])
      ).rows.map((r) => r.role_code);
      if (
        old.enabled &&
        previous.includes('admin') &&
        (!input.enabled || !input.roles.includes('admin'))
      ) {
        const other = await c.query(
          `SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.enabled AND r.role_code='admin' AND u.id<>$1`,
          [id],
        );
        if (!other.rowCount) throw new IdentityError('LAST_ADMIN', 409);
      }
      if (
        !input.roles.includes('teacher') &&
        (await c.query('SELECT 1 FROM teaching_assignments WHERE teacher_id=$1 LIMIT 1', [id]))
          .rowCount
      )
        throw new IdentityError('ROLE_IN_USE', 409);
      if (
        !input.roles.includes('student') &&
        (await c.query('SELECT 1 FROM class_members WHERE student_id=$1 LIMIT 1', [id])).rowCount
      )
        throw new IdentityError('ROLE_IN_USE', 409);
      await c.query(
        'UPDATE users SET display_name=$2,enabled=$3,revision=revision+1,updated_at=now() WHERE id=$1',
        [id, input.displayName, input.enabled],
      );
      await c.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
      for (const role of input.roles)
        await c.query('INSERT INTO user_roles VALUES($1,$2)', [id, role]);
      if (!input.enabled) await c.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
      await audit(c, 'user.update', 'success', context, actor, {
        type: 'user',
        id,
        details: {
          before: { displayName: old.display_name, enabled: old.enabled, roles: previous },
          after: { displayName: input.displayName, enabled: input.enabled, roles: input.roles },
        },
      });
    });
  }
  resetPassword(id: string, hash: string, revision: number, actor: string, context: AuditContext) {
    return this.mutate(actor, 'users.manage', async (c) => {
      if (id === actor) throw new IdentityError('USE_CHANGE_PASSWORD', 409);
      const old = (await c.query('SELECT revision FROM users WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!old) throw new IdentityError('NOT_FOUND', 404);
      conflict(revision, old.revision);
      await c.query('UPDATE users SET revision=revision+1,updated_at=now() WHERE id=$1', [id]);
      await c.query(
        'UPDATE user_credentials SET password_hash=$2,must_change_password=true,version=version+1,updated_at=now() WHERE user_id=$1',
        [id, hash],
      );
      await c.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
      await audit(c, 'user.password.reset', 'success', context, actor, { type: 'user', id });
    });
  }
  createOrganization(kind: Kind, input: OrganizationInput, actor: string, context: AuditContext) {
    return this.mutate(actor, 'organizations.manage', async (c) => {
      const id = randomUUID();
      await c.query(`INSERT INTO ${kind}(id,code,name) VALUES($1,$2,$3)`, [
        id,
        input.code,
        input.name,
      ]);
      await audit(c, `${kind}.create`, 'success', context, actor, {
        type: kind,
        id,
        details: input,
      });
      return { id };
    });
  }
  editOrganization(
    kind: Kind,
    id: string,
    input: OrganizationEdit,
    actor: string,
    context: AuditContext,
  ) {
    return this.mutate(actor, 'organizations.manage', async (c) => {
      const old = (
        await c.query(`SELECT code,name,enabled,revision FROM ${kind} WHERE id=$1 FOR UPDATE`, [id])
      ).rows[0];
      if (!old) throw new IdentityError('NOT_FOUND', 404);
      conflict(input.revision, old.revision);
      await c.query(
        `UPDATE ${kind} SET code=$2,name=$3,enabled=$4,revision=revision+1,updated_at=now() WHERE id=$1`,
        [id, input.code, input.name, input.enabled],
      );
      await audit(c, `${kind}.update`, 'success', context, actor, {
        type: kind,
        id,
        details: { before: old, after: input },
      });
    });
  }
  member(
    classId: string,
    studentId: string,
    remove: boolean,
    actor: string,
    context: AuditContext,
  ) {
    return this.mutate(actor, 'organizations.manage', async (c) => {
      const group = (await c.query('SELECT enabled FROM classes WHERE id=$1', [classId])).rows[0];
      if (!group) throw new IdentityError('NOT_FOUND', 404);
      if (!remove) {
        const student = await c.query(
          `SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=$1 AND u.enabled AND r.role_code='student'`,
          [studentId],
        );
        if (!group.enabled || !student.rowCount) throw new IdentityError('INVALID_ASSIGNMENT', 409);
      }
      const result = remove
        ? await c.query('DELETE FROM class_members WHERE class_id=$1 AND student_id=$2', [
            classId,
            studentId,
          ])
        : await c.query(
            'INSERT INTO class_members(class_id,student_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [classId, studentId],
          );
      if (result.rowCount)
        await audit(c, remove ? 'member.remove' : 'member.add', 'success', context, actor, {
          type: 'classes',
          id: classId,
          details: { studentId },
        });
    });
  }
  assignment(input: AssignmentInput, remove: boolean, actor: string, context: AuditContext) {
    return this.mutate(actor, 'organizations.manage', async (c) => {
      const values = [input.teacherId, input.courseId, input.classId];
      if (!remove) {
        const eligible = await c.query(
          `SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id CROSS JOIN courses co CROSS JOIN classes cl WHERE u.id=$1 AND co.id=$2 AND cl.id=$3 AND u.enabled AND co.enabled AND cl.enabled AND r.role_code='teacher'`,
          values,
        );
        if (!eligible.rowCount) throw new IdentityError('INVALID_ASSIGNMENT', 409);
      }
      const result = remove
        ? await c.query(
            'DELETE FROM teaching_assignments WHERE teacher_id=$1 AND course_id=$2 AND class_id=$3',
            values,
          )
        : await c.query(
            'INSERT INTO teaching_assignments(teacher_id,course_id,class_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            values,
          );
      if (result.rowCount)
        await audit(c, remove ? 'assignment.remove' : 'assignment.add', 'success', context, actor, {
          type: 'assignment',
          id: values.join('/'),
          details: input,
        });
    });
  }
}
