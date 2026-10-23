/** 登录后注入到请求上的上下文 */
export interface AuthContext {
  tenantId: string;
  openid: string;
  /** staff | owner | customer */
  role: 'owner' | 'staff' | 'customer';
  memberId?: string;
  customerId?: string;
}
