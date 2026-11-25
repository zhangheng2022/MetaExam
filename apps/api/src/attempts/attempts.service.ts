import { Injectable } from '@nestjs/common';
import { AttemptRepository, IdentityError } from '@metaexam/db';
import type { AuditContext } from '@metaexam/db';
import {
  idSchema,
  positionSchema,
  saveAnswerSchema,
  submitAttemptSchema,
  startAttemptSchema,
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
export class AttemptsService {
  private readonly repository: AttemptRepository;
  constructor(private readonly runtime: Runtime) {
    this.repository = new AttemptRepository(runtime.db);
  }
  async start(actor: string, exam: string, body: unknown, ctx: AuditContext) {
    parse(startAttemptSchema, body ?? {});
    if (this.runtime.draining) throw new IdentityError('SERVICE_STOPPING', 503);
    this.runtime.admissions++;
    try {
      return await this.repository.start(actor, parse(idSchema, exam), ctx);
    } finally {
      this.runtime.admissions--;
    }
  }
  detail(actor: string, id: string) {
    return this.repository.detail(actor, parse(idSchema, id));
  }
  question(actor: string, id: string, position: string) {
    return this.repository.question(actor, parse(idSchema, id), parse(positionSchema, position));
  }
  save(actor: string, id: string, position: string, body: unknown) {
    return this.repository.save(
      actor,
      parse(idSchema, id),
      parse(positionSchema, position),
      parse(saveAnswerSchema, body),
    );
  }
  submit(actor: string, id: string, body: unknown, ctx: AuditContext) {
    return this.repository.submit(
      actor,
      parse(idSchema, id),
      parse(submitAttemptSchema, body).revision,
      ctx,
    );
  }
  image(actor: string, id: string, file: string) {
    return this.repository.image(actor, parse(idSchema, id), parse(idSchema, file));
  }
}
