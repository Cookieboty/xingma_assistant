/** 统一请求封装：自动带 token / tenant / appid */

function getAppId(app) {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    if (info && info.miniProgram && info.miniProgram.appId) return info.miniProgram.appId;
  } catch (e) { /* ignore */ }
  return (app && app.globalData && app.globalData.appId) || 'wx394d23ea099d8a01';
}

function formatErr(err, baseUrl) {
  const raw = (err && (err.message || err.errMsg)) || '';
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (!s || /request:fail|timeout|ERR_|Failed to connect|连接|abort/i.test(s)) {
    const tip = baseUrl && /127\.0\.0\.1|localhost/.test(baseUrl)
      ? '真机不能访问 127.0.0.1，请把 baseUrl 改成电脑局域网 IP'
      : `无法连接 ${baseUrl || '后端'}，请确认后端已启动且手机与电脑同一 WiFi`;
    return tip;
  }
  return s.length > 60 ? s.slice(0, 60) : s;
}

function request(options) {
  const app = getApp();
  const baseUrl = (app && app.globalData && app.globalData.baseUrl) || '';
  const token = (app && app.globalData && app.globalData.token) || wx.getStorageSync('token') || '';
  const tenantId = (app && app.globalData && app.globalData.tenantId) || 'tenant_dev_001';

  return new Promise((resolve, reject) => {
    wx.request({
      url: baseUrl + options.url,
      method: options.method || 'GET',
      data: options.data || {},
      header: Object.assign(
        {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
          'X-Tenant-Id': tenantId,
          'X-Wx-Appid': getAppId(app),
        },
        options.header || {},
      ),
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          const msg = (res.data && (res.data.message || res.data.error)) || `HTTP ${res.statusCode}`;
          reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)));
        }
      },
      fail(err) {
        reject(new Error(formatErr(err, baseUrl)));
      },
    });
  });
}

/** 真实登录：wx.login 取 code → 后端 jscode2session → JWT（角色由后端成员表判定） */
function wxLogin(preferRole) {
  const app = getApp();
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => (r.code ? resolve(r.code) : reject(new Error('wx.login 未返回 code'))),
      fail: (err) => reject(new Error((err && err.errMsg) || 'wx.login 失败')),
    });
  })
    .then((code) => request({ url: '/api/auth/login', method: 'POST', data: preferRole ? { code, preferRole } : { code } }))
    .then((session) => {
      app.setSession(session);
      return session;
    });
}

/** 开发态登录：用 mock code 换 JWT（需后端 DEV_FAKE_LOGIN=true，生产会被拒绝） */
function loginAs(preferRole) {
  const app = getApp();
  return request({
    url: '/api/auth/login',
    method: 'POST',
    data: {
      code: `dev_${preferRole}_${Date.now()}`,
      tenantId: app.globalData.tenantId,
      preferRole,
    },
  }).then((session) => {
    app.setSession(session);
    return session;
  });
}

/**
 * 客户分享链路静默鉴权：有本地 token 则复用；否则后台取 code 换 JWT。
 * 不展示任何登录 UI。开发者工具里若 wx.login 不可用且后端开了 DEV_FAKE_LOGIN，可回退假客户登录。
 */
function ensureSilentSession(opts) {
  const app = getApp();
  const preferRole = (opts && opts.preferRole) || 'customer';
  if (app.globalData.token) {
    return Promise.resolve({
      token: app.globalData.token,
      role: app.globalData.role,
      tenantId: app.globalData.tenantId,
    });
  }
  return wxLogin().catch((err) => {
    // 仅本机开发者工具回退假登录；真机（局域网/生产域名）必须走真实微信 code
    const base = (app.globalData && app.globalData.baseUrl) || '';
    const allowFake = /127\.0\.0\.1|localhost/.test(base);
    if (allowFake && preferRole) {
      return loginAs(preferRole);
    }
    return Promise.reject(err);
  });
}

module.exports = { request, loginAs, wxLogin, ensureSilentSession };
