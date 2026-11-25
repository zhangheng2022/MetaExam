import { createHash } from 'node:crypto';
import type { ImageAttachment } from '@metaexam/contracts';
import { QuestionRepository } from './questions';
import { audit, IdentityError, type AuditContext } from './identity';
import { readStoredFile } from './files';
export class AttachmentRepository extends QuestionRepository {
  create(
    actor: string,
    bankId: string,
    id: string,
    buffer: Buffer,
    width: number,
    height: number,
    ctx: AuditContext,
  ) {
    return this.withBank(actor, bankId, true, async (c) => {
      if (
        Number(
          (
            await c.query(
              "SELECT count(*) FROM question_attachments WHERE actor_id=$1 AND created_at>now()-interval '24 hours'",
              [actor],
            )
          ).rows[0].count,
        ) >= 100
      )
        throw new IdentityError('UPLOAD_QUOTA', 429);
      await c.query(
        'INSERT INTO question_attachments(id,bank_id,actor_id,digest,width,height,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          bankId,
          actor,
          createHash('sha256').update(buffer).digest('hex'),
          width,
          height,
          buffer.length,
        ],
      );
      await audit(c, 'question-image.upload', 'success', ctx, actor, {
        type: 'question-image',
        id,
        details: { bankId, width, height, bytes: buffer.length },
      });
      return { id, width, height, bytes: buffer.length } satisfies ImageAttachment;
    });
  }
  async content(actor: string, bankId: string, id: string) {
    const digest = await this.withBank(actor, bankId, false, async (c) => {
      const row = (
        await c.query<{ digest: string }>(
          `SELECT digest FROM question_attachments a WHERE id=$1 AND bank_id=$2 AND (actor_id=$3 OR EXISTS(SELECT 1 FROM question_version_attachments va WHERE va.attachment_id=a.id))`,
          [id, bankId, actor],
        )
      ).rows[0];
      if (!row) throw new IdentityError('NOT_FOUND', 404);
      return row.digest;
    });
    const bytes = await readStoredFile(this.db, 'images', id);
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new IdentityError('FILE_UNAVAILABLE', 503);
    return bytes;
  }
}
