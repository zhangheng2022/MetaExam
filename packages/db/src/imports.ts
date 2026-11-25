import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ImportRow, ImportSummary, PageResult, QuestionInput } from '@metaexam/contracts';
import { QuestionRepository, appendQuestionVersion } from './questions';
import { IdentityError, audit, type AuditContext } from './identity';
import { transaction, type Database } from './index';
import { processFile, readStoredFile } from './files';
const columns = `id,bank_id AS "bankId",filename,status,total,errors,duplicates,imported,skipped,error_code AS "errorCode",duplicate_policy AS "duplicatePolicy",created_at AS "createdAt",expires_at AS "expiresAt"`;
export function questionFingerprint(q: QuestionInput) {
  const c = q.content;
  const content =
    c.type === 'single' || c.type === 'multiple'
      ? {
          type: c.type,
          options: c.options.map((o) => o.text),
          answer: c.options.flatMap((o, i) => (c.answer.includes(o.id) ? [i] : [])),
        }
      : c.type === 'blank'
        ? {
            type: c.type,
            blanks: c.blanks.map((b) => b.answers),
            caseSensitive: c.caseSensitive,
            trimWhitespace: c.trimWhitespace,
          }
        : c;
  return createHash('sha256')
    .update(JSON.stringify({ stem: q.stem, content }))
    .digest('hex');
}
async function existingFingerprints(c: PoolClient, bankId: string) {
  // Streaming rows avoids holding the entire bank in memory; compare against staged hashes.
  const result = new Set<string>();
  let cursor = '';
  for (;;) {
    const rows = (
      await c.query<{ id: string; content: QuestionInput }>(
        `SELECT q.id,v.content FROM questions q JOIN question_versions v ON v.question_id=q.id AND v.version=q.current_version WHERE q.bank_id=$1 AND ($2::uuid IS NULL OR q.id>$2::uuid) ORDER BY q.id LIMIT 200`,
        [bankId, cursor || null],
      )
    ).rows;
    for (const row of rows) result.add(questionFingerprint(row.content));
    if (rows.length < 200) break;
    cursor = rows[rows.length - 1]!.id;
  }
  return result;
}
export class ImportRepository extends QuestionRepository {
  async create(
    actor: string,
    bankId: string,
    id: string,
    filename: string,
    digest: string,
    ctx: AuditContext,
  ) {
    return this.withBank(actor, bankId, true, async (c) => {
      const count = Number(
        (
          await c.query(
            "SELECT count(*) FROM question_imports WHERE actor_id=$1 AND created_at>now()-interval '24 hours'",
            [actor],
          )
        ).rows[0].count,
      );
      if (count >= 20) throw new IdentityError('UPLOAD_QUOTA', 429);
      await c.query(
        'INSERT INTO question_imports(id,bank_id,actor_id,filename,source_digest) VALUES($1,$2,$3,$4,$5)',
        [id, bankId, actor, filename, digest],
      );
      await c.query(
        "INSERT INTO jobs(id,business_key,kind,payload) VALUES($1,$2,'question.preflight',$3)",
        [randomUUID(), 'question.preflight:' + id, JSON.stringify({ importId: id })],
      );
      await audit(c, 'question-import.upload', 'success', ctx, actor, {
        type: 'question-import',
        id,
        details: { bankId },
      });
      return { id };
    });
  }
  batches(
    actor: string,
    bankId: string,
    page: number,
    pageSize: number,
  ): Promise<PageResult<ImportSummary>> {
    return this.withBank(actor, bankId, false, async (c) => ({
      items: (
        await c.query<ImportSummary>(
          `SELECT ${columns} FROM question_imports WHERE bank_id=$1 AND actor_id=$2 ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`,
          [bankId, actor, pageSize, (page - 1) * pageSize],
        )
      ).rows,
      total: Number(
        (
          await c.query('SELECT count(*) FROM question_imports WHERE bank_id=$1 AND actor_id=$2', [
            bankId,
            actor,
          ])
        ).rows[0].count,
      ),
      page,
      pageSize,
    }));
  }
  private async owned(c: PoolClient, actor: string, bankId: string, id: string) {
    const row = (
      await c.query<ImportSummary>(
        `SELECT ${columns} FROM question_imports WHERE id=$1 AND bank_id=$2 AND actor_id=$3`,
        [id, bankId, actor],
      )
    ).rows[0];
    if (!row) throw new IdentityError('NOT_FOUND', 404);
    return row;
  }
  report(actor: string, bankId: string, id: string, page: number, pageSize: number) {
    return this.withBank(actor, bankId, false, async (c) => {
      const summary = await this.owned(c, actor, bankId, id);
      const items = (
        await c.query<ImportRow>(
          'SELECT row_number AS "rowNumber",content AS question,errors,duplicate,question_id AS "questionId" FROM question_import_rows WHERE import_id=$1 ORDER BY row_number LIMIT $2 OFFSET $3',
          [id, pageSize, (page - 1) * pageSize],
        )
      ).rows;
      return { summary, rows: { items, total: summary.total, page, pageSize } };
    });
  }
  confirm(actor: string, bankId: string, id: string, policy: 'skip' | 'keep', ctx: AuditContext) {
    return this.withBank(actor, bankId, true, async (c) => {
      const old = await this.owned(c, actor, bankId, id);
      if (['queued', 'completed'].includes(old.status)) {
        if (old.duplicatePolicy !== policy)
          throw new IdentityError('IMPORT_ALREADY_CONFIRMED', 409);
        return { id, status: old.status };
      }
      if (old.status !== 'ready' || old.errors) throw new IdentityError('IMPORT_NOT_READY', 409);
      if (
        !(await c.query('SELECT 1 FROM question_imports WHERE id=$1 AND expires_at>now()', [id]))
          .rowCount
      )
        throw new IdentityError('IMPORT_EXPIRED', 409);
      await c.query("UPDATE question_imports SET status='queued',duplicate_policy=$2 WHERE id=$1", [
        id,
        policy,
      ]);
      await c.query(
        "INSERT INTO jobs(id,business_key,kind,payload) VALUES($1,$2,'question.apply',$3)",
        [randomUUID(), 'question.apply:' + id, JSON.stringify({ importId: id })],
      );
      await audit(c, 'question-import.confirm', 'success', ctx, actor, {
        type: 'question-import',
        id,
        details: { policy },
      });
      return { id, status: 'queued' };
    });
  }
}
export interface ImportJob {
  id: string;
  kind: string;
  payload: { importId?: string };
  lease_token: string;
}
async function ownsLease(c: PoolClient, job: ImportJob) {
  if (
    !(
      await c.query(
        "SELECT 1 FROM jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rowCount
  )
    throw new Error('LEASE_LOST');
}
export async function processImportJob(db: Database, job: ImportJob) {
  const id = job.payload.importId;
  if (!id) throw new Error('INVALID_JOB');
  const row = (
    await db.pool.query<{
      actor_id: string;
      bank_id: string;
      status: string;
      source_digest: string;
    }>('SELECT actor_id,bank_id,status,source_digest FROM question_imports WHERE id=$1', [id])
  ).rows[0];
  if (!row) throw new Error('INVALID_JOB');
  const repository = new QuestionRepository(db);
  try {
    if (job.kind === 'question.preflight') {
      if (['ready', 'queued', 'completed', 'failed'].includes(row.status)) return;
      await repository.withBank(row.actor_id, row.bank_id, true, async (c) => {
        await ownsLease(c, job);
        await c.query("UPDATE question_imports SET status='processing' WHERE id=$1", [id]);
      });
      const bytes = await readStoredFile(db, 'imports', id);
      if (createHash('sha256').update(bytes).digest('hex') !== row.source_digest)
        throw new IdentityError('SOURCE_CHANGED', 400);
      const rows = await processFile<ImportRow[]>('workbook', bytes);
      await repository.withBank(row.actor_id, row.bank_id, true, async (c) => {
        await ownsLease(c, job);
        const seen = await existingFingerprints(c, row.bank_id);
        await c.query('DELETE FROM question_import_rows WHERE import_id=$1', [id]);
        for (const entry of rows) {
          if (entry.question) {
            const key = questionFingerprint(entry.question);
            entry.duplicate = seen.has(key);
            seen.add(key);
          }
          await c.query(
            'INSERT INTO question_import_rows(import_id,row_number,content,errors,duplicate) VALUES($1,$2,$3,$4,$5)',
            [
              id,
              entry.rowNumber,
              entry.question ? JSON.stringify(entry.question) : null,
              JSON.stringify(entry.errors),
              entry.duplicate,
            ],
          );
        }
        await c.query(
          "UPDATE question_imports SET status='ready',total=$2,errors=$3,duplicates=$4,error_code=NULL WHERE id=$1",
          [
            id,
            rows.length,
            rows.filter((r) => r.errors.length).length,
            rows.filter((r) => r.duplicate).length,
          ],
        );
      });
    } else {
      await repository.withBank(row.actor_id, row.bank_id, true, async (c) => {
        await ownsLease(c, job);
        const batch = (await c.query('SELECT * FROM question_imports WHERE id=$1 FOR UPDATE', [id]))
          .rows[0];
        if (['completed', 'failed'].includes(batch.status)) return;
        if (batch.status !== 'queued') throw new IdentityError('IMPORT_NOT_READY', 409);
        if (
          !(await c.query('SELECT 1 FROM question_imports WHERE id=$1 AND expires_at>now()', [id]))
            .rowCount
        )
          throw new IdentityError('IMPORT_EXPIRED', 409);
        const rows = (
          await c.query<{ row_number: number; content: QuestionInput }>(
            'SELECT row_number,content FROM question_import_rows WHERE import_id=$1 ORDER BY row_number',
            [id],
          )
        ).rows;
        const seen = await existingFingerprints(c, row.bank_id);
        let imported = 0,
          skipped = 0;
        for (const r of rows) {
          const key = questionFingerprint(r.content);
          if (batch.duplicate_policy === 'skip' && seen.has(key)) {
            skipped++;
            continue;
          }
          seen.add(key);
          const questionId = randomUUID();
          await c.query('INSERT INTO questions(id,bank_id) VALUES($1,$2)', [
            questionId,
            row.bank_id,
          ]);
          await appendQuestionVersion(c, row.bank_id, row.actor_id, questionId, 1, r.content);
          await c.query(
            'UPDATE question_import_rows SET question_id=$3 WHERE import_id=$1 AND row_number=$2',
            [id, r.row_number, questionId],
          );
          imported++;
        }
        await c.query(
          "UPDATE question_imports SET status='completed',imported=$2,skipped=$3 WHERE id=$1",
          [id, imported, skipped],
        );
        await audit(c, 'question-import.complete', 'success', { requestId: job.id }, row.actor_id, {
          type: 'question-import',
          id,
          details: { bankId: row.bank_id, imported, skipped },
        });
      });
    }
  } catch (e) {
    if (!(e instanceof IdentityError)) throw e;
    await transaction(db, async (c) => {
      await ownsLease(c, job);
      await c.query(
        "UPDATE question_imports SET status='failed',error_code=$2 WHERE id=$1 AND status<>'completed'",
        [id, e.code],
      );
      await audit(c, 'question-import.process', 'failure', { requestId: job.id }, row.actor_id, {
        type: 'question-import',
        id,
        details: { code: e.code },
      });
    });
  }
}
