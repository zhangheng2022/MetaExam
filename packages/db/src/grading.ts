import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  CandidateAnswer,
  QuestionInput,
  GradeInput,
  GradingQuery,
  GradingOverview,
  GradingCandidate,
  MarkingDetail,
  PageResult,
  StudentResult,
} from '@metaexam/contracts';
import { gradeObjective } from '@metaexam/domain';
import { transaction, type Database } from './index';
import { ExamRepository } from './exams';
import { IdentityError, audit, type AuditContext } from './identity';
import { readStoredFile } from './files';
type State = { revision: number; published_at: Date | null };
async function lockState(c: PoolClient, exam: string) {
  await c.query('INSERT INTO exam_grading(exam_id) VALUES($1) ON CONFLICT DO NOTHING', [exam]);
  return (
    await c.query<State>(
      'SELECT revision,published_at FROM exam_grading WHERE exam_id=$1 FOR UPDATE',
      [exam],
    )
  ).rows[0]!;
}
// One complete answer sheet per transaction. Crashes roll back all scores and are retried by Worker.
export async function gradeNextAttempt(db: Database): Promise<boolean> {
  return transaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(6401204)');
    const a = (
      await c.query<{ id: string; exam_id: string; paper_version_id: string }>(
        `SELECT a.id,a.exam_id,a.paper_version_id FROM exam_attempts a WHERE a.status='submitted' AND NOT EXISTS(SELECT 1 FROM attempt_scores s WHERE s.attempt_id=a.id) ORDER BY a.submitted_at,a.id LIMIT 1`,
      )
    ).rows[0];
    if (!a) return false;
    const state = await lockState(c, a.exam_id);
    if (state.published_at) throw new IdentityError('GRADES_IMMUTABLE', 409);
    const rows = (
      await c.query<{
        position: number;
        score_units: number;
        content: QuestionInput;
        answer: CandidateAnswer;
      }>(
        `SELECT i.position,i.score_units,v.content,x.answer FROM paper_version_items i JOIN question_versions v ON v.id=i.question_version_id LEFT JOIN attempt_answers x ON x.attempt_id=$1 AND x.position=i.position WHERE i.paper_version_id=$2 ORDER BY i.position`,
        [a.id, a.paper_version_id],
      )
    ).rows;
    for (const r of rows) {
      const score = gradeObjective(r.content, r.answer, r.score_units);
      await c.query(
        'INSERT INTO attempt_scores(attempt_id,position,score_units,mode) VALUES($1,$2,$3,$4)',
        [a.id, r.position, score, r.content.content.type === 'essay' ? 'manual' : 'auto'],
      );
    }
    await c.query('UPDATE exam_grading SET revision=revision+1 WHERE exam_id=$1', [a.exam_id]);
    await audit(c, 'grading.automatic', 'success', { requestId: 'worker-grading' }, undefined, {
      type: 'attempt',
      id: a.id,
      details: { policyVersion: 1 },
    });
    return true;
  });
}
const rosterFrom = `exam_roster r LEFT JOIN exam_attempts a ON a.exam_id=r.exam_id AND a.user_id=r.user_id LEFT JOIN LATERAL (SELECT count(*)::int AS scored,count(*) FILTER(WHERE score_units IS NULL)::int AS pending,sum(score_units)::float8/2 AS total FROM attempt_scores WHERE attempt_id=a.id) s ON true`;
export class GradingRepository {
  private readonly exams: ExamRepository;
  constructor(readonly db: Database) {
    this.exams = new ExamRepository(db);
  }
  overview(actor: string, exam: string): Promise<GradingOverview> {
    return this.exams.withAccess(actor, exam, false, async (c, e) => {
      if (e.status !== 'published') throw new IdentityError('GRADING_NOT_READY', 409);
      const state = (
        await c.query<State>('SELECT revision,published_at FROM exam_grading WHERE exam_id=$1', [
          exam,
        ])
      ).rows[0];
      const counts = (
        await c.query<{
          submitted: number;
          active: number;
          absent: number;
          pending: number;
          ready: number;
        }>(
          `SELECT count(*) FILTER(WHERE a.status='submitted')::int AS submitted,count(*) FILTER(WHERE a.status='active')::int AS active,count(*) FILTER(WHERE a.id IS NULL)::int AS absent,count(*) FILTER(WHERE a.status='submitted' AND (s.scored<>$2 OR s.pending>0))::int AS pending,count(*) FILTER(WHERE a.status='submitted' AND s.scored=$2 AND s.pending=0)::int AS ready FROM ${rosterFrom} WHERE r.exam_id=$1`,
          [exam, e.itemCount],
        )
      ).rows[0]!;
      return {
        examId: exam,
        name: e.name,
        endsAt: e.endsAt,
        totalScore: e.totalScore,
        revision: state?.revision ?? 0,
        publishedAt: state?.published_at?.toISOString() ?? null,
        rosterCount: e.rosterCount,
        submittedCount: counts.submitted,
        activeCount: counts.active,
        absentCount: counts.absent,
        pendingCount: counts.pending,
        readyCount: counts.ready,
        canPublish:
          !state?.published_at &&
          Date.now() >= Date.parse(e.endsAt) &&
          counts.active === 0 &&
          counts.pending === 0,
      };
    });
  }
  candidates(actor: string, exam: string, q: GradingQuery): Promise<PageResult<GradingCandidate>> {
    return this.exams.withAccess(actor, exam, false, async (c, e) => {
      const where = `r.exam_id=$1 AND ($2='' OR strpos(lower(r.username||' '||r.display_name),lower($2))>0)`;
      const rows = (
        await c.query<{
          id: string;
          username: string;
          display_name: string;
          attempt_id: string | null;
          status: string | null;
          scored: number;
          pending: number;
          total: number | null;
        }>(
          `SELECT r.user_id AS id,r.username,r.display_name,a.id AS attempt_id,a.status,s.scored,s.pending,s.total FROM ${rosterFrom} WHERE ${where} ORDER BY r.username,r.user_id LIMIT $3 OFFSET $4`,
          [exam, q.q, q.pageSize, (q.page - 1) * q.pageSize],
        )
      ).rows;
      return {
        items: rows.map((r) => ({
          id: r.id,
          username: r.username,
          displayName: r.display_name,
          attemptId: r.attempt_id,
          state: !r.attempt_id
            ? 'absent'
            : r.status === 'active'
              ? 'active'
              : r.scored !== e.itemCount || r.pending > 0
                ? 'pending'
                : 'ready',
          score:
            r.status === 'submitted' && r.scored === e.itemCount && r.pending === 0
              ? r.total
              : null,
        })),
        total: Number(
          (await c.query(`SELECT count(*) FROM exam_roster r WHERE ${where}`, [exam, q.q])).rows[0]
            .count,
        ),
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }
  private async attempt(c: PoolClient, exam: string, id: string) {
    const a = (
      await c.query<{ paper_version_id: string; display_name: string; username: string }>(
        `SELECT a.paper_version_id,r.display_name,r.username FROM exam_attempts a JOIN exam_roster r ON r.exam_id=a.exam_id AND r.user_id=a.user_id WHERE a.id=$1 AND a.exam_id=$2 AND a.status='submitted'`,
        [id, exam],
      )
    ).rows[0];
    if (!a) throw new IdentityError('NOT_FOUND', 404);
    return a;
  }
  detail(actor: string, exam: string, id: string, position: number): Promise<MarkingDetail> {
    return this.exams.withAccess(actor, exam, false, async (c, e) => {
      const a = await this.attempt(c, exam, id);
      const state = (
        await c.query<State>('SELECT revision,published_at FROM exam_grading WHERE exam_id=$1', [
          exam,
        ])
      ).rows[0];
      const r = (
        await c.query<{
          content: QuestionInput;
          answer: CandidateAnswer;
          score_units: number;
          awarded: number | null;
          mode: 'auto' | 'manual';
          revision: number;
          comment: string;
        }>(
          `SELECT v.content,x.answer,i.score_units,s.score_units AS awarded,s.mode,s.revision,s.comment FROM paper_version_items i JOIN question_versions v ON v.id=i.question_version_id LEFT JOIN attempt_answers x ON x.attempt_id=$1 AND x.position=i.position JOIN attempt_scores s ON s.attempt_id=$1 AND s.position=i.position WHERE i.paper_version_id=$2 AND i.position=$3`,
          [id, a.paper_version_id, position],
        )
      ).rows[0];
      if (!r) throw new IdentityError('GRADING_NOT_READY', 409);
      return {
        attemptId: id,
        examId: exam,
        displayName: a.display_name,
        username: a.username,
        publishedAt: state?.published_at?.toISOString() ?? null,
        itemCount: e.itemCount,
        items: [
          {
            position,
            question: r.content,
            answer: r.answer,
            maxScore: r.score_units / 2,
            score: r.awarded === null ? null : r.awarded / 2,
            mode: r.mode,
            revision: r.revision,
            comment: r.comment,
          },
        ],
      };
    });
  }
  save(
    actor: string,
    exam: string,
    id: string,
    position: number,
    input: GradeInput,
    ctx: AuditContext,
  ) {
    return this.exams.withAccess(actor, exam, true, async (c) => {
      await this.attempt(c, exam, id);
      const state = await lockState(c, exam);
      if (state.published_at) throw new IdentityError('GRADES_IMMUTABLE', 409);
      const r = (
        await c.query<{ mode: string; revision: number; max: number }>(
          `SELECT s.mode,s.revision,i.score_units AS max FROM attempt_scores s JOIN exam_attempts a ON a.id=s.attempt_id JOIN paper_version_items i ON i.paper_version_id=a.paper_version_id AND i.position=s.position WHERE s.attempt_id=$1 AND s.position=$2`,
          [id, position],
        )
      ).rows[0];
      if (!r) throw new IdentityError('GRADING_NOT_READY', 409);
      if (r.mode !== 'manual' || input.score * 2 > r.max)
        throw new IdentityError('GRADE_INVALID', 400);
      if (r.revision !== input.revision) throw new IdentityError('EDIT_CONFLICT', 409);
      await c.query(
        'UPDATE attempt_scores SET score_units=$3,comment=$4,graded_by=$5,revision=revision+1,updated_at=clock_timestamp() WHERE attempt_id=$1 AND position=$2',
        [id, position, input.score * 2, input.comment, actor],
      );
      await c.query('UPDATE exam_grading SET revision=revision+1 WHERE exam_id=$1', [exam]);
      await audit(c, 'grading.manual', 'success', ctx, actor, {
        type: 'attempt',
        id,
        details: { position, score: input.score },
      });
      return { revision: r.revision + 1 };
    });
  }
  publish(actor: string, exam: string, revision: number, ctx: AuditContext) {
    return this.exams.withAccess(actor, exam, true, async (c, e) => {
      if (e.status !== 'published') throw new IdentityError('GRADING_NOT_READY', 409);
      const state = await lockState(c, exam);
      if (state.published_at) return { publishedAt: state.published_at.toISOString() };
      if (state.revision !== revision) throw new IdentityError('EDIT_CONFLICT', 409);
      const pending = (
        await c.query(
          `SELECT 1 FROM exam_attempts a WHERE a.exam_id=$1 AND (a.status<>'submitted' OR EXISTS(SELECT 1 FROM paper_version_items i LEFT JOIN attempt_scores s ON s.attempt_id=a.id AND s.position=i.position WHERE i.paper_version_id=a.paper_version_id AND (s.attempt_id IS NULL OR s.score_units IS NULL))) LIMIT 1`,
          [exam],
        )
      ).rowCount;
      if (e.status !== 'published' || Date.now() < Date.parse(e.endsAt) || pending)
        throw new IdentityError('GRADING_NOT_READY', 409);
      const r = (
        await c.query<{ published_at: Date }>(
          'UPDATE exam_grading SET published_at=clock_timestamp(),published_by=$2,revision=revision+1 WHERE exam_id=$1 RETURNING published_at',
          [exam, actor],
        )
      ).rows[0]!;
      await audit(c, 'grading.publish', 'success', ctx, actor, { type: 'exam', id: exam });
      return { publishedAt: r.published_at.toISOString() };
    });
  }
  result(actor: string, exam: string): Promise<StudentResult> {
    return transaction(this.db, async (c) => {
      const row = (
        await c.query<{
          name: string;
          published_at: Date | null;
          attempt_id: string | null;
          total_units: number;
        }>(
          `SELECT e.name,g.published_at,a.id AS attempt_id,p.total_units FROM exams e JOIN paper_versions p ON p.id=e.paper_version_id JOIN exam_roster r ON r.exam_id=e.id AND r.user_id=$2 JOIN users u ON u.id=r.user_id JOIN user_credentials cr ON cr.user_id=u.id LEFT JOIN exam_grading g ON g.exam_id=e.id LEFT JOIN exam_attempts a ON a.exam_id=e.id AND a.user_id=$2 WHERE e.id=$1 AND e.status='published' AND u.enabled AND NOT cr.must_change_password AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp USING(role_code) WHERE ur.user_id=u.id AND ur.role_code='student' AND rp.permission_code='exams.self')`,
          [exam, actor],
        )
      ).rows[0];
      if (!row) throw new IdentityError('NOT_FOUND', 404);
      const base = {
        examId: exam,
        name: row.name,
        publishedAt: row.published_at?.toISOString() ?? null,
      };
      if (!row.published_at)
        return { ...base, state: 'unpublished', totalScore: null, maxScore: null, items: [] };
      if (!row.attempt_id)
        return {
          ...base,
          state: 'absent',
          totalScore: null,
          maxScore: row.total_units / 2,
          items: [],
        };
      const items = (
        await c.query<{ position: number; score: number; maxScore: number; comment: string }>(
          `SELECT s.position,s.score_units::float8/2 AS score,i.score_units::float8/2 AS "maxScore",s.comment FROM attempt_scores s JOIN exam_attempts a ON a.id=s.attempt_id JOIN paper_version_items i ON i.paper_version_id=a.paper_version_id AND i.position=s.position WHERE s.attempt_id=$1 ORDER BY s.position`,
          [row.attempt_id],
        )
      ).rows;
      return {
        ...base,
        state: 'published',
        totalScore: items.reduce((sum, i) => sum + i.score, 0),
        maxScore: row.total_units / 2,
        items,
      };
    });
  }
  image(actor: string, exam: string, id: string, file: string) {
    return this.exams.withAccess(actor, exam, false, async (c) => {
      const a = await this.attempt(c, exam, id);
      const row = (
        await c.query<{ digest: string }>(
          `SELECT f.digest FROM question_attachments f WHERE f.id=$1 AND EXISTS(SELECT 1 FROM paper_version_items i JOIN question_version_attachments v ON v.version_id=i.question_version_id WHERE i.paper_version_id=$2 AND v.attachment_id=f.id)`,
          [file, a.paper_version_id],
        )
      ).rows[0];
      if (!row) throw new IdentityError('NOT_FOUND', 404);
      const bytes = await readStoredFile(this.db, 'images', file);
      if (createHash('sha256').update(bytes).digest('hex') !== row.digest)
        throw new IdentityError('FILE_UNAVAILABLE', 503);
      return bytes;
    });
  }
}
