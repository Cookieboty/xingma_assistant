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
  const hasPendingInquiry = !!c.hasPendingInquiry || pendingInquiryCount > 0 || hasUnreadInquiry;
  // 行红点：未处理或未读（已处理且已读后应消失；见 unread-summary）
  const showDot = hasUnreadInquiry;
  return Object.assign({}, c, {
    displayName,
    contactLine,
    nickShort,
    inquiryCount,
    hasUnreadInquiry,
    hasPendingInquiry,
    pendingInquiryCount,
    showDot,
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
      // 合并未读摘要，保证 hasUnreadInquiry 准确
      try {
        const summary = await request({ url: '/api/inquiries/unread-summary' });
        const byId = {};
        ((summary && summary.customers) || []).forEach((c) => { byId[c.customerId] = c; });
        raw = (raw || []).map((c) => {
          const s = byId[c.id] || {};
          return Object.assign({}, c, {
            inquiryCount: s.inquiryCount != null ? s.inquiryCount : c.inquiryCount,
            hasUnreadInquiry: !!s.hasUnreadInquiry,
            unreadCount: s.unreadCount || 0,
          });
        });
      } catch (e2) { /* */ }
      let list = (raw || []).map(enrich);
      if (this.data.filter === 'pending') {
        try {
          const inqs = await request({ url: '/api/inquiries' });
          const pendingIds = {};
          (inqs || []).forEach((i) => {
            const st = String((i && i.status) || 'open');
            if (st === 'open' || st === 'pending' || st === 'in_progress' || (!i.status && i.unread)) {
              if (i.customerId) pendingIds[i.customerId] = true;
            }
          });
          list = list.filter((c) => pendingIds[c.id] || c.hasUnreadInquiry);
        } catch (e3) {
          list = list.filter((c) => c.hasUnreadInquiry);
        }
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
