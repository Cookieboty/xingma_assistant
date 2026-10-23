/** 环境配置映射 */
const env = (k: string, ...alts: string[]) => {
  for (const key of [k, ...alts]) {
    const v = process.env[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    name: process.env.DB_NAME || 'wool_stall',
    // 无真实 DB 时设为 false，配合 synchronize/mock
    enabled: process.env.DB_ENABLED === 'true',
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-only-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  oss: {
    provider: env('OSS_PROVIDER') || 'mock', // mock|aliyun|cos
    endpoint: env('OSS_ENDPOINT', 'ALIYUN_OSS_ENDPOINT') || '',
    region: env('OSS_REGION', 'ALIYUN_OSS_REGION') || '',
    bucket: env('OSS_BUCKET', 'ALIYUN_OSS_BUCKET') || '',
    prefix: env('OSS_PREFIX', 'ALIYUN_OSS_PREFIX') || '',
    accessKeyId: env('OSS_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_ID') || '',
    accessKeySecret: env('OSS_ACCESS_KEY_SECRET', 'ALIYUN_ACCESS_KEY_SECRET') || '',
    // 私有桶签名 GET 过期秒数；优先 OSS_SIGNED_URL_EXPIRES，兼容 OSS_SIGNED_TTL
    signedUrlTtlSec: parseInt(env('OSS_SIGNED_URL_EXPIRES', 'OSS_SIGNED_TTL') || '3600', 10),
    mediaPublicBase: env('MEDIA_PUBLIC_BASE') || '',
    serveLocal: env('MEDIA_SERVE_LOCAL') === '1' || env('MEDIA_SERVE_LOCAL').toLowerCase() === 'true',
    publicRead: env('OSS_PUBLIC_READ') === '1' || env('OSS_PUBLIC_READ').toLowerCase() === 'true',
    objectAcl: (env('OSS_OBJECT_ACL') || 'private').toLowerCase() === 'public-read' ? 'public-read' : 'private',
  },
  appBaseUrl: process.env.APP_BASE_URL || 'http://127.0.0.1:3000',
  wechat: {
    // 默认租户 AppID；多租户以 tenants 表为准。兼容旧变量 WX_APPID / WX_APP_SECRET
    defaultAppId: process.env.WECHAT_APP_ID || process.env.WX_APPID || '',
    // 绝不硬编码：仅从环境变量（或 tenants.wx_app_secret）读取
    defaultAppSecret: process.env.WECHAT_APP_SECRET || process.env.WX_APP_SECRET || '',
    // true 时跳过 jscode2session，用 code 派生假 openid（仅本地开发）
    devFakeLogin: process.env.DEV_FAKE_LOGIN === 'true',
  },
});
