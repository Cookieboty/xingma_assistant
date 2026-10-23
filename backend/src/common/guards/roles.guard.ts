import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthContext } from '../interfaces/auth-context.interface';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Array<'owner' | 'staff' | 'customer'>) =>
  SetMetadata(ROLES_KEY, roles);

/** 角色守卫：业主/员工/客户 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const req = context.switchToHttp().getRequest<{ user?: AuthContext }>();
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ForbiddenException('无权访问');
    }
    return true;
  }
}
