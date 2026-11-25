import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  PaperCreate,
  PaperSave,
  PaperQuery,
  PaperCandidateQuery,
  PaperDraw,
  PaperSelection,
  PaperSummary,
  PaperDetail,
  PaperItem,
  PaperCandidate,
  PageResult,
} from '@metaexam/contracts';
import { transaction, type Database } from './index';
import { IdentityError, audit, type AuditContext } from './identity';
type Actor = { id: string; admin: boolean };
const scope = `($2::boolean OR (p.owner_id=$1 AND c.enabled AND EXISTS(SELECT 1 FROM teaching_assignments a JOIN classes cl ON cl.id=a.class_id WHERE a.teacher_id=$1 AND a.course_id=p.course_id AND cl.enabled)))`;
const from = `papers p JOIN courses c ON c.id=p.course_id JOIN users u ON u.id=p.owner_id LEFT JOIN paper_versions f ON f.paper_id=p.id`;
const columns = `p.id,p.course_id AS "courseId",p.owner_id AS "ownerId",u.display_name AS "ownerName",c.name AS "courseName",c.enabled AS "courseEnabled",p.name,p.instructions,p.status,p.revision,p.source_version_id AS "sourceVersionId",f.id AS "frozenVersionId",f.created_at AS "frozenAt",f.digest,p.updated_at AS "updatedAt",(SELECT count(*)::int FROM paper_draft_items WHERE paper_id=p.id) AS "itemCount",COALESCE((SELECT sum(score_units)::float8/2 FROM paper_draft_items WHERE paper_id=p.id),0) AS "totalScore"`;
export class PaperRepository {
  constructor(readonly db: Database) {}
  private run<T>(id: string, write: boolean, action: (c: PoolClient, a: Actor) => Promise<T>) {
    return transaction(this.db, async (c) => {
      if (write) await c.query('SELECT pg_advisory_xact_lock(6401204)');
      const row = (
        await c.query<{ admin: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=u.id AND role_code='admin') AS admin FROM users u JOIN user_credentials cr ON cr.user_id=u.id WHERE u.id=$1 AND u.enabled AND NOT cr.must_change_password AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp USING(role_code) WHERE ur.user_id=u.id AND ur.role_code IN ('admin','teacher') AND rp.permission_code='papers.use')`,
          [id],
        )
      ).rows[0];
      if (!row) throw new IdentityError('FORBIDDEN', 403);
      return action(c, { id, admin: row.admin });
    });
  }
  private async paper(c: PoolClient, a: Actor, id: string) {
    const row = (
      await c.query<PaperSummary>(`SELECT ${columns} FROM ${from} WHERE p.id=$3 AND ${scope}`, [
        a.id,
        a.admin,
        id,
      ])
    ).rows[0];
    if (!row) throw new IdentityError('NOT_FOUND', 404);
    return row;
  }
  private editable(p: PaperSummary, revision: number) {
    if (p.status === 'frozen') throw new IdentityError('PAPER_FROZEN', 409);
    if (!p.courseEnabled) throw new IdentityError('INVALID_COURSE', 409);
    if (p.revision !== revision) throw new IdentityError('EDIT_CONFLICT', 409);
  }
  private async course(c: PoolClient, a: Actor, id: string) {
    if (
      !(
        await c.query(
          `SELECT 1 FROM courses c WHERE c.id=$3 AND c.enabled AND ($2::boolean OR EXISTS(SELECT 1 FROM teaching_assignments t JOIN classes cl ON cl.id=t.class_id WHERE t.course_id=c.id AND t.teacher_id=$1 AND cl.enabled))`,
          [a.id, a.admin, id],
        )
      ).rowCount
    )
      throw new IdentityError('INVALID_COURSE', 400);
  }
  list(actor: string, q: PaperQuery): Promise<PageResult<PaperSummary>> {
    return this.run(actor, false, async (c, a) => {
      const values = [a.id, a.admin, q.q, q.courseId ?? null, q.status ?? null];
      const where = `${scope} AND ($3='' OR strpos(lower(p.name),lower($3))>0) AND ($4::uuid IS NULL OR p.course_id=$4) AND ($5::text IS NULL OR p.status=$5)`;
      return {
        items: (
          await c.query<PaperSummary>(
            `SELECT ${columns} FROM ${from} WHERE ${where} ORDER BY p.updated_at DESC,p.id LIMIT $6 OFFSET $7`,
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
  create(actor: string, input: PaperCreate, ctx: AuditContext) {
    return this.run(actor, true, async (c, a) => {
      await this.course(c, a, input.courseId);
      const id = randomUUID();
      await c.query(
        'INSERT INTO papers(id,course_id,owner_id,name,instructions) VALUES($1,$2,$3,$4,$5)',
        [id, input.courseId, a.id, input.name, input.instructions],
      );
      await audit(c, 'paper.create', 'success', ctx, a.id, { type: 'paper', id });
      return { id };
    });
  }
  private async items(c: PoolClient, p: PaperSummary): Promise<PaperItem[]> {
    const frozen = p.status === 'frozen';
    return (
      await c.query<PaperItem>(
        `SELECT v.id AS "versionId",i.score_units::float8/2 AS score,v.question_id AS "questionId",q.bank_id AS "bankId",v.version,q.current_version AS "currentVersion",(NOT q.archived AND NOT b.archived AND co.enabled) AS available,v.content AS question FROM ${frozen ? 'paper_version_items' : 'paper_draft_items'} i JOIN question_versions v ON v.id=i.question_version_id JOIN questions q ON q.id=v.question_id JOIN question_banks b ON b.id=q.bank_id JOIN courses co ON co.id=b.course_id WHERE i.${frozen ? 'paper_version_id' : 'paper_id'}=$1 ORDER BY i.position`,
        [frozen ? p.frozenVersionId : p.id],
      )
    ).rows;
  }
  detail(actor: string, id: string): Promise<PaperDetail> {
    return this.run(actor, false, async (c, a) => {
      const p = await this.paper(c, a, id);
      return { ...p, items: await this.items(c, p) };
    });
  }
  private async validateItems(c: PoolClient, a: Actor, p: PaperSummary, items: PaperSelection[]) {
    const rows = (
      await c.query<{ id: string; question_id: string }>(
        `SELECT v.id,v.question_id FROM question_versions v JOIN questions q ON q.id=v.question_id JOIN question_banks b ON b.id=q.bank_id WHERE v.id=ANY($1::uuid[]) AND b.course_id=$2 AND NOT q.archived AND NOT b.archived AND ($3::boolean OR b.visibility='public' OR b.owner_id=$4)`,
        [items.map((i) => i.versionId), p.courseId, a.admin, a.id],
      )
    ).rows;
    if (
      rows.length !== items.length ||
      new Set(rows.map((r) => r.question_id)).size !== items.length
    )
      throw new IdentityError('INVALID_PAPER_QUESTIONS', 409);
  }
  private async replace(c: PoolClient, id: string, items: PaperSelection[]) {
    await c.query('DELETE FROM paper_draft_items WHERE paper_id=$1', [id]);
    for (const [i, item] of items.entries())
      await c.query(
        'INSERT INTO paper_draft_items(paper_id,position,question_version_id,score_units) VALUES($1,$2,$3,$4)',
        [id, i + 1, item.versionId, item.score * 2],
      );
  }
  save(actor: string, id: string, input: PaperSave, ctx: AuditContext) {
    return this.run(actor, true, async (c, a) => {
      const p = await this.paper(c, a, id);
      this.editable(p, input.revision);
      await this.validateItems(c, a, p, input.items);
      await this.replace(c, id, input.items);
      await c.query(
        'UPDATE papers SET name=$2,instructions=$3,revision=revision+1,updated_at=now() WHERE id=$1',
        [id, input.name, input.instructions],
      );
      await audit(c, 'paper.save', 'success', ctx, a.id, {
        type: 'paper',
        id,
        details: { items: input.items.length },
      });
      return { id };
    });
  }
  private async candidateWhere(
    c: PoolClient,
    a: Actor,
    p: PaperSummary,
    q: Omit<PaperCandidateQuery, 'page' | 'pageSize' | 'q'> & { q?: string },
  ) {
    if (
      !(
        await c.query(
          `SELECT 1 FROM question_banks b WHERE b.id=$1 AND b.course_id=$2 AND NOT b.archived AND ($3::boolean OR b.visibility='public' OR b.owner_id=$4)`,
          [q.bankId, p.courseId, a.admin, a.id],
        )
      ).rowCount
    )
      throw new IdentityError('NOT_FOUND', 404);
    return {
      where: `q.bank_id=$1 AND NOT q.archived AND ($2::text IS NULL OR v.content->'content'->>'type'=$2) AND ($3::int IS NULL OR (v.content->>'difficulty')::int=$3) AND ($4::text IS NULL OR v.content->'tags' ? $4) AND ($5::text IS NULL OR v.content->'knowledgePoints' ? $5) AND ($6='' OR strpos(lower(v.content->>'stem'),lower($6))>0) AND NOT EXISTS(SELECT 1 FROM paper_draft_items di JOIN question_versions dv ON dv.id=di.question_version_id WHERE di.paper_id=$7 AND dv.question_id=q.id)`,
      values: [
        q.bankId,
        q.type ?? null,
        q.difficulty ?? null,
        q.tag || null,
        q.knowledgePoint || null,
        q.q ?? '',
        p.id,
      ],
    };
  }
  candidates(
    actor: string,
    id: string,
    q: PaperCandidateQuery,
  ): Promise<PageResult<PaperCandidate>> {
    return this.run(actor, false, async (c, a) => {
      const p = await this.paper(c, a, id);
      this.editable(p, p.revision);
      const { where, values } = await this.candidateWhere(c, a, p, q);
      const source =
        'questions q JOIN question_versions v ON v.question_id=q.id AND v.version=q.current_version';
      const items = (
        await c.query<PaperCandidate>(
          `SELECT q.id AS "questionId",v.id AS "versionId",v.version,v.content->>'stem' AS stem,v.content->'content'->>'type' AS type,(v.content->>'difficulty')::int AS difficulty FROM ${source} WHERE ${where} ORDER BY q.id LIMIT $8 OFFSET $9`,
          [...values, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
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
  draw(actor: string, id: string, q: PaperDraw, ctx: AuditContext) {
    return this.run(actor, true, async (c, a) => {
      const p = await this.paper(c, a, id);
      this.editable(p, q.revision);
      if (p.itemCount + q.count > 200) throw new IdentityError('PAPER_LIMIT', 400);
      const { where, values } = await this.candidateWhere(c, a, p, q);
      const rows = (
        await c.query<{ id: string }>(
          `SELECT v.id FROM questions q JOIN question_versions v ON v.question_id=q.id AND v.version=q.current_version WHERE ${where} ORDER BY random() LIMIT $8`,
          [...values, q.count],
        )
      ).rows;
      if (rows.length !== q.count) throw new IdentityError('INSUFFICIENT_QUESTIONS', 409);
      for (const [i, r] of rows.entries())
        await c.query(
          'INSERT INTO paper_draft_items(paper_id,position,question_version_id,score_units) VALUES($1,$2,$3,$4)',
          [id, p.itemCount + i + 1, r.id, q.score * 2],
        );
      await c.query('UPDATE papers SET revision=revision+1,updated_at=now() WHERE id=$1', [id]);
      await audit(c, 'paper.draw', 'success', ctx, a.id, {
        type: 'paper',
        id,
        details: { bankId: q.bankId, type: q.type, count: q.count },
      });
      return { id };
    });
  }
  freeze(actor: string, id: string, revision: number, ctx: AuditContext) {
    return this.run(actor, true, async (c, a) => {
      const p = await this.paper(c, a, id);
      if (p.status === 'frozen') return { id: p.frozenVersionId };
      this.editable(p, revision);
      const items = await this.items(c, p);
      if (!items.length) throw new IdentityError('EMPTY_PAPER', 409);
      await this.validateItems(c, a, p, items);
      const manifest = {
        schemaVersion: 1,
        paperId: id,
        courseId: p.courseId,
        name: p.name,
        instructions: p.instructions,
        items: items.map((i, position) => ({
          position: position + 1,
          versionId: i.versionId,
          scoreUnits: i.score * 2,
        })),
      };
      const versionId = randomUUID(),
        total = items.reduce((n, i) => n + i.score * 2, 0),
        digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
      await c.query(
        'INSERT INTO paper_versions(id,paper_id,course_id,name,instructions,total_units,digest,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [versionId, id, p.courseId, p.name, p.instructions, total, digest, a.id],
      );
      await c.query(
        'INSERT INTO paper_version_items(paper_version_id,position,question_version_id,score_units) SELECT $2,position,question_version_id,score_units FROM paper_draft_items WHERE paper_id=$1',
        [id, versionId],
      );
      await c.query(
        "UPDATE papers SET status='frozen',revision=revision+1,updated_at=now() WHERE id=$1",
        [id],
      );
      await audit(c, 'paper.freeze', 'success', ctx, a.id, {
        type: 'paper',
        id,
        details: { versionId, items: items.length, totalScore: total / 2 },
      });
      return { id: versionId };
    });
  }
  copy(actor: string, id: string, name: string, ctx: AuditContext) {
    return this.run(actor, true, async (c, a) => {
      const p = await this.paper(c, a, id);
      if (p.status !== 'frozen') throw new IdentityError('PAPER_NOT_FROZEN', 409);
      await this.course(c, a, p.courseId);
      // Copy retains the exact versions. Archived sources are visible but must be
      // removed/replaced before this new draft can be saved or frozen.
      const copyId = randomUUID();
      await c.query(
        'INSERT INTO papers(id,course_id,owner_id,name,instructions,source_version_id) VALUES($1,$2,$3,$4,$5,$6)',
        [copyId, p.courseId, a.id, name, p.instructions, p.frozenVersionId],
      );
      await c.query(
        'INSERT INTO paper_draft_items(paper_id,position,question_version_id,score_units) SELECT $2,position,question_version_id,score_units FROM paper_version_items WHERE paper_version_id=$1',
        [p.frozenVersionId, copyId],
      );
      await audit(c, 'paper.copy', 'success', ctx, a.id, {
        type: 'paper',
        id: copyId,
        details: { sourceVersionId: p.frozenVersionId },
      });
      return { id: copyId };
    });
  }
}
