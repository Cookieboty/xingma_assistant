/**
 * 员工/业主邀请落地：小程序码 scene=c=CODE 或 query invite/code
 * 微信登录 → 带 inviteCode 换 JWT → 绑定成员 → 进工作台
 * 分享进线会显示「房子」回首页：hideHomeButton + pendingInvite 保活，避免丢码变客户
 */
const { request } = require('../../../utils/request');
const inviteUtil = require('../../../utils/invite');

Page({
  data: {
    loading: true,
    error: '',
    code: '',
    roleLabel: '',
  },
  onLoad(q) {
    this._hideHome();
    let code = inviteUtil.extractInviteCode(q || '');
    if (!code) code = inviteUtil.readPendingInviteCode();
    code = inviteUtil.normalizeCode(code);
    if (code) inviteUtil.savePendingInviteCode(code);
    this.setData({ code });
    this.run(code);
  },
  onShow() {
    this._hideHome();
  },
  _hideHome() {
    try {
      if (typeof wx.hideHomeButton === 'function') wx.hideHomeButton();
    } catch (e) { /* */ }
  },
  async run(code) {
    code = inviteUtil.normalizeCode(code);
    if (!code) {
      this.setData({ loading: false, error: '缺少邀请码，请打开业主发来的邀请卡片，或手动输入邀请码' });
      return;
    }
    inviteUtil.savePendingInviteCode(code);
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
        // 清掉可能残留的客户会话，避免旧 token 干扰（登录接口本身会重签）
        try {
          app.globalData.token = '';
          app.globalData.role = '';
          wx.removeStorageSync('token');
          wx.removeStorageSync('role');
        } catch (e) { /* */ }
        const wxCode = await new Promise((resolve, reject) => {
          wx.login({
            success: (r) => (r.code ? resolve(r.code) : reject(new Error('wx.login 无 code'))),
            fail: (e) => reject(new Error((e && e.errMsg) || 'wx.login 失败')),
          });
        });
        session = await request({
          url: '/api/auth/login',
          method: 'POST',
          data: { code: wxCode, inviteCode: code, preferRole: 'staff' },
        });
        app.setSession(session);
      }
      wx.hideLoading();
      if (session.role !== 'owner' && session.role !== 'staff') {
        this.setData({ loading: false, error: '绑定失败，仍为客户角色。请确认邀请码有效，或让业主重新转发邀请卡片' });
        return;
      }
      inviteUtil.clearPendingInviteCode();
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
    this.setData({ code: inviteUtil.normalizeCode((e.detail && e.detail.value) || '') });
  },
  retry() {
    const code = inviteUtil.normalizeCode(this.data.code || '');
    this.setData({ loading: true, error: '', code });
    this.run(code);
  },
  goHome() {
    // 用户主动回首页：清掉 pending，避免 index onShow 又 reLaunch 回本页死循环
    inviteUtil.clearPendingInviteCode();
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
