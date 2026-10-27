const { request } = require('../../../utils/request');

function statusLabel(s) {
  if (s === 'handled') return '已处理';
  if (s === 'in_progress') return '正在沟通';
  if (s === 'replied') return '已回复';
  if (s === 'closed') return '已关闭';
  return '待沟通';
}

Page({
  data: {
    list: [],
    status: 'open', // 默认待沟通
    statusChips: [
      { id: 'open', name: '待沟通' },
      { id: 'in_progress', name: '正在沟通' },
      { id: '', name: '全部' },
      { id: 'handled', name: '已处理' },
    ],
  },
  onShow() { this.load(); },
  onStatus(e) {
    this.setData({ status: e.currentTarget.dataset.id || '' });
    this.load();
  },
  async load() {
    try {
      const qs = [];
      if (this.data.status) qs.push(`status=${encodeURIComponent(this.data.status)}`);
      const raw = await request({ url: `/api/inquiries${qs.length ? '?' + qs.join('&') : ''}` });
      const list = (raw || []).map((i) => Object.assign({}, i, {
        statusLabel: statusLabel(i.status),
        title: i.productName || i.productId || '询价',
        handlerText: (i.assigneeName || '').trim() || '未认领',
      }));
      this.setData({ list });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  goDetail(e) {
    wx.navigateTo({ url: `/pages/inquiry/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
});
