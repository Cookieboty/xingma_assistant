/**
 * 员工/业主邀请落地：小程序码 scene=c=CODE 或 query invite/code
 * 微信登录 → 带 inviteCode 换 JWT → 绑定成员 → 进工作台
 */
const { request } = require('../../../utils/request');

function parseScene(scene) {
  if (!scene) return '';
  let s = String(scene);
  try {
    s = decodeURIComponent(s);
  } catch (e) { /* */ }
  const m = s.match(/(?:^|[&?])c=([A-Za-z0-9]+)/);
  if (m) return m[1].toUpperCase();
  if (/^[A-Za-z0-9]{6,16}$/.test(s)) return s.toUpperCase();
  return '';
}

Page({
  data: {
    loading: true,
    error: '',
    code: '',
    roleLabel: '',
  },
  onLoad(q) {
    let code = (q && (q.invite || q.code || q.c)) || '';
    if (!code && q && q.scene) code = parseScene(q.scene);
    code = String(code || '').trim().toUpperCase();
    this.setData({ code });
    this.run(code);
  },
  async run(code) {
    if (!code) {
      this.setData({ loading: false, error: '缺少邀请码，请扫描业主生成的小程序码' });
      return;
    }
    wx.showLoading({ title: '加入中', mask: true });
    try {
      const app = getApp();
      const base = (app.globalData && app.globalData.baseUrl) || '';
      const allowFake = /127\.0\.0\.1|localhost/.test(base);
      let session;
      if (allowFake) {
        session = await request({
          url: '/api/auth/login',
          method: 'POST',
          data: {
            code: `dev_invite_${Date.now()}`,
            tenantId: app.globalData.tenantId,
            preferRole: 'staff',
            inviteCode: code,
          },
        });
        app.setSession(session);
      } else {
        const wxCode = await new Promise((resolve, reject) => {
          wx.login({
            success: (r) => (r.code ? resolve(r.code) : reject(new Error('wx.login 无 code'))),
            fail: (e) => reject(new Error((e && e.errMsg) || 'wx.login 失败')),
          });
        });
        session = await request({
          url: '/api/auth/login',
          method: 'POST',
          data: { code: wxCode, inviteCode: code },
        });
        app.setSession(session);
      }
      wx.hideLoading();
      if (session.role !== 'owner' && session.role !== 'staff') {
        this.setData({ loading: false, error: '绑定失败，仍为客户角色，请联系业主重发邀请' });
        return;
      }
      const roleLabel = session.role === 'owner' ? '业主' : '员工';
      this.setData({ loading: false, roleLabel, error: '' });
      wx.showToast({ title: `已加入（${roleLabel}）`, icon: 'success' });
      setTimeout(() => {
        wx.switchTab({ url: '/pages/product/list/list' });
      }, 600);
    } catch (e) {
      wx.hideLoading();
      this.setData({ loading: false, error: (e && e.message) || '加入失败' });
    }
  },
  onCodeInput(e) {
    this.setData({ code: String((e.detail && e.detail.value) || '').trim().toUpperCase() });
  },
  retry() {
    const code = String(this.data.code || '').trim().toUpperCase();
    this.setData({ loading: true, error: '', code });
    this.run(code);
  },
  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
