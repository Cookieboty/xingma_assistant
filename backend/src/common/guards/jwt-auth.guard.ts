import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../../auth/auth.service';

/**
 * JWT / Session 占位守卫：
 * 从 Authorization: Bearer <token> 解析，写入 req.user
 * 真实环境应接 Passport JWT；此处可编译、可 mock。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const auth = req.headers['authorization'] || req.headers['Authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少登录凭证');
    }
    const token = auth.slice(7);
    const ctx = this.authService.verifyToken(token);
    if (!ctx) {
      throw new UnauthorizedException('登录凭证无效或已过期');
    }
    req.user = ctx;
    return true;
  }
}
