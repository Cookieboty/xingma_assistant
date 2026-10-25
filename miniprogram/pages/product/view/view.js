/**
 * 客户专用商品详情（分享落地目标页）。
 * 与 pages/product/detail（员工管理页）分离：本页永不渲染管理控件。
 */
const { request, ensureSilentSession } = require('../../../utils/request');
const {
  hasContactInfo,
  isContactPrompted,
  markContactPrompted,
  isProfileComplete,
  isProfilePrompted,
  markProfilePrompted,
  saveProfileWithAvatarUpload,
} = require('../../../utils/profile');

function skuHasPrice(s) {
  if (!s) return false;
  const p = s.price;
  if (p == null) return false;
  const t = String(p).trim();
  return t !== '' && t !== '询价' && t !== '未标价';
}

function formatSkuPrice(p) {
  const t = String(p).trim();
  if (/^¥/.test(t) || /^￥/.test(t)) return t;
  return `¥${t}`;
}

/** 客户页不展示发品内部标记 */
function publicTags(tags) {
  return (tags || []).filter((t) => {
    if (t == null) return false;
    const s = String(t).trim();
    if (!s) return false;
    if (s === 'needReview' || s === 'provisionalStyleNo' || s === '识别中') return false;
    if (s.indexOf('review:') === 0) return false;
    return true;
  });
}

