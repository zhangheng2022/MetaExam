import {
  Module,
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Req,
  Res,
  HttpCode,
} from '@nestjs/common';
import { CurrentUser as SignedInUser } from '@nestjs/authentication';
import { Can, Policy } from '@nestjs/authorization';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { CurrentUser } from '@metaexam/contracts';
import { AttemptsService } from './attempts.service';
@Policy()
class AttemptsPolicy {
  use(u: CurrentUser | null) {
    return (
      !!u &&
      !u.mustChangePassword &&
      u.roles.includes('student') &&
      u.permissions.includes('exams.self')
    );
  }
}
@Controller('/api/v1')
@Can(AttemptsPolicy, 'use')
class AttemptsController {
  constructor(private readonly service: AttemptsService) {}
  @Post('my-exams/:examId/start') @HttpCode(200) start(
    @SignedInUser() u: CurrentUser,
    @Param('examId') id: string,
    @Body() body: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.start(u.id, id, body, { requestId: r.id, ip: r.ip });
  }
  @Get('attempts/:id') detail(@SignedInUser() u: CurrentUser, @Param('id') id: string) {
    return this.service.detail(u.id, id);
  }
  @Get('attempts/:id/questions/:position') question(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Param('position') p: string,
  ) {
    return this.service.question(u.id, id, p);
  }
  @Put('attempts/:id/questions/:position') save(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Param('position') p: string,
    @Body() b: unknown,
  ) {
    return this.service.save(u.id, id, p, b);
  }
  @Post('attempts/:id/submit') @HttpCode(200) submit(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() b: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.submit(u.id, id, b, { requestId: r.id, ip: r.ip });
  }
  @Get('attempts/:id/images/:file') async image(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Param('file') file: string,
    @Res() reply: FastifyReply,
  ) {
    const bytes = await this.service.image(u.id, id, file);
    return reply.type('image/png').header('Cache-Control', 'no-store').send(bytes);
  }
}
@Module({ controllers: [AttemptsController], providers: [AttemptsService, AttemptsPolicy] })
export class AttemptsModule {}
