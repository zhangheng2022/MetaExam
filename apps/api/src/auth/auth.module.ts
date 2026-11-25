import {
  Injectable,
  Module,
  Controller,
  Post,
  Get,
  HttpCode,
  Req,
  Res,
  Body,
} from '@nestjs/common';
import {
  Public,
  CurrentUser as SignedInUser,
  SignInService,
  SessionService,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  AccountsRepository,
  consumeAuthQuota,
  IdentityError,
  type AuditContext,
} from '@metaexam/db';
import { loginSchema, changePasswordSchema, type CurrentUser } from '@metaexam/contracts';
import { Runtime } from '../database/database.module';
import { PasswordModule, PasswordService } from './password.service';
import { PgSessionStore } from './session.store';
import { AccountsModule } from './accounts.module';
import { PermissionsModule } from './permissions.module';
import { AuditModule, AuditService } from './audit.module';
@Injectable()
export class AuthService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly passwords: PasswordService,
    private readonly runtime: Runtime,
    private readonly signIn: SignInService,
    private readonly audit: AuditService,
  ) {}
  private quota(username: string, context: AuditContext) {
    return consumeAuthQuota(this.runtime.db, username, context.ip ?? '', {
      account: this.runtime.db.config.auth?.accountLimit ?? 10,
      ip: this.runtime.db.config.auth?.ipLimit ?? 60,
    });
  }
  async login(body: unknown, context: AuditContext) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new IdentityError('INVALID_REQUEST', 400);
    await this.quota(parsed.data.username, context);
    const found = await this.accounts.credentials(parsed.data.username);
    const valid = await this.passwords.verify(parsed.data.password, found?.password_hash);
    if (!found || !valid || !found.enabled) {
      await this.audit.write('auth.login', 'failure', context);
      throw new IdentityError('INVALID_CREDENTIALS', 401);
    }
    await this.audit.write('auth.login', 'success', context, found.id);
    await this.signIn.signIn(found.id, {
      method: 'password',
      metadata: { credentialVersion: found.version },
    });
    return this.accounts.current(found.id);
  }
  async changePassword(user: CurrentUser, body: unknown, context: AuditContext) {
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) throw new IdentityError('INVALID_REQUEST', 400);
    await this.quota(user.username, context);
    const found = await this.accounts.credentials(user.username);
    const valid = await this.passwords.verify(parsed.data.oldPassword, found?.password_hash);
    if (!found || !valid || !found.enabled) {
      await this.audit.write('password.change', 'failure', context, user.id);
      throw new IdentityError('INVALID_CREDENTIALS', 401);
    }
    await this.accounts.changePassword(
      user.id,
      found.version,
      await this.passwords.hash(parsed.data.newPassword),
      context,
    );
  }
}
@Controller('/api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly signIn: SignInService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}
  @Public() @Post('login') @HttpCode(200) login(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.auth.login(body, { requestId: req.id, ip: req.ip });
  }
  @Public() @Post('logout') @HttpCode(204) async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    await this.signIn.signOut();
    res.header('Set-Cookie', this.sessions.clearCookie());
    await this.audit.write('auth.logout', 'success', { requestId: req.id, ip: req.ip });
  }
  @Get('me') @Can.Anyone() me(@SignedInUser() user: CurrentUser) {
    return user;
  }
  @Post('change-password') @HttpCode(204) @Can.Anyone() async change(
    @SignedInUser() user: CurrentUser,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    await this.auth.changePassword(user, body, { requestId: req.id, ip: req.ip });
    res.header('Set-Cookie', this.sessions.clearCookie());
  }
}
@Module({
  imports: [PasswordModule, AccountsModule, PermissionsModule, AuditModule],
  providers: [PgSessionStore, AuthService],
  controllers: [AuthController],
})
export class AuthModule {}
