import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';

@Controller('api/invites')
@UseGuards(JwtAuthGuard)
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('owner', 'staff')
  create(
    @AuthUser() user: AuthContext,
    @Body() body: { role?: string; maxUses?: number; expiresInDays?: number },
  ) {
    return this.invites.create(user, body || {});
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles('owner', 'staff')
  list(@AuthUser() user: AuthContext) {
    return this.invites.list(user);
  }

  @Get('members')
  @UseGuards(RolesGuard)
  @Roles('owner', 'staff')
  members(@AuthUser() user: AuthContext) {
    return this.invites.listMembers(user);
  }

  /** 踢除员工（平权：owner/staff 均可；须写在 :id/revoke 之前，避免 members 被当成 id） */
  @Post('members/:memberId/disable')
  @UseGuards(RolesGuard)
  @Roles('owner', 'staff')
  disableMember(@AuthUser() user: AuthContext, @Param('memberId') memberId: string) {
    return this.invites.disableMember(user, memberId);
  }

  @Post('accept')
  accept(@AuthUser() user: AuthContext, @Body() body: { code?: string }) {
    return this.invites.accept(user, body || {});
  }

  @Post(':id/revoke')
  @UseGuards(RolesGuard)
  @Roles('owner', 'staff')
  revoke(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.invites.revoke(user, id);
  }
}
