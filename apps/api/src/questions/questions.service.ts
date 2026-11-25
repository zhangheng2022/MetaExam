import { Injectable } from '@nestjs/common';
import { QuestionRepository, IdentityError, audit, type AuditContext } from '@metaexam/db';
import {
  idSchema,
  bankCreateSchema,
  bankEditSchema,
  bankQuerySchema,
  questionQuerySchema,
  questionInputSchema,
  questionEditSchema,
  archiveQuestionSchema,
} from '@metaexam/contracts';
import { Runtime } from '../database/database.module';
function parse<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new IdentityError('INVALID_REQUEST', 400);
  }
}
@Injectable()
export class QuestionsService {
  private readonly repository: QuestionRepository;
  constructor(private readonly runtime: Runtime) {
    this.repository = new QuestionRepository(runtime.db);
  }
  private async write<T>(
    event: string,
    actor: string,
    context: AuditContext,
    action: () => Promise<T>,
  ) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof IdentityError)
        await audit(this.runtime.db.pool, event, 'failure', context, actor);
      throw error;
    }
  }
  courses(actor: string, q: unknown) {
    return this.repository.courses(actor, parse(bankQuerySchema, q));
  }
  banks(actor: string, q: unknown) {
    return this.repository.banks(actor, parse(bankQuerySchema, q));
  }
  bank(actor: string, id: string) {
    return this.repository.getBank(actor, parse(idSchema, id));
  }
  createBank(actor: string, body: unknown, c: AuditContext) {
    return this.write('question-bank.create', actor, c, () =>
      this.repository.createBank(actor, parse(bankCreateSchema, body), c),
    );
  }
  editBank(actor: string, id: string, body: unknown, c: AuditContext) {
    return this.write('question-bank.update', actor, c, () =>
      this.repository.editBank(actor, parse(idSchema, id), parse(bankEditSchema, body), c),
    );
  }
  list(actor: string, bank: string, q: unknown) {
    return this.repository.list(actor, parse(idSchema, bank), parse(questionQuerySchema, q));
  }
  detail(actor: string, bank: string, id: string) {
    return this.repository.detail(actor, parse(idSchema, bank), parse(idSchema, id));
  }
  versions(actor: string, bank: string, id: string, q: unknown) {
    return this.repository.versions(
      actor,
      parse(idSchema, bank),
      parse(idSchema, id),
      parse(questionQuerySchema, q),
    );
  }
  create(actor: string, bank: string, body: unknown, c: AuditContext) {
    return this.write('question.create', actor, c, () =>
      this.repository.save(actor, parse(idSchema, bank), parse(questionInputSchema, body), c),
    );
  }
  edit(actor: string, bank: string, id: string, body: unknown, c: AuditContext) {
    return this.write('question.update', actor, c, () => {
      const input = parse(questionEditSchema, body);
      return this.repository.save(actor, parse(idSchema, bank), input.question, c, {
        id: parse(idSchema, id),
        revision: input.revision,
      });
    });
  }
  archive(actor: string, bank: string, id: string, body: unknown, c: AuditContext) {
    return this.write('question.archive', actor, c, () =>
      this.repository.archive(
        actor,
        parse(idSchema, bank),
        parse(idSchema, id),
        parse(archiveQuestionSchema, body),
        c,
      ),
    );
  }
}
