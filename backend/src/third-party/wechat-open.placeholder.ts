/**
 * 预留：微信第三方平台代开发接口位
 * - 授权事件接收
 * - authorizer_access_token 刷新
 * - 代小程序调用
 * 首期不实现，仅占位避免后续大改目录。
 */
export interface WechatOpenPlatformPort {
  handleAuthEvent(payload: unknown): Promise<void>;
  getAuthorizerToken(authorizerAppid: string): Promise<string>;
}

export class WechatOpenPlatformStub implements WechatOpenPlatformPort {
  async handleAuthEvent(_payload: unknown): Promise<void> {
    /* no-op */
  }
  async getAuthorizerToken(_authorizerAppid: string): Promise<string> {
    throw new Error('第三方平台未启用');
  }
}
