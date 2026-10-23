import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ProductGroupsService } from './product-groups.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';

@Controller('api/product-groups')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProductGroupsController {
  constructor(private readonly groups: ProductGroupsService) {}

  @Get()
  list(@AuthUser() user: AuthContext) {
    return this.groups.list(user);
  }

  @Post()
  @Roles('owner', 'staff')
  create(
    @AuthUser() user: AuthContext,
    @Body() body: { name: string; code?: string; isLatest?: boolean },
  ) {
    return this.groups.create(user, body || { name: '' });
  }

  @Post('move-product')
  @Roles('owner', 'staff')
  move(
    @AuthUser() user: AuthContext,
    @Body() body: { productId: string; groupId: string },
  ) {
    return this.groups.moveProduct(user, body.productId, body.groupId);
  }

  @Patch(':id/latest')
  @Roles('owner', 'staff')
  setLatest(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.groups.setLatest(user, id);
  }

  @Patch(':id')
  @Roles('owner', 'staff')
  update(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: { name?: string; code?: string },
  ) {
    return this.groups.update(user, id, body || {});
  }

  @Delete(':id')
  @Roles('owner', 'staff')
  remove(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.groups.remove(user, id);
  }
}
