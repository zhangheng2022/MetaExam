import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { CurrentUser as SignedInUser } from '@nestjs/authentication';
import { Can, Policy } from '@nestjs/authorization';
import type { FastifyRequest } from 'fastify';
import type { CurrentUser } from '@metaexam/contracts';
import { QuestionsService } from './questions.service';
@Policy()
class QuestionsPolicy {
  use(user: CurrentUser | null) {
    return (
      !!user &&
      !user.mustChangePassword &&
      user.permissions.includes('questions.use') &&
      user.roles.some((r) => r === 'admin' || r === 'teacher')
    );
  }
}
const context = (r: FastifyRequest) => ({ requestId: r.id, ip: r.ip });
@Controller('/api/v1/question-banks')
@Can(QuestionsPolicy, 'use')
class QuestionsController {
  constructor(private readonly service: QuestionsService) {}
  @Get('courses') courses(@SignedInUser() u: CurrentUser, @Query() q: unknown) {
    return this.service.courses(u.id, q);
  }
  @Get() banks(@SignedInUser() u: CurrentUser, @Query() q: unknown) {
    return this.service.banks(u.id, q);
  }
  @Get(':bank') bank(@SignedInUser() u: CurrentUser, @Param('bank') bank: string) {
    return this.service.bank(u.id, bank);
  }
  @Post() createBank(@SignedInUser() u: CurrentUser, @Body() b: unknown, @Req() r: FastifyRequest) {
    return this.service.createBank(u.id, b, context(r));
  }
  @Patch(':bank') @HttpCode(204) editBank(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.editBank(u.id, bank, b, context(r));
  }
  @Get(':bank/questions') list(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Query() q: unknown,
  ) {
    return this.service.list(u.id, bank, q);
  }
  @Get(':bank/questions/:id') detail(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Param('id') id: string,
  ) {
    return this.service.detail(u.id, bank, id);
  }
  @Get(':bank/questions/:id/versions') versions(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.service.versions(u.id, bank, id, q);
  }
  @Post(':bank/questions') create(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.create(u.id, bank, b, context(r));
  }
  @Patch(':bank/questions/:id') edit(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.edit(u.id, bank, id, b, context(r));
  }
  @Post(':bank/questions/:id/archive') @HttpCode(204) archive(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.archive(u.id, bank, id, b, context(r));
  }
}
@Module({ controllers: [QuestionsController], providers: [QuestionsPolicy, QuestionsService] })
export class QuestionsModule {}
