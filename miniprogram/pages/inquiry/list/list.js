const { request } = require('../../../utils/request');
Page({
  data: { list: [] },
  onShow() { this.load(); },
  async load() {
    try {
      const list = await request({ url: '/api/inquiries' });
      this.setData({ list: list || [] });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  goDetail(e) {
    wx.navigateTo({ url: `/pages/inquiry/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
});
