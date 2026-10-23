import { Injectable, NestMiddleware, BadRequestException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * 租户解析占位：
 * 正式环境由小程序 AppID（请求头 X-Wx-Appid）映射 tenantId。
 * 开发可用 X-Tenant-Id 直传。
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request & { tenantId?: string }, _res: Response, next: NextFunction) {
    const appId = (req.headers['x-wx-appid'] as string) || '';
    const tenantId = (req.headers['x-tenant-id'] as string) || '';
    if (tenantId) {
      req.tenantId = tenantId;
    } else if (appId) {
      // 实际由 TenantsService.resolveByAppId；中间件层仅挂载 appId
      (req as Request & { wxAppId?: string }).wxAppId = appId;
    } else {
      // 登录等接口允许后置解析；此处不强制抛错
    }
    if (!tenantId && !appId && req.path.startsWith('/api/') && !req.path.startsWith('/api/auth/') && !req.path.startsWith('/api/health')) {
      // 非鉴权健康检查可放行；业务接口建议带租户标识
    }
    next();
  }
}
