import {
  Module,
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
} from '@nestjs/common';
import { CurrentUser as SignedInUser } from '@nestjs/authentication';
import { Can, Policy } from '@nestjs/authorization';
import type { FastifyRequest } from 'fastify';
import type { CurrentUser } from '@metaexam/contracts';
import { ExamsService } from './exams.service';
@Policy()
class ExamsPolicy {
  manage(u: CurrentUser | null) {
    return (
      !!u &&
      !u.mustChangePassword &&
      u.roles.some((r) => r === 'admin' || r === 'teacher') &&
      u.permissions.includes('exams.manage')
    );
  }
  self(u: CurrentUser | null) {
    return (
      !!u &&
      !u.mustChangePassword &&
      u.roles.includes('student') &&
      u.permissions.includes('exams.self')
    );
  }
}
const context = (r: FastifyRequest) => ({ requestId: r.id, ip: r.ip });
@Controller('/api/v1/exams')
@Can(ExamsPolicy, 'manage')
class ExamsController {
  constructor(private readonly service: ExamsService) {}
  @Get() list(@SignedInUser() u: CurrentUser, @Query() q: unknown) {
    return this.service.list(u.id, q);
  }
  @Get('choices/papers') papers(@SignedInUser() u: CurrentUser, @Query() q: unknown) {
    return this.service.choices(u.id, 'papers', q);
  }
  @Get('choices/classes') classes(@SignedInUser() u: CurrentUser, @Query() q: unknown) {
    return this.service.choices(u.id, 'classes', q);
  }
  @Post() create(@SignedInUser() u: CurrentUser, @Body() b: unknown, @Req() r: FastifyRequest) {
    return this.service.create(u.id, b, context(r));
  }
  @Get(':id') detail(@SignedInUser() u: CurrentUser, @Param('id') id: string) {
    return this.service.detail(u.id, id);
  }
  @Get(':id/roster') roster(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.service.roster(u.id, id, q);
  }
  @Get(':id/progress') progress(@SignedInUser() u: CurrentUser, @Param('id') id: string) {
    return this.service.progress(u.id, id);
  }
  @Patch(':id') save(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.save(u.id, id, b, context(r));
  }
  @Post(':id/publish') @HttpCode(200) publish(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.publish(u.id, id, b, context(r));
  }
  @Post(':id/cancel') @HttpCode(200) cancel(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.cancel(u.id, id, b, context(r));
  }
}
@Controller('/api/v1/my-exams')
@Can(ExamsPolicy, 'self')
class MyExamsController {
  constructor(private readonly service: ExamsService) {}
  @Get() list(@SignedInUser() u: CurrentUser, @Query() q: unknown) {
    return this.service.mine(u.id, q);
  }
}
@Module({
  controllers: [ExamsController, MyExamsController],
  providers: [ExamsService, ExamsPolicy],
})
export class ExamsModule {}
