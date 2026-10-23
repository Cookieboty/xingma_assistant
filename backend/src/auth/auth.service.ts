import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthContext } from '../common/interfaces/auth-context.interface';

export interface LoginResult {
  token: string;
  role: AuthContext['role'];
  tenantId: string;
  openid: string;
  memberId?: string;
  customerId?: string;
}

/** JWT 签发与校验（登录流程见 login/login.service.ts） */
@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  async sign(payload: AuthContext): Promise<string> {
    return this.jwt.signAsync({ ...payload });
  }

  verifyToken(token: string): AuthContext | null {
    try {
      return this.jwt.verify(token) as AuthContext;
    } catch {
      return null;
    }
  }
}
