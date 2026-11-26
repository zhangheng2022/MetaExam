import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  AttemptSummary,
  CandidateQuestion,
  SaveAnswer,
  CandidateAnswer,
  QuestionInput,
} from '@metaexam/contracts';
import {
  canStartAttempt,
  canContinueAttempt,
  LicenseError,
  candidateQuestion,
  validCandidateAnswer,
  isAnswered,
} from '@metaexam/domain';
import {
  transaction,
  verifyPublicationLicense,
  prepareLicenseDevice,
  type Database,
} from './index';
import { IdentityError, audit, type AuditContext } from './identity';
import { readStoredFile } from './files';
type Attempt = {
  id: string;
  exam_id: string;
  user_id: string;
  paper_version_id: string;
  name: string;
  instructions: string;
  status: 'active' | 'submitted';
  started_at: Date;
  deadline_at: Date;
  submitted_at: Date | null;
  submit_reason: 'manual' | 'timeout' | null;
  revision: number;
  license_id: string;
  license_sequence: string;
  license_not_before: Date;
  license_expires_at: Date | null;
};
async function expire(c: PoolClient, id?: string) {
  const rows = (
    await c.query<{ id: string; user_id: string }>(
      `UPDATE exam_attempts SET status='submitted',submitted_at=deadline_at,submit_reason='timeout' WHERE status='active' AND deadline_at<=clock_timestamp() ${id ? 'AND id=$1' : ''} RETURNING id,user_id`,
      id ? [id] : [],
    )
  ).rows;
  for (const r of rows)
    await audit(c, 'attempt.timeout', 'success', { requestId: 'deadline' }, r.user_id, {
      type: 'attempt',
      id: r.id,
    });
  return rows.length;
}
export async function finishExpiredAttempts(db: Database) {
  return transaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(6401205)');
    return expire(c);
  });
}
export class AttemptRepository {
  constructor(readonly db: Database) {}
  private async student(c: PoolClient, id: string) {
    const r = await c.query(
      `SELECT 1 FROM users u JOIN user_credentials cr ON cr.user_id=u.id JOIN user_roles ur ON ur.user_id=u.id AND ur.role_code='student' JOIN role_permissions rp ON rp.role_code=ur.role_code AND rp.permission_code='exams.self' WHERE u.id=$1 AND u.enabled AND NOT cr.must_change_password`,
      [id],
    );
    if (!r.rowCount) throw new IdentityError('FORBIDDEN', 403);
  }
  private async lock(c: PoolClient, actor: string, id: string) {
    await this.student(c, actor);
    let r = (
      await c.query<Attempt>(
        'SELECT a.*,e.name,p.instructions FROM exam_attempts a JOIN exams e ON e.id=a.exam_id JOIN paper_versions p ON p.id=a.paper_version_id WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE OF a',
        [id, actor],
      )
    ).rows[0];
    if (!r) throw new IdentityError('NOT_FOUND', 404);
    if (r.status === 'active' && r.deadline_at.getTime() <= Date.now()) {
      await expire(c, id);
      r = { ...r, status: 'submitted', submitted_at: r.deadline_at, submit_reason: 'timeout' };
    }
    if (
      r.status === 'active' &&
      !canContinueAttempt(
        {
          attemptId: r.id,
          licenseId: r.license_id,
          licenseSequence: Number(r.license_sequence),
          startedAt: r.started_at.toISOString(),
          licenseNotBefore: r.license_not_before.toISOString(),
          licenseExpiresAt: r.license_expires_at?.toISOString() ?? null,
          completedAt: null,
        },
        id,
      ).allowed
    )
      throw new IdentityError('ATTEMPT_GRANT_INVALID', 409);
    return r;
  }
  async start(actor: string, examId: string, ctx: AuditContext) {
    const prior = await this.db.pool.query(
      'SELECT 1 FROM exam_attempts WHERE exam_id=$1 AND user_id=$2',
      [examId, actor],
    );
    // A retry of an existing admission must not depend on hardware or a current license.
    const device = prior.rowCount ? undefined : await prepareLicenseDevice(this.db);
    return transaction(this.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(6401204)');
      await c.query('SELECT pg_advisory_xact_lock(6401205)');
      await this.student(c, actor);
      await expire(c);
      const existing = (
        await c.query<{ id: string }>(
          'SELECT id FROM exam_attempts WHERE exam_id=$1 AND user_id=$2',
          [examId, actor],
        )
      ).rows[0];
      if (existing) return { id: existing.id };
      const e = (
        await c.query<{
          paper_version_id: string;
          starts_at: Date;
          ends_at: Date;
          duration_minutes: number;
        }>(
          `SELECT e.paper_version_id,e.starts_at,e.ends_at,e.duration_minutes FROM exams e JOIN exam_roster r ON r.exam_id=e.id WHERE e.id=$1 AND r.user_id=$2 AND e.status='published'`,
          [examId, actor],
        )
      ).rows[0];
      if (!e) throw new IdentityError('NOT_FOUND', 404);
      if (Date.now() < e.starts_at.getTime() || Date.now() >= e.ends_at.getTime())
        throw new IdentityError('ATTEMPT_TIME_WINDOW', 409);
      if (
        (await c.query("SELECT 1 FROM exam_attempts WHERE user_id=$1 AND status='active'", [actor]))
          .rowCount
      )
        throw new IdentityError('ATTEMPT_OTHER_ACTIVE', 409);
      let license;
      try {
        license = await verifyPublicationLicense(this.db, c, device);
      } catch (error) {
        if (error instanceof LicenseError) throw new IdentityError('EXAM_LICENSE_INVALID', 409);
        throw error;
      }
      const count = Number(
        (
          await c.query(
            "SELECT count(*) FROM exam_attempts WHERE status='active' AND deadline_at>clock_timestamp()",
          )
        ).rows[0].count,
      );
      const decision = canStartAttempt(
        {
          state: 'valid',
          expiresAt: license.expiresAt,
          maxConcurrentAttempts: license.maxConcurrentAttempts,
          features: license.features,
        },
        count,
      );
      if (!decision.allowed)
        throw new IdentityError(
          decision.reason === 'CAPACITY_REACHED' ? 'ATTEMPT_CAPACITY' : 'EXAM_FEATURE_MISSING',
          409,
        );
      const now = new Date();
      if (now >= e.ends_at || now < e.starts_at)
        throw new IdentityError('ATTEMPT_TIME_WINDOW', 409);
      if (license.expiresAt && now.getTime() >= Date.parse(license.expiresAt))
        throw new IdentityError('EXAM_LICENSE_INVALID', 409);
      const id = randomUUID(),
        deadline = new Date(
          Math.min(e.ends_at.getTime(), now.getTime() + e.duration_minutes * 60000),
        );
      await c.query(
        'INSERT INTO exam_attempts(id,exam_id,user_id,paper_version_id,started_at,deadline_at,license_id,license_sequence,license_not_before,license_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          examId,
          actor,
          e.paper_version_id,
          now,
          deadline,
          license.licenseId,
          license.sequence,
          license.notBefore,
          license.expiresAt,
        ],
      );
      await audit(c, 'attempt.start', 'success', ctx, actor, {
        type: 'attempt',
        id,
        details: { examId },
      });
      return { id };
    });
  }
  detail(actor: string, id: string): Promise<AttemptSummary> {
    return transaction(this.db, async (c) => {
      const a = await this.lock(c, actor, id);
      const rows = (
        await c.query<{
          position: number;
          type: AttemptSummary['items'][number]['type'];
          score: number;
          answer: CandidateAnswer;
        }>(
          `SELECT i.position,v.content->'content'->>'type' AS type,i.score_units::float8/2 AS score,x.answer FROM paper_version_items i JOIN question_versions v ON v.id=i.question_version_id LEFT JOIN attempt_answers x ON x.attempt_id=$2 AND x.position=i.position WHERE i.paper_version_id=$1 ORDER BY i.position`,
          [a.paper_version_id, id],
        )
      ).rows;
      const items = rows.map((r) => ({
        position: r.position,
        type: r.type,
        score: r.score,
        answered: isAnswered(r.answer),
      }));
      return {
        id: a.id,
        examId: a.exam_id,
        name: a.name,
        instructions: a.instructions,
        status: a.status,
        startedAt: a.started_at.toISOString(),
        deadlineAt: a.deadline_at.toISOString(),
        submittedAt: a.submitted_at?.toISOString() ?? null,
        submitReason: a.submit_reason,
        revision: a.revision,
        serverTime: new Date().toISOString(),
        answeredCount: items.filter((i) => i.answered).length,
        items,
      };
    });
  }
  private async questionRow(c: PoolClient, a: Attempt, position: number) {
    const r = (
      await c.query<{ content: QuestionInput; score: number }>(
        `SELECT v.content,i.score_units::float8/2 AS score FROM paper_version_items i JOIN question_versions v ON v.id=i.question_version_id WHERE i.paper_version_id=$1 AND i.position=$2`,
        [a.paper_version_id, position],
      )
    ).rows[0];
    if (!r) throw new IdentityError('NOT_FOUND', 404);
    return r;
  }
  async question(actor: string, id: string, position: number): Promise<CandidateQuestion> {
    const result = await transaction(this.db, async (c) => {
      const a = await this.lock(c, actor, id);
      if (a.status !== 'active') return null;
      const r = await this.questionRow(c, a, position),
        saved = (
          await c.query<{ answer: CandidateAnswer; revision: number; saved_at: Date }>(
            'SELECT answer,revision,saved_at FROM attempt_answers WHERE attempt_id=$1 AND position=$2',
            [id, position],
          )
        ).rows[0];
      return {
        ...candidateQuestion(r.content),
        position,
        score: r.score,
        answer: saved?.answer ?? null,
        revision: saved?.revision ?? 0,
        savedAt: saved?.saved_at.toISOString() ?? null,
      };
    });
    if (!result) throw new IdentityError('ATTEMPT_CLOSED', 409);
    return result;
  }
  async save(actor: string, id: string, position: number, input: SaveAnswer) {
    try {
      const result = await transaction(this.db, async (c) => {
        const a = await this.lock(c, actor, id);
        if (a.status !== 'active') return null;
        const q = await this.questionRow(c, a, position);
        if (!validCandidateAnswer(q.content, input.answer))
          throw new IdentityError('INVALID_ANSWER', 400);
        const old = (
          await c.query<{
            answer: CandidateAnswer;
            revision: number;
            mutation_id: string;
            saved_at: Date;
          }>('SELECT * FROM attempt_answers WHERE attempt_id=$1 AND position=$2', [id, position])
        ).rows[0];
        const same = (
          await c.query<{ same: boolean }>(
            'SELECT $1::jsonb IS NOT DISTINCT FROM $2::jsonb AS same',
            [JSON.stringify(old?.answer ?? null), JSON.stringify(input.answer)],
          )
        ).rows[0]!.same;
        if (old?.mutation_id === input.mutationId) {
          if (!same) throw new IdentityError('ANSWER_MUTATION_REUSED', 409);
          return {
            revision: old.revision,
            attemptRevision: a.revision,
            savedAt: old.saved_at.toISOString(),
          };
        }
        if ((old?.revision ?? 0) !== input.revision)
          throw new IdentityError('ANSWER_CONFLICT', 409);
        const saved = (
          await c.query<{ revision: number; saved_at: Date }>(
            `INSERT INTO attempt_answers(attempt_id,position,answer,revision,mutation_id,saved_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()) ON CONFLICT(attempt_id,position) DO UPDATE SET answer=EXCLUDED.answer,revision=EXCLUDED.revision,mutation_id=EXCLUDED.mutation_id,saved_at=EXCLUDED.saved_at RETURNING revision,saved_at`,
            [
              id,
              position,
              JSON.stringify(input.answer),
              (old?.revision ?? 0) + 1,
              input.mutationId,
            ],
          )
        ).rows[0]!;
        await c.query('UPDATE exam_attempts SET revision=revision+1 WHERE id=$1', [id]);
        return {
          revision: saved.revision,
          attemptRevision: a.revision + 1,
          savedAt: saved.saved_at.toISOString(),
        };
      });
      if (!result) throw new IdentityError('ATTEMPT_CLOSED', 409);
      return result;
    } catch (e) {
      if (e instanceof Error && e.message === 'ATTEMPT_CLOSED')
        throw new IdentityError('ATTEMPT_CLOSED', 409);
      throw e;
    }
  }
  async submit(actor: string, id: string, revision: number, ctx: AuditContext) {
    return transaction(this.db, async (c) => {
      const a = await this.lock(c, actor, id);
      if (a.status === 'submitted') return { id };
      if (a.revision !== revision) throw new IdentityError('ANSWER_CONFLICT', 409);
      await c.query(
        "UPDATE exam_attempts SET status='submitted',submitted_at=LEAST(clock_timestamp(),deadline_at),submit_reason=CASE WHEN clock_timestamp()>=deadline_at THEN 'timeout' ELSE 'manual' END WHERE id=$1",
        [id],
      );
      await audit(c, 'attempt.submit', 'success', ctx, actor, { type: 'attempt', id });
      return { id };
    });
  }
  async image(actor: string, id: string, imageId: string) {
    const result = await transaction(this.db, async (c) => {
      const a = await this.lock(c, actor, id);
      if (a.status !== 'active') return null;
      const r = (
        await c.query<{ digest: string }>(
          `SELECT f.digest FROM question_attachments f WHERE f.id=$1 AND EXISTS(SELECT 1 FROM paper_version_items i JOIN question_version_attachments va ON va.version_id=i.question_version_id WHERE i.paper_version_id=$2 AND va.attachment_id=f.id)`,
          [imageId, a.paper_version_id],
        )
      ).rows[0];
      if (!r) throw new IdentityError('NOT_FOUND', 404);
      const bytes = await readStoredFile(this.db, 'images', imageId);
      if (createHash('sha256').update(bytes).digest('hex') !== r.digest)
        throw new IdentityError('FILE_UNAVAILABLE', 503);
      return bytes;
    });
    if (!result) throw new IdentityError('ATTEMPT_CLOSED', 409);
    return result;
  }
}
