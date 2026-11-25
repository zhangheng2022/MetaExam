import { Injectable } from '@nestjs/common';
import { ManagementRepository, IdentityError, audit, type AuditContext } from '@metaexam/db';
import {
  assignmentSchema,
  auditQuerySchema,
  idSchema,
  listSchema,
  memberSchema,
  organizationEditSchema,
  organizationSchema,
  resetPasswordSchema,
  userCreateSchema,
  userEditSchema,
} from '@metaexam/contracts';
import { Runtime } from '../database/database.module';
import { PasswordService } from '../auth/password.service';
function parse<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new IdentityError('INVALID_REQUEST', 400);
  }
}
export function kindOf(value: string): 'classes' | 'courses' {
  if (value !== 'classes' && value !== 'courses') throw new IdentityError('NOT_FOUND', 404);
  return value;
}
@Injectable()
export class ManagementService {
  readonly repository: ManagementRepository;
  constructor(
    private readonly runtime: Runtime,
    private readonly passwords: PasswordService,
  ) {
    this.repository = new ManagementRepository(runtime.db);
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
  users(query: unknown) {
    return this.repository.users(parse(listSchema, query));
  }
  createUser(body: unknown, actor: string, context: AuditContext) {
    return this.write('user.create', actor, context, async () => {
      const input = parse(userCreateSchema, body);
      return this.repository.createUser(
        input,
        await this.passwords.hash(input.password),
        actor,
        context,
      );
    });
  }
  editUser(id: string, body: unknown, actor: string, context: AuditContext) {
    return this.write('user.update', actor, context, () =>
      this.repository.editUser(parse(idSchema, id), parse(userEditSchema, body), actor, context),
    );
  }
  resetPassword(id: string, body: unknown, actor: string, context: AuditContext) {
    return this.write('user.password.reset', actor, context, async () => {
      const input = parse(resetPasswordSchema, body);
      return this.repository.resetPassword(
        parse(idSchema, id),
        await this.passwords.hash(input.password),
        input.revision,
        actor,
        context,
      );
    });
  }
  organizations(kind: string, query: unknown) {
    return this.repository.organizations(kindOf(kind), parse(listSchema, query));
  }
  organization(kind: string, id: string) {
    return this.repository.organization(kindOf(kind), parse(idSchema, id));
  }
  createOrganization(kind: string, body: unknown, actor: string, context: AuditContext) {
    return this.write(`${kindOf(kind)}.create`, actor, context, () =>
      this.repository.createOrganization(
        kindOf(kind),
        parse(organizationSchema, body),
        actor,
        context,
      ),
    );
  }
  editOrganization(kind: string, id: string, body: unknown, actor: string, context: AuditContext) {
    return this.write(`${kindOf(kind)}.update`, actor, context, () =>
      this.repository.editOrganization(
        kindOf(kind),
        parse(idSchema, id),
        parse(organizationEditSchema, body),
        actor,
        context,
      ),
    );
  }
  async members(id: string, query: unknown) {
    await this.repository.organization('classes', parse(idSchema, id));
    return this.repository.users(parse(listSchema, query), id);
  }
  member(id: string, body: unknown, remove: boolean, actor: string, context: AuditContext) {
    return this.write(remove ? 'member.remove' : 'member.add', actor, context, () =>
      this.repository.member(
        parse(idSchema, id),
        parse(memberSchema, body).studentId,
        remove,
        actor,
        context,
      ),
    );
  }
  assignments(query: unknown) {
    return this.repository.assignments(parse(listSchema, query));
  }
  assignment(body: unknown, remove: boolean, actor: string, context: AuditContext) {
    return this.write(remove ? 'assignment.remove' : 'assignment.add', actor, context, () =>
      this.repository.assignment(parse(assignmentSchema, body), remove, actor, context),
    );
  }
  audits(query: unknown) {
    return this.repository.audits(parse(auditQuerySchema, query));
  }
  mine(id: string) {
    return this.repository.mine(id);
  }
}
