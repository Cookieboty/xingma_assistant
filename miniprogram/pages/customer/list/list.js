const publishQueue = require('../../../utils/publish-upload-queue');
const { request } = require('../../../utils/request');

function ensureStaff() {
  const app = getApp();
  const role = app.globalData.role || '';
  const token = app.globalData.token || '';
  if (!token || (role !== 'owner' && role !== 'staff')) {
    wx.reLaunch({ url: '/pages/index/index' });
    return false;
  }
  return true;
}

function enrich(c) {
  const nickname = (c.nickname || '').trim();
  const displayName = nickname || (c.openid ? `客户 ${String(c.openid).slice(-6)}` : c.id);
  const nickShort = (nickname || displayName).slice(0, 1);
  return Object.assign({}, c, { displayName, nickShort });
}

Page({
  data: { list: [], q: '', loading: true },
  onShow() {
    try { publishQueue.resumeAll(); } catch (e) { /* */ }
    if (!ensureStaff()) return;
    this.load();
  },
  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },
  onSearchInput(e) { this.setData({ q: e.detail.value }); },
  onSearch() { this.load(); },
  async load() {
    this.setData({ loading: true });
    try {
      const qs = [];
      if (this.data.q) qs.push(`q=${encodeURIComponent(this.data.q)}`);
      const res = await request({ url: `/api/customers${qs.length ? '?' + qs.join('&') : ''}` });
      const raw = Array.isArray(res) ? res : (res.items || res || []);
      this.setData({ list: (raw || []).map(enrich), loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },
  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/customer/detail/detail?id=${id}` });
  },
});
