import { Injectable } from '@nestjs/common';
import { ExamRepository, IdentityError, audit, type AuditContext } from '@metaexam/db';
import {
  idSchema,
  examInputSchema,
  examSaveSchema,
  examQuerySchema,
  examChoiceSchema,
  examRevisionSchema,
  examCancelSchema,
} from '@metaexam/contracts';
import { Runtime } from '../database/database.module';
function parse<T>(s: { parse: (v: unknown) => T }, v: unknown) {
  try {
    return s.parse(v);
  } catch {
    throw new IdentityError('INVALID_REQUEST', 400);
  }
}
@Injectable()
export class ExamsService {
  private readonly repository: ExamRepository;
  constructor(private readonly runtime: Runtime) {
    this.repository = new ExamRepository(runtime.db);
  }
  private async write<T>(actor: string, ctx: AuditContext, action: () => Promise<T>) {
    try {
      return await action();
    } catch (e) {
      if (e instanceof IdentityError)
        await audit(this.runtime.db.pool, 'exam.write', 'failure', ctx, actor);
      throw e;
    }
  }
  list(actor: string, q: unknown) {
    return this.repository.list(actor, parse(examQuerySchema, q));
  }
  mine(actor: string, q: unknown) {
    return this.repository.mine(actor, parse(examQuerySchema, q));
  }
  choices(actor: string, kind: 'papers' | 'classes', q: unknown) {
    return this.repository.choices(actor, kind, parse(examChoiceSchema, q));
  }
  detail(actor: string, id: string) {
    return this.repository.detail(actor, parse(idSchema, id));
  }
  progress(actor: string, id: string) {
    return this.repository.progress(actor, parse(idSchema, id));
  }
  roster(actor: string, id: string, q: unknown) {
    return this.repository.roster(actor, parse(idSchema, id), parse(examQuerySchema, q));
  }
  create(actor: string, b: unknown, ctx: AuditContext) {
    return this.write(actor, ctx, () =>
      this.repository.create(actor, parse(examInputSchema, b), ctx),
    );
  }
  save(actor: string, id: string, b: unknown, ctx: AuditContext) {
    return this.write(actor, ctx, () =>
      this.repository.save(actor, parse(idSchema, id), parse(examSaveSchema, b), ctx),
    );
  }
  publish(actor: string, id: string, b: unknown, ctx: AuditContext) {
    return this.write(actor, ctx, () =>
      this.repository.publish(
        actor,
        parse(idSchema, id),
        parse(examRevisionSchema, b).revision,
        ctx,
      ),
    );
  }
  cancel(actor: string, id: string, b: unknown, ctx: AuditContext) {
    return this.write(actor, ctx, () => {
      const input = parse(examCancelSchema, b);
      return this.repository.cancel(actor, parse(idSchema, id), input.revision, input.reason, ctx);
    });
  }
}
