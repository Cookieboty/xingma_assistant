/**
 * 客户目录：某分组下可公开展示（客户鉴权后可见）的在售商品。
 * 从分享落地的商品详情进入，携带 groupId + shareEventId。
 */
const { request, ensureSilentSession } = require('../../../utils/request');

const PAGE_SIZE = 20;

function normalize(p) {
  return Object.assign({}, p, {
    coverUrl: p.coverUrl || (p.images && p.images[0] && p.images[0].url) || '',
    priceText: p.priceText || '询价',
  });
}

Page({
  data: {
    groupId: '',
    groupName: '',
    shareEventId: '',
    boundCustomerId: '',
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    loadingMore: false,
  },

  async onLoad(q) {
    const groupId = q.groupId || '';
    const shareEventId = q.shareEventId || '';
    const boundCustomerId = q.boundCustomerId || '';
    const groupName = q.groupName ? decodeURIComponent(q.groupName) : '';
    this.setData({ groupId, shareEventId, boundCustomerId, groupName });
    try {
      if (!getApp().globalData.token) {
        await ensureSilentSession({ preferRole: 'customer' });
      }
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '鉴权失败', icon: 'none' });
      return;
    }
    await this.reload();
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return;
    this.loadMore();
  },

  buildQs(page) {
    const qs = [`status=on_sale`, `publicOnly=1`, `page=${page}`, `pageSize=${PAGE_SIZE}`];
    if (this.data.groupId) qs.push(`groupId=${encodeURIComponent(this.data.groupId)}`);
    if (this.data.shareEventId) {
      qs.push(`shareEventId=${encodeURIComponent(this.data.shareEventId)}`);
    }
    if (this.data.boundCustomerId) {
      qs.push(`boundCustomerId=${encodeURIComponent(this.data.boundCustomerId)}`);
    }
    return qs.join('&');
  },

  async reload() {
    this.setData({ loading: true, page: 1, hasMore: true, list: [] });
    try {
      const res = await request({ url: `/api/products?${this.buildQs(1)}` });
      const items = ((res && res.items) || []).map(normalize);
      const total = (res && res.total) != null ? res.total : items.length;
      this.setData({
        list: items,
        page: 1,
        hasMore: items.length < total && items.length >= PAGE_SIZE,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' });
    }
  },

  async loadMore() {
    const next = this.data.page + 1;
    this.setData({ loadingMore: true });
    try {
      const res = await request({ url: `/api/products?${this.buildQs(next)}` });
      const items = ((res && res.items) || []).map(normalize);
      const list = this.data.list.concat(items);
      const total = (res && res.total) != null ? res.total : list.length;
      this.setData({
        list,
        page: next,
        hasMore: list.length < total && items.length >= PAGE_SIZE,
        loadingMore: false,
      });
    } catch (e) {
      this.setData({ loadingMore: false });
    }
  },

  goProduct(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const qs = [`id=${id}`];
    if (this.data.shareEventId) qs.push(`shareEventId=${this.data.shareEventId}`);
    if (this.data.boundCustomerId) qs.push(`boundCustomerId=${this.data.boundCustomerId}`);
    wx.navigateTo({ url: `/pages/product/view/view?${qs.join('&')}` });
  },
});
