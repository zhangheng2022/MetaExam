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
import { PapersService } from './papers.service';
@Policy()
class PapersPolicy {
  use(user: CurrentUser | null) {
    return (
      !!user &&
      !user.mustChangePassword &&
      user.roles.some((r) => r === 'admin' || r === 'teacher') &&
      user.permissions.includes('papers.use')
    );
  }
}
const context = (r: FastifyRequest) => ({ requestId: r.id, ip: r.ip });
@Controller('/api/v1/papers')
@Can(PapersPolicy, 'use')
class PapersController {
  constructor(private readonly service: PapersService) {}
  @Get() list(@SignedInUser() u: CurrentUser, @Query() q: unknown) {
    return this.service.list(u.id, q);
  }
  @Post() create(@SignedInUser() u: CurrentUser, @Body() b: unknown, @Req() r: FastifyRequest) {
    return this.service.create(u.id, b, context(r));
  }
  @Get(':id') detail(@SignedInUser() u: CurrentUser, @Param('id') id: string) {
    return this.service.detail(u.id, id);
  }
  @Patch(':id') save(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.save(u.id, id, b, context(r));
  }
  @Get(':id/candidates') candidates(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.service.candidates(u.id, id, q);
  }
  @Post(':id/draw') @HttpCode(200) draw(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.draw(u.id, id, b, context(r));
  }
  @Post(':id/freeze') @HttpCode(200) freeze(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.freeze(u.id, id, b, context(r));
  }
  @Post(':id/copy') copy(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.copy(u.id, id, b, context(r));
  }
}
@Module({ controllers: [PapersController], providers: [PapersService, PapersPolicy] })
export class PapersModule {}
