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
  Res,
} from '@nestjs/common';
import { CurrentUser as SignedInUser } from '@nestjs/authentication';
import { Can, Policy } from '@nestjs/authorization';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { CurrentUser } from '@metaexam/contracts';
import { QuestionsService } from './questions.service';
import { QuestionFilesService } from './files.service';
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
  constructor(
    private readonly service: QuestionsService,
    private readonly files: QuestionFilesService,
  ) {}
  @Get(':bank/import-template') async template(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Res() reply: FastifyReply,
  ) {
    const bytes = await this.files.template(u.id, bank);
    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="MetaExam-questions-template.xlsx"')
      .send(bytes);
  }
  @Post(':bank/imports') @HttpCode(202) uploadImport(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Req() req: FastifyRequest,
  ) {
    return this.files.upload(u.id, bank, req, false);
  }
  @Get(':bank/imports') imports(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Query() q: unknown,
  ) {
    return this.files.list(u.id, bank, q);
  }
  @Get(':bank/imports/:id') report(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.files.report(u.id, bank, id, q);
  }
  @Post(':bank/imports/:id/confirm') @HttpCode(202) confirm(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    return this.files.confirm(u.id, bank, id, body, req);
  }
  @Post(':bank/attachments') image(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Req() req: FastifyRequest,
  ) {
    return this.files.upload(u.id, bank, req, true);
  }
  @Get(':bank/attachments/:id/content') async content(
    @SignedInUser() u: CurrentUser,
    @Param('bank') bank: string,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const bytes = await this.files.content(u.id, bank, id);
    return reply
      .type('image/png')
      .header('Content-Disposition', 'inline; filename="question-image.png"')
      .send(bytes);
  }
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
@Module({
  controllers: [QuestionsController],
  providers: [QuestionsPolicy, QuestionsService, QuestionFilesService],
})
export class QuestionsModule {}
