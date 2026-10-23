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
