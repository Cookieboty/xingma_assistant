const { request } = require('../../../utils/request');
Page({
  data: { mode: '', productId: '', content: '', inquiry: null },
  onLoad(q) {
    if (q.mode === 'create') {
      this.setData({ mode: 'create', productId: q.productId || '' });
    } else if (q.id) {
      this.load(q.id);
    }
  },
  onContent(e) { this.setData({ content: e.detail.value }); },
  async submit() {
    try {
      const inquiry = await request({
        url: '/api/inquiries',
        method: 'POST',
        data: { productId: this.data.productId, content: this.data.content },
      });
      this.setData({ inquiry, mode: '' });
      wx.showToast({ title: '已提交' });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  async load(id) {
    try {
      const inquiry = await request({ url: `/api/inquiries/${id}` });
      this.setData({ inquiry });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
});
