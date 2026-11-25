import { Injectable } from '@nestjs/common';
import { PaperRepository, IdentityError, audit, type AuditContext } from '@metaexam/db';
import {
  idSchema,
  paperCreateSchema,
  paperSaveSchema,
  paperQuerySchema,
  paperCandidateSchema,
  paperDrawSchema,
  paperRevisionSchema,
  paperCopySchema,
} from '@metaexam/contracts';
import { Runtime } from '../database/database.module';
function parse<T>(schema: { parse: (v: unknown) => T }, v: unknown) {
  try {
    return schema.parse(v);
  } catch {
    throw new IdentityError('INVALID_REQUEST', 400);
  }
}
@Injectable()
export class PapersService {
  private readonly repository: PaperRepository;
  constructor(private readonly runtime: Runtime) {
    this.repository = new PaperRepository(runtime.db);
  }
  private async write<T>(actor: string, ctx: AuditContext, action: () => Promise<T>) {
    try {
      return await action();
    } catch (e) {
      if (e instanceof IdentityError)
        await audit(this.runtime.db.pool, 'paper.write', 'failure', ctx, actor);
      throw e;
    }
  }
  list(actor: string, query: unknown) {
    return this.repository.list(actor, parse(paperQuerySchema, query));
  }
  detail(actor: string, id: string) {
    return this.repository.detail(actor, parse(idSchema, id));
  }
  candidates(actor: string, id: string, query: unknown) {
    return this.repository.candidates(
      actor,
      parse(idSchema, id),
      parse(paperCandidateSchema, query),
    );
  }
  create(actor: string, body: unknown, ctx: AuditContext) {
    return this.write(actor, ctx, () =>
      this.repository.create(actor, parse(paperCreateSchema, body), ctx),
    );
  }
  save(actor: string, id: string, body: unknown, ctx: AuditContext) {
    return this.write(actor, ctx, () =>
      this.repository.save(actor, parse(idSchema, id), parse(paperSaveSchema, body), ctx),
    );
  }
  draw(actor: string, id: string, body: unknown, ctx: AuditContext) {
    return this.write(actor, ctx, () =>
      this.repository.draw(actor, parse(idSchema, id), parse(paperDrawSchema, body), ctx),
    );
  }
  freeze(actor: string, id: string, body: unknown, ctx: AuditContext) {
    return this.write(actor, ctx, () =>
      this.repository.freeze(
        actor,
        parse(idSchema, id),
        parse(paperRevisionSchema, body).revision,
        ctx,
      ),
    );
  }
  copy(actor: string, id: string, body: unknown, ctx: AuditContext) {
    return this.write(actor, ctx, () =>
      this.repository.copy(actor, parse(idSchema, id), parse(paperCopySchema, body).name, ctx),
    );
  }
}
