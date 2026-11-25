import { Injectable, Module } from '@nestjs/common';
import { audit, type AuditContext } from '@metaexam/db';
import { Runtime } from '../database/database.module';
@Injectable()
export class AuditService {
  constructor(private readonly runtime: Runtime) {}
  write(event: string, outcome: string, context: AuditContext, actorId: string | null = null) {
    return audit(this.runtime.db.pool, event, outcome, context, actorId);
  }
}
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
