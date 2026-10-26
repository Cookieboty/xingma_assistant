const publishQueue = require('../../../utils/publish-upload-queue');
const { request } = require('../../../utils/request');
const { refreshCustomerTabBadge } = require('../../../utils/customer-tab-badge');

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
  const nickname = (c.nickname || c.contactName || '').trim();
  const phone = (c.phone || '').trim();
  let displayName = nickname;
  if (!displayName && phone) displayName = phone;
  if (!displayName) displayName = '未留联系方式';
  const contactLine = [nickname, phone].filter(Boolean).join(' · ') || '未留联系方式';
  const nickShort = (nickname || phone || '客').slice(0, 1);
  const inquiryCount = c.inquiryCount || 0;
  const hasUnreadInquiry = !!c.hasUnreadInquiry;
  const pendingInquiryCount = Number(c.pendingInquiryCount || c.openInquiryCount || 0);
  const hasPendingInquiry = !!c.hasPendingInquiry || pendingInquiryCount > 0;
  // 行红点/徽章：仅未处理或未读；已处理不再显示
  const showDot = hasUnreadInquiry || hasPendingInquiry;
  const showInquiryBadge = hasUnreadInquiry || hasPendingInquiry;
  return Object.assign({}, c, {
    displayName,
    contactLine,
    nickShort,
    inquiryCount,
    hasUnreadInquiry,
    hasPendingInquiry,
    pendingInquiryCount,
    showDot,
    showInquiryBadge,
  });
}

Page({
  data: {
    list: [],
    q: '',
    loading: true,
    filter: '', // '' | pending
    filterChips: [
      { id: '', name: '全部' },
      { id: 'pending', name: '待处理' },
    ],
  },
  onShow() {
    try { publishQueue.resumeAll(); } catch (e) { /* */ }
    if (!ensureStaff()) return;
    this.load();
    refreshCustomerTabBadge();
  },
  onPullDownRefresh() {
    Promise.all([this.load(), refreshCustomerTabBadge()]).finally(() => wx.stopPullDownRefresh());
  },
  onSearchInput(e) { this.setData({ q: e.detail.value }); },
  onSearch() { this.load(); },
  onFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.id || '' });
    this.load();
  },
  async load() {
    this.setData({ loading: true });
    try {
      const qs = [];
      if (this.data.q) qs.push(`q=${encodeURIComponent(this.data.q)}`);
      const res = await request({ url: `/api/customers${qs.length ? '?' + qs.join('&') : ''}` });
      let raw = Array.isArray(res) ? res : (res.items || res || []);
      // /api/customers 已附带 unread-summary 字段，避免再打一遍
      let list = (raw || []).map(enrich);
      // 未留手机/昵称等可用联系方式的客户不展示
      list = list.filter((c) => {
        const phone = (c.phone || '').trim();
        const nick = (c.nickname || c.contactName || '').trim();
        return !!(phone || nick);
      });
      if (this.data.filter === 'pending') {
        list = list.filter((c) => c.hasPendingInquiry || c.hasUnreadInquiry);
      }
      this.setData({ list, loading: false });
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
