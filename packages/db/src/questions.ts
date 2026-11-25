import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type {
  BankInput,
  BankEdit,
  BankQuery,
  QuestionQuery,
  QuestionBank,
  QuestionInput,
  QuestionSummary,
  QuestionVersion,
  QuestionDetail,
  PageResult,
} from '@metaexam/contracts';
import { transaction, type Database } from './index';
import { audit, IdentityError, type AuditContext } from './identity';
type Actor = { id: string; admin: boolean };
const bankColumns = `b.id,b.name,b.description,b.course_id AS "courseId",b.owner_id AS "ownerId",u.display_name AS "ownerName",b.visibility,b.archived,b.revision,c.name AS "courseName",c.enabled AS "courseEnabled",(SELECT count(*)::int FROM questions WHERE bank_id=b.id AND NOT archived) AS "questionCount",($2::boolean OR (b.visibility='private' AND b.owner_id=$1)) AS "canEdit"`;
const bankFrom = `question_banks b JOIN courses c ON c.id=b.course_id JOIN users u ON u.id=b.owner_id`;
// Public means available to authorized teachers of this course, never to anonymous users/students.
const bankScope = `($2::boolean OR ((b.visibility='public' OR b.owner_id=$1) AND c.enabled AND EXISTS(SELECT 1 FROM teaching_assignments a JOIN classes cl ON cl.id=a.class_id WHERE a.teacher_id=$1 AND a.course_id=b.course_id AND cl.enabled)))`;
const summary = `q.id,q.bank_id AS "bankId",q.current_version AS version,q.revision,q.archived,v.content->>'stem' AS stem,v.content->'content'->>'type' AS type,(v.content->>'difficulty')::int AS difficulty,v.content->'tags' AS tags,v.content->'knowledgePoints' AS "knowledgePoints",q.updated_at AS "updatedAt"`;
const versionColumns = `v.id,v.question_id AS "questionId",v.version,v.content AS question,v.created_at AS "createdAt",u.display_name AS "authorName"`;
export class QuestionRepository {
  constructor(readonly db: Database) {}
  private run<T>(
    actorId: string,
    write: boolean,
    action: (c: PoolClient, actor: Actor) => Promise<T>,
  ) {
    return transaction(this.db, async (c) => {
      // Same lock as role/assignment maintenance: permissions cannot be revoked mid-write.
      if (write) await c.query('SELECT pg_advisory_xact_lock(6401204)');
      const user = (
        await c.query<{ admin: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=u.id AND role_code='admin') AS admin FROM users u JOIN user_credentials cr ON cr.user_id=u.id WHERE u.id=$1 AND u.enabled AND NOT cr.must_change_password AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp USING(role_code) WHERE ur.user_id=u.id AND ur.role_code IN ('admin','teacher') AND rp.permission_code='questions.use')`,
          [actorId],
        )
      ).rows[0];
      if (!user) throw new IdentityError('FORBIDDEN', 403);
      return action(c, { id: actorId, admin: user.admin });
    });
  }
  private async page<T extends QueryResultRow>(
    c: PoolClient,
    columns: string,
    from: string,
    where: string,
    values: unknown[],
    q: { page: number; pageSize: number },
    order: string,
  ): Promise<PageResult<T>> {
    const total = Number(
      (await c.query(`SELECT count(*) FROM ${from} WHERE ${where}`, values)).rows[0].count,
    );
    const items = (
      await c.query<T>(
        `SELECT ${columns} FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, q.pageSize, (q.page - 1) * q.pageSize],
      )
    ).rows;
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
  private async bank(c: PoolClient, actor: Actor, id: string) {
    const row = (
      await c.query<QuestionBank>(
        `SELECT ${bankColumns} FROM ${bankFrom} WHERE b.id=$3 AND ${bankScope}`,
        [actor.id, actor.admin, id],
      )
    ).rows[0];
    if (!row) throw new IdentityError('NOT_FOUND', 404);
    return row;
  }
  private editable(bank: QuestionBank, allowArchived = false) {
    if (!bank.canEdit) throw new IdentityError('FORBIDDEN', 403);
    if (!bank.courseEnabled || (!allowArchived && bank.archived))
      throw new IdentityError('BANK_READ_ONLY', 409);
  }
  courses(actorId: string, q: BankQuery) {
    return this.run(actorId, false, (c, a) =>
      this.page<{ id: string; code: string; name: string }>(
        c,
        'c.id,c.code,c.name',
        'courses c',
        `c.enabled AND ($2::boolean OR EXISTS(SELECT 1 FROM teaching_assignments a JOIN classes cl ON cl.id=a.class_id WHERE a.teacher_id=$1 AND a.course_id=c.id AND cl.enabled)) AND ($3='' OR strpos(lower(c.name||' '||c.code),lower($3))>0)`,
        [a.id, a.admin, q.q],
        q,
        'c.code,c.id',
      ),
    );
  }
  banks(actorId: string, q: BankQuery) {
    return this.run(actorId, false, (c, a) =>
      this.page<QuestionBank>(
        c,
        bankColumns,
        bankFrom,
        `${bankScope} AND ($3='' OR strpos(lower(b.name||' '||b.description),lower($3))>0) AND ($4::uuid IS NULL OR b.course_id=$4) AND ($5::boolean IS NULL OR b.archived=$5) AND ($6::text IS NULL OR b.visibility=$6)`,
        [a.id, a.admin, q.q, q.courseId ?? null, q.archived ?? null, q.visibility ?? null],
        q,
        'b.created_at DESC,b.id',
      ),
    );
  }
  getBank(actorId: string, id: string) {
    return this.run(actorId, false, (c, a) => this.bank(c, a, id));
  }
  createBank(actorId: string, input: BankInput, context: AuditContext) {
    return this.run(actorId, true, async (c, a) => {
      if (input.visibility === 'public' && !a.admin) throw new IdentityError('FORBIDDEN', 403);
      const course = await c.query(
        `SELECT 1 FROM courses c WHERE c.id=$1 AND c.enabled AND ($3::boolean OR EXISTS(SELECT 1 FROM teaching_assignments ta JOIN classes cl ON cl.id=ta.class_id WHERE ta.teacher_id=$2 AND ta.course_id=c.id AND cl.enabled))`,
        [input.courseId, a.id, a.admin],
      );
      if (!course.rowCount) throw new IdentityError('INVALID_COURSE', 409);
      const id = randomUUID();
      await c.query(
        'INSERT INTO question_banks(id,name,description,course_id,owner_id,visibility) VALUES($1,$2,$3,$4,$5,$6)',
        [id, input.name, input.description, input.courseId, a.id, input.visibility],
      );
      await audit(c, 'question-bank.create', 'success', context, a.id, {
        type: 'question-bank',
        id,
        details: { courseId: input.courseId, visibility: input.visibility },
      });
      return { id };
    });
  }
  editBank(actorId: string, id: string, input: BankEdit, context: AuditContext) {
    return this.run(actorId, true, async (c, a) => {
      const bank = await this.bank(c, a, id);
      this.editable(bank, true);
      if (bank.revision !== input.revision) throw new IdentityError('EDIT_CONFLICT', 409);
      await c.query(
        'UPDATE question_banks SET name=$2,description=$3,archived=$4,revision=revision+1,updated_at=now() WHERE id=$1',
        [id, input.name, input.description, input.archived],
      );
      await audit(c, 'question-bank.update', 'success', context, a.id, {
        type: 'question-bank',
        id,
        details: { archived: input.archived, revision: bank.revision + 1 },
      });
    });
  }
  list(actorId: string, bankId: string, q: QuestionQuery) {
    return this.run(actorId, false, async (c, a) => {
      await this.bank(c, a, bankId);
      return this.page<QuestionSummary>(
        c,
        summary,
        'questions q JOIN question_versions v ON v.question_id=q.id AND v.version=q.current_version',
        `q.bank_id=$1 AND ($2='' OR strpos(lower(v.content->>'stem'),lower($2))>0) AND ($3::text IS NULL OR v.content->'content'->>'type'=$3) AND ($4::int IS NULL OR (v.content->>'difficulty')::int=$4) AND ($5::text IS NULL OR v.content->'tags' ? $5) AND ($6::text IS NULL OR v.content->'knowledgePoints' ? $6) AND ($7::boolean IS NULL OR q.archived=$7)`,
        [
          bankId,
          q.q,
          q.type ?? null,
          q.difficulty ?? null,
          q.tag ?? null,
          q.knowledgePoint ?? null,
          q.archived ?? null,
        ],
        q,
        'q.created_at DESC,q.id',
      );
    });
  }
  private async question(c: PoolClient, bankId: string, id: string) {
    const row = (
      await c.query<QuestionSummary>(
        `SELECT ${summary} FROM questions q JOIN question_versions v ON v.question_id=q.id AND v.version=q.current_version WHERE q.bank_id=$1 AND q.id=$2`,
        [bankId, id],
      )
    ).rows[0];
    if (!row) throw new IdentityError('NOT_FOUND', 404);
    return row;
  }
  detail(actorId: string, bankId: string, id: string): Promise<QuestionDetail> {
    return this.run(actorId, false, async (c, a) => {
      await this.bank(c, a, bankId);
      const row = await this.question(c, bankId, id);
      const current = (
        await c.query<QuestionVersion>(
          `SELECT ${versionColumns} FROM question_versions v JOIN users u ON u.id=v.author_id WHERE v.question_id=$1 AND v.version=$2`,
          [id, row.version],
        )
      ).rows[0]!;
      return { ...row, current };
    });
  }
  versions(actorId: string, bankId: string, id: string, q: QuestionQuery) {
    return this.run(actorId, false, async (c, a) => {
      await this.bank(c, a, bankId);
      await this.question(c, bankId, id);
      return this.page<QuestionVersion>(
        c,
        versionColumns,
        'question_versions v JOIN users u ON u.id=v.author_id',
        'v.question_id=$1',
        [id],
        q,
        'v.version DESC',
      );
    });
  }
  save(
    actorId: string,
    bankId: string,
    input: QuestionInput,
    context: AuditContext,
    edit?: { id: string; revision: number },
  ) {
    return this.run(actorId, true, async (c, a) => {
      this.editable(await this.bank(c, a, bankId));
      const id = edit?.id ?? randomUUID();
      let version = 1;
      if (edit) {
        const old = await this.question(c, bankId, id);
        if (old.revision !== edit.revision) throw new IdentityError('EDIT_CONFLICT', 409);
        if (old.archived) throw new IdentityError('QUESTION_ARCHIVED', 409);
        version = old.version + 1;
        await c.query(
          'UPDATE questions SET current_version=$2,revision=revision+1,updated_at=now() WHERE id=$1',
          [id, version],
        );
      } else await c.query('INSERT INTO questions(id,bank_id) VALUES($1,$2)', [id, bankId]);
      const versionId = randomUUID();
      await c.query(
        'INSERT INTO question_versions(id,question_id,version,content,author_id) VALUES($1,$2,$3,$4,$5)',
        [versionId, id, version, JSON.stringify(input), a.id],
      );
      await audit(c, edit ? 'question.update' : 'question.create', 'success', context, a.id, {
        type: 'question',
        id,
        details: { bankId, version, versionId, type: input.content.type },
      });
      return { id, version, versionId };
    });
  }
  archive(
    actorId: string,
    bankId: string,
    id: string,
    input: { revision: number; archived: boolean },
    context: AuditContext,
  ) {
    return this.run(actorId, true, async (c, a) => {
      this.editable(await this.bank(c, a, bankId));
      const old = await this.question(c, bankId, id);
      if (old.revision !== input.revision) throw new IdentityError('EDIT_CONFLICT', 409);
      await c.query(
        'UPDATE questions SET archived=$2,revision=revision+1,updated_at=now() WHERE id=$1',
        [id, input.archived],
      );
      await audit(c, 'question.archive', 'success', context, a.id, {
        type: 'question',
        id,
        details: { archived: input.archived },
      });
    });
  }
}
