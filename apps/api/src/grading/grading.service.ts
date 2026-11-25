import { Injectable } from '@nestjs/common';
import { GradingRepository, IdentityError, type AuditContext } from '@metaexam/db';
import {
  idSchema,
  positionSchema,
  gradeSchema,
  releaseGradesSchema,
  gradingQuerySchema,
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
export class GradingService {
  private readonly repository: GradingRepository;
  constructor(runtime: Runtime) {
    this.repository = new GradingRepository(runtime.db);
  }
  overview(actor: string, id: string) {
    return this.repository.overview(actor, parse(idSchema, id));
  }
  candidates(actor: string, id: string, q: unknown) {
    return this.repository.candidates(actor, parse(idSchema, id), parse(gradingQuerySchema, q));
  }
  detail(actor: string, id: string, attempt: string, position: string) {
    return this.repository.detail(
      actor,
      parse(idSchema, id),
      parse(idSchema, attempt),
      parse(positionSchema, position),
    );
  }
  save(
    actor: string,
    id: string,
    attempt: string,
    position: string,
    body: unknown,
    ctx: AuditContext,
  ) {
    return this.repository.save(
      actor,
      parse(idSchema, id),
      parse(idSchema, attempt),
      parse(positionSchema, position),
      parse(gradeSchema, body),
      ctx,
    );
  }
  publish(actor: string, id: string, body: unknown, ctx: AuditContext) {
    return this.repository.publish(
      actor,
      parse(idSchema, id),
      parse(releaseGradesSchema, body).revision,
      ctx,
    );
  }
  result(actor: string, id: string) {
    return this.repository.result(actor, parse(idSchema, id));
  }
  image(actor: string, id: string, attempt: string, file: string) {
    return this.repository.image(
      actor,
      parse(idSchema, id),
      parse(idSchema, attempt),
      parse(idSchema, file),
    );
  }
}
