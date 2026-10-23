const { loginAs, wxLogin } = require('../../utils/request');

Page({
  data: {
    role: '',
    roleLabel: '',
    tenantId: '',
    isStaff: false,
    customerHint: '请通过分享卡片打开',
    showDevLogin: false,
  },
  onShow() {
    const app = getApp();
    const role = app.globalData.role || '';
    const base = app.globalData.baseUrl || '';
    const showDevLogin = /127\.0\.0\.1|localhost/.test(base);
    const isStaff = role === 'owner' || role === 'staff';
    this.setData({
      role,
      roleLabel: this.labelOf(role),
      tenantId: app.globalData.tenantId,
      isStaff,
      showDevLogin,
    });
    // 已登录员工：直接进三 tab 首页（默认商品）
    if (isStaff && app.globalData.token) {
      wx.switchTab({ url: '/pages/product/list/list' });
    }
  },
  labelOf(role) {
    if (role === 'owner') return '业主';
    if (role === 'staff') return '员工';
    if (role === 'customer') return '客户';
    return '';
  },
  errText(e) {
    const m = (e && (e.message || e.errMsg)) || '';
    return (m && String(m)) || '登录失败';
  },
  /** 业主/员工：微信登录，角色由后端成员表判定（客户勿点此入口） */
  async enterWithWechat() {
    wx.showLoading({ title: '登录中', mask: true });
    try {
      const session = await wxLogin('owner');
      wx.hideLoading();
      if (session.role !== 'owner' && session.role !== 'staff') {
        this.logout();
        wx.showToast({ title: '非档口成员，客户请从分享卡片进入', icon: 'none', duration: 2500 });
        return;
      }
      this.goWorkbench();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: this.errText(e).slice(0, 40), icon: 'none', duration: 3500 });
    }
  },
  async enterAsStaff() {
    wx.showLoading({ title: '登录中', mask: true });
    try {
      await loginAs('staff');
      wx.hideLoading();
      this.goWorkbench();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: this.errText(e).slice(0, 40), icon: 'none', duration: 3500 });
    }
  },
  goWorkbench() {
    wx.switchTab({ url: '/pages/product/list/list' });
  },
  logout() {
    const app = getApp();
    app.globalData.token = '';
    app.globalData.role = '';
    wx.removeStorageSync('token');
    wx.removeStorageSync('role');
    this.onShow();
  },
});
