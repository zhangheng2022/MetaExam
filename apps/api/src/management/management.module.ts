import {
  Body,
  Controller,
  Delete,
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
import { AccountImportService } from './account-import.service';
import type { CurrentUser } from '@metaexam/contracts';
import { PasswordModule } from '../auth/password.service';
import { ManagementService } from './management.service';

@Policy()
class ManagementPolicy {
  private allowed(user: CurrentUser | null, permission: string, admin = true) {
    return (
      !!user &&
      !user.mustChangePassword &&
      (!admin || user.roles.includes('admin')) &&
      user.permissions.includes(permission)
    );
  }
  users(user: CurrentUser | null) {
    return this.allowed(user, 'users.manage');
  }
  organizations(user: CurrentUser | null) {
    return this.allowed(user, 'organizations.manage');
  }
  audits(user: CurrentUser | null) {
    return this.allowed(user, 'audit.read');
  }
  mine(user: CurrentUser | null) {
    return this.allowed(user, 'teaching.self', false);
  }
}
const context = (r: FastifyRequest) => ({ requestId: r.id, ip: r.ip });
@Controller('/api/v1/admin/account-imports')
@Can(ManagementPolicy, 'users')
class AccountImportsController {
  constructor(private readonly service: AccountImportService) {}
  @Get('template') async template(@SignedInUser() user: CurrentUser, @Res() reply: FastifyReply) {
    const bytes = await this.service.template(user.id);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="accounts.xlsx"')
      .header('Cache-Control', 'no-store')
      .send(bytes);
  }
  @Post() @HttpCode(200) preview(@SignedInUser() user: CurrentUser, @Req() req: FastifyRequest) {
    return this.service.preview(user.id, req);
  }
  @Post(':id/confirm') @HttpCode(200) confirm(
    @SignedInUser() user: CurrentUser,
    @Param('id') id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.service.confirm(user.id, id, req);
  }
  @Delete(':id') @HttpCode(204) cancel(@SignedInUser() user: CurrentUser, @Param('id') id: string) {
    return this.service.cancel(user.id, id);
  }
}
@Controller('/api/v1/admin/users')
@Can(ManagementPolicy, 'users')
class UsersController {
  constructor(private readonly service: ManagementService) {}
  @Get() list(@Query() query: unknown) {
    return this.service.users(query);
  }
  @Post() create(
    @Body() body: unknown,
    @SignedInUser() user: CurrentUser,
    @Req() r: FastifyRequest,
  ) {
    return this.service.createUser(body, user.id, context(r));
  }
  @Patch(':id') @HttpCode(204) edit(
    @Param('id') id: string,
    @Body() body: unknown,
    @SignedInUser() user: CurrentUser,
    @Req() r: FastifyRequest,
  ) {
    return this.service.editUser(id, body, user.id, context(r));
  }
  @Post(':id/reset-password') @HttpCode(204) reset(
    @Param('id') id: string,
    @Body() body: unknown,
    @SignedInUser() user: CurrentUser,
    @Req() r: FastifyRequest,
  ) {
    return this.service.resetPassword(id, body, user.id, context(r));
  }
}
@Controller('/api/v1/admin/organizations')
@Can(ManagementPolicy, 'organizations')
class OrganizationsController {
  constructor(private readonly service: ManagementService) {}
  @Get(':kind') list(@Param('kind') kind: string, @Query() query: unknown) {
    return this.service.organizations(kind, query);
  }
  @Get(':kind/:id') detail(@Param('kind') kind: string, @Param('id') id: string) {
    return this.service.organization(kind, id);
  }
  @Post(':kind') create(
    @Param('kind') kind: string,
    @Body() body: unknown,
    @SignedInUser() user: CurrentUser,
    @Req() r: FastifyRequest,
  ) {
    return this.service.createOrganization(kind, body, user.id, context(r));
  }
  @Patch(':kind/:id') @HttpCode(204) edit(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @SignedInUser() user: CurrentUser,
    @Req() r: FastifyRequest,
  ) {
    return this.service.editOrganization(kind, id, body, user.id, context(r));
  }
}
@Controller('/api/v1/admin/classes/:id/members')
@Can(ManagementPolicy, 'organizations')
class MembersController {
  constructor(private readonly service: ManagementService) {}
  @Get() list(@Param('id') id: string, @Query() q: unknown) {
    return this.service.members(id, q);
  }
  @Post() @HttpCode(204) add(
    @Param('id') id: string,
    @Body() body: unknown,
    @SignedInUser() user: CurrentUser,
    @Req() r: FastifyRequest,
  ) {
    return this.service.member(id, body, false, user.id, context(r));
  }
  @Delete(':studentId') @HttpCode(204) remove(
    @Param('id') id: string,
    @Param('studentId') studentId: string,
    @SignedInUser() user: CurrentUser,
    @Req() r: FastifyRequest,
  ) {
    return this.service.member(id, { studentId }, true, user.id, context(r));
  }
}
@Controller('/api/v1/admin/assignments')
@Can(ManagementPolicy, 'organizations')
class AssignmentsController {
  constructor(private readonly service: ManagementService) {}
  @Get() list(@Query() query: unknown) {
    return this.service.assignments(query);
  }
  @Post() @HttpCode(204) add(
    @Body() body: unknown,
    @SignedInUser() user: CurrentUser,
    @Req() r: FastifyRequest,
  ) {
    return this.service.assignment(body, false, user.id, context(r));
  }
  @Delete() @HttpCode(204) remove(
    @Body() body: unknown,
    @SignedInUser() user: CurrentUser,
    @Req() r: FastifyRequest,
  ) {
    return this.service.assignment(body, true, user.id, context(r));
  }
}
@Controller('/api/v1')
class TeachingController {
  constructor(private readonly service: ManagementService) {}
  @Get('admin/audit-events') @Can(ManagementPolicy, 'audits') audits(@Query() q: unknown) {
    return this.service.audits(q);
  }
  @Get('teaching/me') @Can(ManagementPolicy, 'mine') mine(@SignedInUser() user: CurrentUser) {
    return this.service.mine(user.id);
  }
}
@Module({
  imports: [PasswordModule],
  controllers: [
    AccountImportsController,
    UsersController,
    OrganizationsController,
    MembersController,
    AssignmentsController,
    TeachingController,
  ],
  providers: [ManagementService, ManagementPolicy, AccountImportService],
})
export class ManagementModule {}
