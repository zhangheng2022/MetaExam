import { Module, Injectable, Controller, Get, Post, Body, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { administratorSchema, type SetupStatus } from '@metaexam/contracts';
import { BootstrapRepository, readiness, IdentityError } from '@metaexam/db';
import { Runtime } from '../database/database.module';
import { PasswordModule, PasswordService } from '../auth/password.service';
import { local } from '../system/system.module';
@Injectable()
export class SetupService {
  private readonly repository: BootstrapRepository;
  constructor(
    private readonly runtime: Runtime,
    private readonly passwords: PasswordService,
  ) {
    this.repository = new BootstrapRepository(runtime.db);
  }
  async status(): Promise<SetupStatus> {
    const ready = await readiness(this.runtime.db);
    if (!ready) throw new IdentityError('DATABASE_UNAVAILABLE', 503);
    return { database: 'ready', adminInitialized: await this.repository.initialized() };
  }
  async create(body: unknown, token: string, requestId: string, ip: string) {
    if (await this.repository.initialized()) throw new IdentityError('ALREADY_INITIALIZED', 409);
    const parsed = administratorSchema.safeParse(body);
    if (!parsed.success) throw new IdentityError('INVALID_REQUEST', 400);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new IdentityError('SETUP_TOKEN_INVALID', 403);
    await this.repository.create(
      parsed.data,
      token,
      await this.passwords.hash(parsed.data.password),
      { requestId, ip },
    );
    return { adminInitialized: true };
  }
}
@Controller('/api/v1/setup')
export class SetupController {
  constructor(private readonly service: SetupService) {}
  @Get('status') status() {
    return this.service.status();
  }
  @Post('administrator') create(@Body() body: unknown, @Req() req: FastifyRequest) {
    if (!local(req)) throw new IdentityError('LOCAL_ONLY', 403);
    return this.service.create(
      body,
      req.headers.authorization?.replace(/^Bearer /, '') ?? '',
      req.id,
      req.ip,
    );
  }
}
@Module({ imports: [PasswordModule], providers: [SetupService], controllers: [SetupController] })
export class SetupModule {}
