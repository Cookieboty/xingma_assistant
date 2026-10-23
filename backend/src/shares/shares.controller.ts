import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { SharesService } from './shares.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { SharePolicy } from '../products/product-access.service';

@Controller('api/shares')
@UseGuards(JwtAuthGuard)
export class SharesController {
  constructor(private readonly sharesService: SharesService) {}

  /** 创建分享（业主/员工；可不指定客户） */
  @Post()
  create(
    @AuthUser() user: AuthContext,
    @Body() body: { productId: string; sharePolicy?: SharePolicy },
  ) {
    return this.sharesService.createShare(user, body);
  }

  /** 打开分享：首访绑定 + 鉴权放行 */
  @Get(':shareId/open')
  open(@AuthUser() user: AuthContext, @Param('shareId') shareId: string) {
    return this.sharesService.openShare(user, shareId);
  }
}
