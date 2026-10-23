import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthContext } from '../interfaces/auth-context.interface';

/** 从请求中取出鉴权上下文 */
export const AuthUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthContext }>();
    return req.user;
  },
);
