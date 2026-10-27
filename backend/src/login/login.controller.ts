import { Body, Controller, Get, Headers, Patch, Post, UseGuards } from '@nestjs/common';
import { LoginService } from './login.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';

@Controller('api/auth')
export class LoginController {
  constructor(private readonly login: LoginService) {}

  /**
   * POST /api/auth/login — wx.login code 换 JWT；AppID 取请求头 X-Wx-Appid 或 body.appId。
   * 客户无登录页：分享落地页后台静默调本接口换 openid/JWT；业主/员工在首页显式登录。
   */
  @Post('login')
  doLogin(
    @Headers('x-wx-appid') headerAppId: string | undefined,
    @Body() body: { code: string; appId?: string; tenantId?: string; preferRole?: 'owner' | 'staff' | 'customer'; inviteCode?: string },
  ) {
    return this.login.login({ ...body, appId: body.appId || headerAppId });
  }

  /** 当前会话资料（昵称头像） */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@AuthUser() user: AuthContext) {
    return this.login.getMe(user);
  }

  /** 回写昵称/头像/手机（客户 → customer_profiles；员工昵称 → tenant_members） */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateMe(
    @AuthUser() user: AuthContext,
    @Body() body: { nickname?: string; avatarUrl?: string; phone?: string },
  ) {
    return this.login.updateProfile(user, body || {});
  }

  /**
   * 微信手机号快速验证：前端 button open-type=getPhoneNumber 的 code → 换号并写入资料。
   * 需非个人主体且已微信认证；额度不足/个人主体时前端应回退手填。
   */
  @Post('me/phone')
  @UseGuards(JwtAuthGuard)
  bindPhone(
    @AuthUser() user: AuthContext,
    @Body() body: { code?: string },
  ) {
    return this.login.bindPhoneFromWechat(user, body?.code || '');
  }
}