Page({
  data: {
    product: null,
    canDownload: false,
    id: '',
    shareEventId: '',
    boundCustomerId: '',
    groupId: '',
    showCatalogCta: false,
    contactQrUrl: '',
    error: '',
    hasPrice: false,
    showContactPriceHint: false,
    skuRows: [],
    showSoftTip: false,
    showInquirySheet: false,
    showProfileSheet: false,
    contactPhone: '',
    contactName: '',
    contactRemark: '',
    profilePhone: '',
    profileName: '',
    profileAvatarUrl: '',
    profileDraftNick: '',
    profileDraftPhone: '',
    profileSaving: false,
  },
  async onLoad(q) {
    const shareEventId = q.shareEventId || '';
    const boundCustomerId = q.boundCustomerId || '';
    const id = q.id || '';
    this.setData({ id, shareEventId, boundCustomerId });
    try {
      if (!getApp().globalData.token) {
        await ensureSilentSession({ preferRole: 'customer' });
      }
    } catch (e) {
      this.setData({ error: (e && e.message) || '鉴权失败' });
      return;
    }
    await this.load(id, shareEventId, boundCustomerId);
    await this.loadProfileForInquiry();
    try {
      wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    } catch (e) {
      try { wx.hideShareMenu(); } catch (e2) { /* */ }
    }
  },
  buildSkuState(product) {
    const skus = (product && product.skus) || [];
    const rows = skus.map((s) => ({
      id: s.id || s.skuCode || s.color,
      color: s.color || '-',
      price: s.price,
      priceText: skuHasPrice(s) ? formatSkuPrice(s.price) : '',
    }));
    const hasPrice = rows.some((r) => r.priceText);
    return {
      skuRows: rows,
      hasPrice,
      showContactPriceHint: rows.length > 0 ? !hasPrice : !hasPrice,
    };
  },
  async load(id, shareEventId, boundCustomerId) {
    if (!id) {
      this.setData({ error: '缺少商品参数' });
      return;
    }
    try {
      let url = `/api/products/${id}`;
      const qs = [];
      if (shareEventId) qs.push(`shareEventId=${shareEventId}`);
      if (boundCustomerId) qs.push(`boundCustomerId=${boundCustomerId}`);
      if (qs.length) url += `?${qs.join('&')}`;
      const product = await request({ url });
      const skuState = this.buildSkuState(product);
      const safe = Object.assign({}, product, { tags: publicTags(product.tags) });
      const groupId = product.groupId || '';
      this.setData({
        product: safe,
        canDownload: !!product.allowCustomerDownload,
        groupId,
        showCatalogCta: !!groupId,
        error: '',
        ...skuState,
      });
      this.loadContactQr();
    } catch (e) {
      this.setData({ error: (e && e.message) || '无权查看' });
      wx.showToast({ title: (e && e.message) || '无权查看', icon: 'none' });
    }
  },
  async loadContactQr() {
    try {
      const tenant = await request({ url: '/api/tenants/current' });
      this.setData({ contactQrUrl: (tenant && tenant.contactQrUrl) || '' });
    } catch (e) {
      /* ignore */
    }
  },
  previewImage(e) {
    const images = (this.data.product && this.data.product.images) || [];
    const urls = images.map((im) => im && im.url).filter(Boolean);
    if (!urls.length) return;
    let idx = Number(e.currentTarget.dataset.index);
    if (!Number.isFinite(idx) || idx < 0 || idx >= urls.length) idx = 0;
    const current = urls[idx];
    wx.previewImage({
      urls,
      current,
      fail: (err) => {
        console.warn('previewImage fail', err);
        wx.showToast({ title: '无法预览图片', icon: 'none' });
      },
    });
  },

  /** 预填联系方式；首次打开软提示完善资料（头像+昵称+手机，可跳过） */
  async loadProfileForInquiry() {
    try {
      const me = await request({ url: '/api/auth/me' });
      const phone = (me && me.phone) || '';
      const name = (me && me.nickname) || '';
      const avatar = (me && me.avatarUrl) || '';
      this.setData({
        profilePhone: phone,
        profileName: name,
        profileAvatarUrl: avatar,
        contactPhone: phone,
        contactName: name,
        profileDraftNick: name,
        profileDraftPhone: phone,
      });
      // 首次客户打开：软弹完善资料（不挡看货；可跳过）
      if (!isProfilePrompted() && !isProfileComplete(me)) {
        this.setData({ showProfileSheet: true, showSoftTip: false });
      } else if (!hasContactInfo(me) && !isContactPrompted()) {
        this.setData({ showSoftTip: true });
      } else if (hasContactInfo(me)) {
        markContactPrompted();
      }
      if (isProfileComplete(me)) markProfilePrompted();
    } catch (e) {
      /* 不阻断看货 */
    }
  },
  skipProfileSheet() {
    markProfilePrompted();
    this.setData({ showProfileSheet: false });
    // 仍无联系方式时给询价轻提示
    if (!hasContactInfo({
      phone: this.data.profilePhone || this.data.profileDraftPhone,
      nickname: this.data.profileName || this.data.profileDraftNick,
    }) && !isContactPrompted()) {
      this.setData({ showSoftTip: true });
    }
  },
  onProfileChooseAvatar(e) {
    const url = (e.detail && e.detail.avatarUrl) || '';
    if (url) this.setData({ profileAvatarUrl: url });
  },
  onProfileNick(e) {
    this.setData({ profileDraftNick: e.detail.value });
  },
  onProfilePhone(e) {
    this.setData({ profileDraftPhone: e.detail.value });
  },
  async onProfileGetPhone(e) {
    const detail = (e && e.detail) || {};
    if (detail.errno === 1400001) {
      wx.showToast({ title: '手机号额度不足', icon: 'none' });
      return;
    }
    if (!detail.code) {
      const denied = (detail.errMsg || '').indexOf('deny') >= 0;
      wx.showToast({ title: denied ? '已取消授权' : '无法获取微信手机号', icon: 'none' });
      return;
    }
    try {
      const me = await request({
        url: '/api/auth/me/phone',
        method: 'POST',
        data: { code: detail.code },
      });
      const phone = (me && me.phone) || '';
      if (phone) {
        this.setData({
          profileDraftPhone: phone,
          profilePhone: phone,
          contactPhone: phone,
        });
        wx.showToast({ title: '已填入手机号', icon: 'success' });
      }
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '微信手机号不可用', icon: 'none' });
    }
  },
  async saveProfileSheet() {
    if (this.data.profileSaving) return;
    const nickname = (this.data.profileDraftNick || '').trim();
    const phone = (this.data.profileDraftPhone || '').trim();
    const avatarUrl = (this.data.profileAvatarUrl || '').trim();
    if (!nickname && !phone && !avatarUrl) {
      wx.showToast({ title: '可先填一项，或点跳过', icon: 'none' });
      return;
    }
    if (phone && !/^1\d{10}$/.test(phone) && !/^\+?\d{6,20}$/.test(phone)) {
      wx.showToast({ title: '手机号格式不太对', icon: 'none' });
      return;
    }
    this.setData({ profileSaving: true });
    try {
      const saved = await saveProfileWithAvatarUpload({
        nickname: nickname || undefined,
        phone: phone || undefined,
        avatarUrl: avatarUrl || undefined,
        uploadAvatarIfTemp: true,
      });
      markProfilePrompted();
      markContactPrompted();
      const nextNick = (saved && saved.nickname) || nickname;
      const nextPhone = (saved && saved.phone) || phone;
      const nextAvatar = (saved && saved.avatarUrl) || avatarUrl;
      this.setData({
        showProfileSheet: false,
        profileSaving: false,
        profileName: nextNick,
        profilePhone: nextPhone,
        profileAvatarUrl: nextAvatar,
        profileDraftNick: nextNick,
        profileDraftPhone: nextPhone,
        contactName: nextNick,
        contactPhone: nextPhone,
      });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      this.setData({ profileSaving: false });
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    }
  },
  dismissSoftTip() {
    markContactPrompted();
    this.setData({ showSoftTip: false });
  },
  async openInquirySheet() {
    // 每次打开尽量用最新档案预填
    try {
      const me = await request({ url: '/api/auth/me' });
      const phone = (me && me.phone) || this.data.profilePhone || '';
      const name = (me && me.nickname) || this.data.profileName || '';
      this.setData({
        contactPhone: phone,
        contactName: name,
        contactRemark: '',
        showInquirySheet: true,
        showProfileSheet: false,
        showSoftTip: false,
        profilePhone: phone,
        profileName: name,
      });
    } catch (e) {
      this.setData({
        showInquirySheet: true,
        showProfileSheet: false,
        showSoftTip: false,
        contactPhone: this.data.profilePhone || '',
        contactName: this.data.profileName || '',
        contactRemark: '',
      });
    }
  },
  closeInquirySheet() {
    this.setData({ showInquirySheet: false });
  },
  onContactPhone(e) {
    this.setData({ contactPhone: e.detail.value });
  },
  onContactName(e) {
    this.setData({ contactName: e.detail.value });
  },
  onContactRemark(e) {
    this.setData({ contactRemark: e.detail.value });
  },
  noop() {},
  async submitInquiry() {
    const phone = (this.data.contactPhone || '').trim();
    const name = (this.data.contactName || '').trim();
    const remark = (this.data.contactRemark || '').trim();
    const productId = this.data.id || (this.data.product && this.data.product.id);
    if (!productId) {
      wx.showToast({ title: '缺少商品', icon: 'none' });
      return;
    }
    if (!phone && !name) {
      wx.showToast({ title: '请填手机或姓名', icon: 'none' });
      return;
    }
    if (phone && !/^1\d{10}$/.test(phone) && !/^\+?\d{6,20}$/.test(phone)) {
      wx.showToast({ title: '手机号格式不太对', icon: 'none' });
      return;
    }
    if (this._submittingInquiry) return;
    this._submittingInquiry = true;
    try {
      await request({
        url: '/api/inquiries',
        method: 'POST',
        data: {
          productId,
          phone: phone || undefined,
          name: name || undefined,
          remark: remark || undefined,
        },
      });
      markContactPrompted();
      this.setData({
        showInquirySheet: false,
        profilePhone: phone || this.data.profilePhone,
        profileName: name || this.data.profileName,
      });
      wx.showToast({ title: '已提交询价', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' });
    } finally {
      this._submittingInquiry = false;
    }
  },

  goCatalog() {
    const groupId = this.data.groupId || (this.data.product && this.data.product.groupId) || '';
    if (!groupId) {
      wx.showToast({ title: '暂无分组目录', icon: 'none' });
      return;
    }
    const qs = [`groupId=${encodeURIComponent(groupId)}`];
    if (this.data.shareEventId) qs.push(`shareEventId=${this.data.shareEventId}`);
    if (this.data.boundCustomerId) qs.push(`boundCustomerId=${this.data.boundCustomerId}`);
    wx.navigateTo({ url: `/pages/product/catalog/catalog?${qs.join('&')}` });
  },
});
