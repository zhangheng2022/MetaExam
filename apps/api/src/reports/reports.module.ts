import {
  Module,
  Controller,
  Get,
  Post,
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
import { ReportsService } from './reports.service';
@Policy()
class ReportsPolicy {
  manage(u: CurrentUser | null) {
    return (
      !!u &&
      !u.mustChangePassword &&
      u.roles.some((r) => r === 'admin' || r === 'teacher') &&
      u.permissions.includes('exams.manage')
    );
  }
}
@Controller('/api/v1/reports/exams')
@Can(ReportsPolicy, 'manage')
class ReportsController {
  constructor(private readonly service: ReportsService) {}
  @Get(':id') summary(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.service.summary(u.id, id, q);
  }
  @Get(':id/records') list(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return this.service.list(u.id, id, q);
  }
  @Post(':id/export') @HttpCode(200) async export(
    @SignedInUser() u: CurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() r: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.service.export(u.id, id, body, { requestId: r.id, ip: r.ip });
    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .send(result.bytes);
  }
}
@Module({ controllers: [ReportsController], providers: [ReportsService, ReportsPolicy] })
export class ReportsModule {}
