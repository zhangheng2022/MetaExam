import { Injectable, Module, Controller, Get } from '@nestjs/common';
import {
  AuthenticationRegistry,
  SessionCookieProvider,
  type SessionRecord,
} from '@nestjs/authentication';
import { Policy, Can } from '@nestjs/authorization';
import { AccountsRepository } from '@metaexam/db';
import type { CurrentUser } from '@metaexam/contracts';
import { AccountsModule } from './accounts.module';
import { Runtime } from '../database/database.module';
declare module '@nestjs/authentication' {
  interface AuthenticationTypes {
    user: CurrentUser;
  }
}
@Injectable()
export class SessionAuth extends SessionCookieProvider<CurrentUser> {
  constructor(
    private readonly accounts: AccountsRepository,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerProvider(this);
  }
  validate(session: SessionRecord) {
    return this.accounts.current(session.userId);
  }
}
@Policy()
export class AdminPolicy {
  overview(user: CurrentUser | null) {
    return !!user?.roles.includes('admin') && user.permissions.includes('admin.overview');
  }
}
@Controller('/api/v1/admin')
export class AdminController {
  constructor(private readonly runtime: Runtime) {}
  @Get('overview') @Can(AdminPolicy, 'overview') async overview() {
    const counts = (
      await this.runtime.db.pool.query<{ users: string; classes: string; courses: string }>(
        'SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM classes) AS classes,(SELECT count(*) FROM courses) AS courses',
      )
    ).rows[0]!;
    return {
      users: Number(counts.users),
      classes: Number(counts.classes),
      courses: Number(counts.courses),
    };
  }
}
@Module({
  imports: [AccountsModule],
  providers: [SessionAuth, AdminPolicy],
  controllers: [AdminController],
})
export class PermissionsModule {}
