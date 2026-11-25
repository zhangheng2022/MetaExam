import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import {
  AttachmentRepository,
  ImportRepository,
  IdentityError,
  processFile,
  writeStoredFile,
  removeStoredFile,
  audit,
} from '@metaexam/db';
import { idSchema, importConfirmSchema, listSchema } from '@metaexam/contracts';
import { Runtime } from '../database/database.module';
function parse<T>(schema: { parse: (v: unknown) => T }, value: unknown) {
  try {
    return schema.parse(value);
  } catch {
    throw new IdentityError('INVALID_REQUEST', 400);
  }
}
const pageSchema = listSchema.pick({ page: true, pageSize: true });
@Injectable()
export class QuestionFilesService {
  private busy = 0;
  readonly imports: ImportRepository;
  readonly attachments: AttachmentRepository;
  constructor(private readonly runtime: Runtime) {
    this.imports = new ImportRepository(runtime.db);
    this.attachments = new AttachmentRepository(runtime.db);
  }
  private async bounded<T>(action: () => Promise<T>) {
    if (this.busy >= 2) throw new IdentityError('RATE_LIMITED', 429);
    this.busy++;
    try {
      return await action();
    } finally {
      this.busy--;
    }
  }
  async template(actor: string, bank: string) {
    return this.bounded(async () => {
      await this.imports.withBank(actor, parse(idSchema, bank), true, async () => {});
      return Buffer.from(await processFile<Uint8Array>('template'));
    });
  }
  async upload(actor: string, bank: string, req: FastifyRequest, image: boolean) {
    return this.bounded(async () => {
      const bankId = parse(idSchema, bank),
        id = randomUUID(),
        kind = image ? 'images' : 'imports';
      let written = false;
      try {
        await this.imports.withBank(actor, bankId, true, async () => {});
        if (!req.isMultipart()) throw new IdentityError('INVALID_UPLOAD', 400);
        let buffer: Buffer | undefined,
          filename = '';
        try {
          for await (const part of req.parts({
            limits: {
              fileSize: 2 * 1024 * 1024,
              files: 1,
              fields: 0,
              parts: 1,
              fieldNameSize: 30,
              headerPairs: 32,
            },
          })) {
            if (part.type !== 'file' || part.fieldname !== 'file' || buffer)
              throw new IdentityError('INVALID_UPLOAD', 400);
            filename = part.filename.replace(/.*[\\/]/, '').slice(0, 120);
            if (
              (image && !['image/png', 'image/jpeg'].includes(part.mimetype)) ||
              (!image && !filename.toLowerCase().endsWith('.xlsx'))
            )
              throw new IdentityError(image ? 'INVALID_IMAGE' : 'INVALID_WORKBOOK', 400);
            buffer = await part.toBuffer();
          }
        } catch (e) {
          if (e instanceof IdentityError) throw e;
          throw new IdentityError('INVALID_UPLOAD', 400);
        }
        if (!buffer?.length) throw new IdentityError('INVALID_UPLOAD', 400);
        const ctx = { requestId: req.id, ip: req.ip };
        if (image) {
          const value = await processFile<{ buffer: Uint8Array; width: number; height: number }>(
            'image',
            buffer,
          );
          const bytes = Buffer.from(value.buffer);
          await writeStoredFile(this.runtime.db, kind, id, bytes);
          written = true;
          return await this.attachments.create(
            actor,
            bankId,
            id,
            bytes,
            value.width,
            value.height,
            ctx,
          );
        }
        await writeStoredFile(this.runtime.db, kind, id, buffer);
        written = true;
        return await this.imports.create(
          actor,
          bankId,
          id,
          filename,
          createHash('sha256').update(buffer).digest('hex'),
          ctx,
        );
      } catch (e) {
        if (written) await removeStoredFile(this.runtime.db, kind, id);
        if (e instanceof IdentityError)
          await audit(
            this.runtime.db.pool,
            image ? 'question-image.upload' : 'question-import.upload',
            'failure',
            { requestId: req.id, ip: req.ip },
            actor,
          );
        throw e;
      }
    });
  }
  list(actor: string, bank: string, query: unknown) {
    const q = parse(pageSchema, query);
    return this.imports.batches(actor, parse(idSchema, bank), q.page, q.pageSize);
  }
  report(actor: string, bank: string, id: string, query: unknown) {
    const q = parse(pageSchema, query);
    return this.imports.report(
      actor,
      parse(idSchema, bank),
      parse(idSchema, id),
      q.page,
      q.pageSize,
    );
  }
  confirm(actor: string, bank: string, id: string, body: unknown, req: FastifyRequest) {
    const input = parse(importConfirmSchema, body);
    return this.imports.confirm(
      actor,
      parse(idSchema, bank),
      parse(idSchema, id),
      input.duplicatePolicy,
      { requestId: req.id, ip: req.ip },
    );
  }
  content(actor: string, bank: string, id: string) {
    return this.attachments.content(actor, parse(idSchema, bank), parse(idSchema, id));
  }
}
