import {
  Module,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Body,
  Req,
  Res,
  HttpCode,
} from '@nestjs/common';
import { CurrentUser as SignedInUser } from '@nestjs/authentication';
import { Can, Policy } from '@nestjs/authorization';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { CurrentUser } from '@metaexam/contracts';
import { GradingService } from './grading.service';
@Policy()
class GradingPolicy {
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
@Controller('/api/v1/grading/exams')
@Can(GradingPolicy, 'manage')
class GradingController {
  constructor(private readonly service: GradingService) {}
  @Get(':id') overview(@SignedInUser() u: CurrentUser, @Param('id') id: string) {
    return this.service.overview(u.id, id);
  }
  @Get(':id/candidates') candidates(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.service.candidates(u.id, id, q);
  }
  @Get(':id/attempts/:attempt/questions/:position') detail(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Param('attempt') attempt: string,
    @Param('position') position: string,
  ) {
    return this.service.detail(u.id, id, attempt, position);
  }
  @Put(':id/attempts/:attempt/questions/:position') save(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Param('attempt') attempt: string,
    @Param('position') position: string,
    @Body() body: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.save(u.id, id, attempt, position, body, { requestId: r.id, ip: r.ip });
  }
  @Post(':id/publish') @HttpCode(200) publish(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() r: FastifyRequest,
  ) {
    return this.service.publish(u.id, id, body, { requestId: r.id, ip: r.ip });
  }
  @Get(':id/attempts/:attempt/images/:file') async image(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Param('attempt') attempt: string,
    @Param('file') file: string,
    @Res() reply: FastifyReply,
  ) {
    return reply
      .type('image/png')
      .header('Cache-Control', 'no-store')
      .send(await this.service.image(u.id, id, attempt, file));
  }
}
@Controller('/api/v1/my-exams')
@Can(GradingPolicy, 'self')
class ResultsController {
  constructor(private readonly service: GradingService) {}
  @Get(':id/result') result(@SignedInUser() u: CurrentUser, @Param('id') id: string) {
    return this.service.result(u.id, id);
  }
}
@Module({
  controllers: [GradingController, ResultsController],
  providers: [GradingService, GradingPolicy],
})
export class GradingModule {}
