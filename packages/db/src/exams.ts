import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  ExamInput,
  ExamSave,
  ExamQuery,
  ExamChoiceQuery,
  ExamDetail,
  ExamSummary,
  ExamPerson,
  StudentExam,
  PageResult,
} from '@metaexam/contracts';
import {
  examPhase,
  validExamWindow,
  publicationLicenseError,
  LicenseError,
} from '@metaexam/domain';
import { transaction, verifyPublicationLicense, type Database } from './index';
import { IdentityError, audit, type AuditContext } from './identity';
type Actor = { id: string; admin: boolean };
const scope = `( $2::boolean OR (e.owner_id=$1 AND co.enabled AND NOT EXISTS(SELECT 1 FROM exam_classes ec LEFT JOIN classes cl ON cl.id=ec.class_id WHERE ec.exam_id=e.id AND (NOT cl.enabled OR NOT EXISTS(SELECT 1 FROM teaching_assignments t WHERE t.teacher_id=$1 AND t.course_id=e.course_id AND t.class_id=ec.class_id)))))`;
const source = `exams e JOIN courses co ON co.id=e.course_id JOIN users u ON u.id=e.owner_id JOIN paper_versions pv ON pv.id=e.paper_version_id`;
const cols = `e.id,e.name,e.course_id AS "courseId",co.name AS "courseName",e.owner_id AS "ownerId",u.display_name AS "ownerName",e.paper_version_id AS "paperVersionId",pv.name AS "paperName",e.starts_at AS "startsAt",e.ends_at AS "endsAt",e.duration_minutes AS "durationMinutes",e.status,e.revision,e.published_at AS "publishedAt",e.cancelled_at AS "cancelledAt",e.cancellation_reason AS "cancellationReason",e.updated_at AS "updatedAt",(SELECT count(*)::int FROM exam_roster WHERE exam_id=e.id) AS "rosterCount",pv.total_units::float8/2 AS "totalScore",(SELECT count(*)::int FROM paper_version_items WHERE paper_version_id=pv.id) AS "itemCount"`;
const dates = (r: ExamSummary): ExamSummary => ({
  ...r,
  startsAt: new Date(r.startsAt).toISOString(),
  endsAt: new Date(r.endsAt).toISOString(),
  phase: examPhase(r.status, r.startsAt, r.endsAt),
});
export class ExamRepository {
  constructor(readonly db: Database) {}
  private run<T>(id: string, write: boolean, action: (c: PoolClient, a: Actor) => Promise<T>) {
    return transaction(this.db, async (c) => {
      if (write) await c.query('SELECT pg_advisory_xact_lock(6401204)');
      const a = (
        await c.query<{ admin: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=u.id AND role_code='admin') AS admin FROM users u JOIN user_credentials cr ON cr.user_id=u.id WHERE u.id=$1 AND u.enabled AND NOT cr.must_change_password AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp USING(role_code) WHERE ur.user_id=u.id AND ur.role_code IN ('admin','teacher') AND rp.permission_code='exams.manage')`,
          [id],
        )
      ).rows[0];
      if (!a) throw new IdentityError('FORBIDDEN', 403);
      return action(c, { id, admin: a.admin });
    });
  }
  private async get(c: PoolClient, a: Actor, id: string) {
    const row = (
      await c.query<ExamSummary>(`SELECT ${cols} FROM ${source} WHERE e.id=$3 AND ${scope}`, [
        a.id,
        a.admin,
        id,
      ])
    ).rows[0];
    if (!row) throw new IdentityError('NOT_FOUND', 404);
    return dates(row);
  }
  private revision(e: ExamSummary, revision: number) {
    if (e.revision !== revision) throw new IdentityError('EDIT_CONFLICT', 409);
  }
  private async eligible(c: PoolClient, a: Actor, courseId: string, classIds: string[]) {
    const classes = (
      await c.query<{ id: string; name: string }>(
        `SELECT cl.id,cl.name FROM classes cl JOIN courses co ON co.id=$2 WHERE cl.id=ANY($1::uuid[]) AND cl.enabled AND co.enabled AND ($3::boolean OR EXISTS(SELECT 1 FROM teaching_assignments t WHERE t.class_id=cl.id AND t.course_id=co.id AND t.teacher_id=$4)) ORDER BY cl.id`,
        [classIds, courseId, a.admin, a.id],
      )
    ).rows;
    if (classes.length !== classIds.length || !classIds.length)
      throw new IdentityError('EXAM_CLASSES_INVALID', 409);
    const people = (
      await c.query<ExamPerson>(
        `SELECT DISTINCT u.id,u.username,u.display_name AS "displayName" FROM class_members cm JOIN users u ON u.id=cm.student_id WHERE cm.class_id=ANY($1::uuid[]) AND u.enabled AND EXISTS(SELECT 1 FROM user_roles WHERE user_id=u.id AND role_code='student') ORDER BY u.id LIMIT 5001`,
        [classIds],
      )
    ).rows;
    if (people.length > 5000) throw new IdentityError('EXAM_ROSTER_LIMIT', 400);
    return { classes, people };
  }
  private async paper(c: PoolClient, a: Actor, id: string) {
    const p = (
      await c.query<{ course_id: string }>(
        `SELECT v.course_id FROM paper_versions v JOIN papers p ON p.id=v.paper_id JOIN courses co ON co.id=v.course_id WHERE v.id=$1 AND p.status='frozen' AND co.enabled AND ($2::boolean OR p.owner_id=$3)`,
        [id, a.admin, a.id],
      )
    ).rows[0];
    if (!p) throw new IdentityError('EXAM_PAPER_INVALID', 409);
    return p;
  }
  private async prepare(c: PoolClient, a: Actor, input: ExamInput) {
    if (!validExamWindow(input.startsAt, input.endsAt, input.durationMinutes))
      throw new IdentityError('EXAM_TIME_INVALID', 400);
    const p = await this.paper(c, a, input.paperVersionId);
    return { ...(await this.eligible(c, a, p.course_id, input.classIds)), courseId: p.course_id };
  }
  private async rosterWrite(
    c: PoolClient,
    id: string,
    selection: { classes: { id: string; name: string }[]; people: ExamPerson[] },
  ) {
    await c.query('DELETE FROM exam_roster WHERE exam_id=$1', [id]);
    await c.query('DELETE FROM exam_classes WHERE exam_id=$1', [id]);
    await c.query(
      `INSERT INTO exam_classes SELECT $1,x.id,x.name FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,name text)`,
      [id, JSON.stringify(selection.classes)],
    );
    await c.query(
      `INSERT INTO exam_roster SELECT $1,x.id,x.username,x."displayName" FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,username text,"displayName" text)`,
      [id, JSON.stringify(selection.people)],
    );
  }
  create(actor: string, input: ExamInput, ctx: AuditContext) {
    return this.run(actor, true, async (c, a) => {
      const selection = await this.prepare(c, a, input),
        id = randomUUID();
      await c.query(
        'INSERT INTO exams(id,owner_id,course_id,paper_version_id,name,starts_at,ends_at,duration_minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          a.id,
          selection.courseId,
          input.paperVersionId,
          input.name,
          input.startsAt,
          input.endsAt,
          input.durationMinutes,
        ],
      );
      await this.rosterWrite(c, id, selection);
      await audit(c, 'exam.create', 'success', ctx, a.id, {
        type: 'exam',
        id,
        details: { rosterCount: selection.people.length },
      });
      return { id };
    });
  }
  save(actor: string, id: string, input: ExamSave, ctx: AuditContext) {
    return this.run(actor, true, async (c, a) => {
      const e = await this.get(c, a, id);
      this.revision(e, input.revision);
      if (e.status !== 'draft') throw new IdentityError('EXAM_IMMUTABLE', 409);
      const selection = await this.prepare(c, a, input);
      // Course is fixed; choosing a different paper within it is allowed in a draft.
      if (selection.courseId !== e.courseId) throw new IdentityError('EXAM_PAPER_INVALID', 409);
      await c.query(
        'UPDATE exams SET name=$2,paper_version_id=$3,starts_at=$4,ends_at=$5,duration_minutes=$6,revision=revision+1,updated_at=now() WHERE id=$1',
        [id, input.name, input.paperVersionId, input.startsAt, input.endsAt, input.durationMinutes],
      );
      await this.rosterWrite(c, id, selection);
      await audit(c, 'exam.save', 'success', ctx, a.id, {
        type: 'exam',
        id,
        details: { rosterCount: selection.people.length },
      });
      return { id };
    });
  }
  list(actor: string, q: ExamQuery): Promise<PageResult<ExamSummary>> {
    return this.run(actor, false, async (c, a) => {
      const where = `${scope} AND ($3='' OR strpos(lower(e.name),lower($3))>0) AND ($4::text IS NULL OR e.status=$4)`,
        values = [a.id, a.admin, q.q, q.status ?? null];
      const items = (
        await c.query<ExamSummary>(
          `SELECT ${cols} FROM ${source} WHERE ${where} ORDER BY e.updated_at DESC,e.id LIMIT $5 OFFSET $6`,
          [...values, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows.map(dates);
      return {
        items,
        total: Number(
          (await c.query(`SELECT count(*) FROM ${source} WHERE ${where}`, values)).rows[0].count,
        ),
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }
  detail(actor: string, id: string): Promise<ExamDetail> {
    return this.run(actor, false, async (c, a) => {
      const e = await this.get(c, a, id);
      const extra = (
        await c.query(
          `SELECT publication_capacity AS "publicationCapacity",license_expires_at AS "licenseExpiresAt" FROM exams WHERE id=$1`,
          [id],
        )
      ).rows[0];
      const classes = (
        await c.query(
          'SELECT class_id AS id,name FROM exam_classes WHERE exam_id=$1 ORDER BY class_id',
          [id],
        )
      ).rows;
      return { ...e, ...extra, classes };
    });
  }
  roster(actor: string, id: string, q: ExamQuery): Promise<PageResult<ExamPerson>> {
    return this.run(actor, false, async (c, a) => {
      await this.get(c, a, id);
      const where = `exam_id=$1 AND ($2='' OR strpos(lower(username||' '||display_name),lower($2))>0)`;
      return {
        items: (
          await c.query<ExamPerson>(
            `SELECT user_id AS id,username,display_name AS "displayName" FROM exam_roster WHERE ${where} ORDER BY username,user_id LIMIT $3 OFFSET $4`,
            [id, q.q, q.pageSize, (q.page - 1) * q.pageSize],
          )
        ).rows,
        total: Number(
          (await c.query(`SELECT count(*) FROM exam_roster WHERE ${where}`, [id, q.q])).rows[0]
            .count,
        ),
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }
  choices(actor: string, kind: 'papers' | 'classes', q: ExamChoiceQuery) {
    return this.run(actor, false, async (c, a) => {
      const from =
        kind === 'papers'
          ? `paper_versions v JOIN papers p ON p.id=v.paper_id JOIN courses co ON co.id=v.course_id`
          : `classes cl JOIN courses co ON co.id=$3`;
      const where =
        kind === 'papers'
          ? `p.status='frozen' AND co.enabled AND ($2::boolean OR (p.owner_id=$1 AND EXISTS(SELECT 1 FROM teaching_assignments t JOIN classes cl ON cl.id=t.class_id WHERE t.teacher_id=$1 AND t.course_id=co.id AND cl.enabled))) AND ($3::uuid IS NULL OR co.id=$3) AND ($4='' OR strpos(lower(v.name),lower($4))>0)`
          : `cl.enabled AND co.enabled AND ($2::boolean OR EXISTS(SELECT 1 FROM teaching_assignments t WHERE t.teacher_id=$1 AND t.course_id=co.id AND t.class_id=cl.id)) AND ($4='' OR strpos(lower(cl.name||' '||cl.code),lower($4))>0)`;
      const fields =
        kind === 'papers'
          ? `v.id,v.name,left(v.id::text,8) AS code,co.id AS "courseId",co.name AS "courseName"`
          : `cl.id,cl.name,cl.code`;
      const values = [a.id, a.admin, q.courseId ?? null, q.q];
      return {
        items: (
          await c.query(
            `SELECT ${fields} FROM ${from} WHERE ${where} ORDER BY 2,1 LIMIT $5 OFFSET $6`,
            [...values, q.pageSize, (q.page - 1) * q.pageSize],
          )
        ).rows,
        total: Number(
          (await c.query(`SELECT count(*) FROM ${from} WHERE ${where}`, values)).rows[0].count,
        ),
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }
  publish(actor: string, id: string, revision: number, ctx: AuditContext) {
    return this.run(actor, true, async (c, a) => {
      const e = await this.get(c, a, id);
      if (e.status === 'published') return { id };
      this.revision(e, revision);
      if (e.status !== 'draft') throw new IdentityError('EXAM_IMMUTABLE', 409);
      if (Date.parse(e.startsAt) <= Date.now()) throw new IdentityError('EXAM_START_PASSED', 409);
      await this.paper(c, a, e.paperVersionId);
      const classIds = (
        await c.query<{ id: string }>('SELECT class_id AS id FROM exam_classes WHERE exam_id=$1', [
          id,
        ])
      ).rows.map((r) => r.id);
      const current = await this.eligible(c, a, e.courseId, classIds);
      const saved = (
        await c.query<ExamPerson>(
          'SELECT user_id AS id,username,display_name AS "displayName" FROM exam_roster WHERE exam_id=$1 ORDER BY user_id',
          [id],
        )
      ).rows;
      if (!saved.length) throw new IdentityError('EXAM_ROSTER_EMPTY', 409);
      if (JSON.stringify(saved) !== JSON.stringify(current.people))
        throw new IdentityError('EXAM_ROSTER_STALE', 409);
      let license;
      try {
        license = await verifyPublicationLicense(this.db, c);
      } catch (error) {
        if (error instanceof LicenseError) throw new IdentityError('EXAM_LICENSE_INVALID', 409);
        throw error;
      }
      const denied = publicationLicenseError(license, e.startsAt);
      if (denied) throw new IdentityError(denied, 409);
      await c.query(
        `UPDATE exams SET status='published',published_at=now(),revision=revision+1,updated_at=now(),license_id=$2,license_sequence=$3,publication_capacity=$4,license_expires_at=$5 WHERE id=$1`,
        [id, license.licenseId, license.sequence, license.maxConcurrentAttempts, license.expiresAt],
      );
      await audit(c, 'exam.publish', 'success', ctx, a.id, {
        type: 'exam',
        id,
        details: { paperVersionId: e.paperVersionId, rosterCount: saved.length },
      });
      return { id };
    });
  }
  cancel(actor: string, id: string, revision: number, reason: string, ctx: AuditContext) {
    return this.run(actor, true, async (c, a) => {
      const e = await this.get(c, a, id);
      if (e.status === 'cancelled') return { id };
      this.revision(e, revision);
      if (e.status !== 'published' || Date.parse(e.startsAt) <= Date.now())
        throw new IdentityError('EXAM_CANCEL_DENIED', 409);
      await c.query(
        `UPDATE exams SET status='cancelled',cancelled_at=now(),cancellation_reason=$2,revision=revision+1,updated_at=now() WHERE id=$1`,
        [id, reason],
      );
      await audit(c, 'exam.cancel', 'success', ctx, a.id, { type: 'exam', id });
      return { id };
    });
  }
  async mine(actor: string, q: ExamQuery): Promise<PageResult<StudentExam>> {
    return transaction(this.db, async (c) => {
      const allowed = await c.query(
        `SELECT 1 FROM users u JOIN user_credentials cr ON cr.user_id=u.id JOIN user_roles ur ON ur.user_id=u.id AND ur.role_code='student' JOIN role_permissions rp ON rp.role_code=ur.role_code AND rp.permission_code='exams.self' WHERE u.id=$1 AND u.enabled AND NOT cr.must_change_password`,
        [actor],
      );
      if (!allowed.rowCount) throw new IdentityError('FORBIDDEN', 403);
      const where = `e.status<>'draft' AND EXISTS(SELECT 1 FROM exam_roster r WHERE r.exam_id=e.id AND r.user_id=$1) AND ($2='' OR strpos(lower(e.name),lower($2))>0)`;
      const rows = (
        await c.query<ExamSummary>(
          `SELECT e.id,e.name,co.name AS "courseName",e.starts_at AS "startsAt",e.ends_at AS "endsAt",e.duration_minutes AS "durationMinutes",e.status,e.cancellation_reason AS "cancellationReason",pv.total_units::float8/2 AS "totalScore",(SELECT count(*)::int FROM paper_version_items WHERE paper_version_id=pv.id) AS "itemCount",(SELECT id FROM exam_attempts WHERE exam_id=e.id AND user_id=$1) AS "attemptId",(SELECT status FROM exam_attempts WHERE exam_id=e.id AND user_id=$1) AS "attemptStatus" FROM ${source} WHERE ${where} ORDER BY e.starts_at DESC,e.id LIMIT $3 OFFSET $4`,
          [actor, q.q, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
      const items = rows.map((r) => ({
        id: r.id,
        name: r.name,
        courseName: r.courseName,
        startsAt: new Date(r.startsAt).toISOString(),
        endsAt: new Date(r.endsAt).toISOString(),
        durationMinutes: r.durationMinutes,
        phase: examPhase(r.status, r.startsAt, r.endsAt),
        cancellationReason: r.cancellationReason,
        itemCount: r.itemCount,
        totalScore: r.totalScore,
        attemptId: r.attemptId ?? null,
        attemptStatus: r.attemptStatus ?? null,
      }));
      return {
        items,
        total: Number(
          (await c.query(`SELECT count(*) FROM ${source} WHERE ${where}`, [actor, q.q])).rows[0]
            .count,
        ),
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }
}
