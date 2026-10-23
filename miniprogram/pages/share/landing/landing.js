/**
 * 分享落地页（客户无感）：
 * 1. 携带 shareId
 * 2. 后台静默 wx.login → 换 JWT（客户看不到登录 UI）
 * 3. GET /api/shares/:shareId/open —— 限制分享占名额 / 公开放行；openid 自动写入 customer_profiles
 * 4. 立刻 redirect 到【客户专用】商品页 pages/product/view（非员工 detail）
 */
const { request, ensureSilentSession } = require('../../../utils/request');

Page({
  data: {
    loading: true,
    error: '',
    shareId: '',
  },
  onLoad(q) {
    const shareId = q.shareId || q.scene || '';
    this.setData({ shareId });
    this.openShare(shareId);
  },
  async openShare(shareId) {
    if (!shareId) {
      this.setData({ loading: false, error: '缺少分享参数，请通过分享卡片打开' });
      return;
    }
    try {
      // 静默鉴权：有 token 复用；否则 wx.login / 开发态假登录，无任何登录页
      await ensureSilentSession({ preferRole: 'customer', forceCustomer: true });
      const res = await request({ url: `/api/shares/${shareId}/open` });
      const product = res.product;
      if (!product || !product.id) {
        this.setData({ loading: false, error: '分享有效但未返回商品' });
        return;
      }
      const bound =
        (res.share && res.share.boundCustomerId) || res.customerId || '';
      const qs = [
        `id=${product.id}`,
        `shareEventId=${shareId}`,
      ];
      if (bound) qs.push(`boundCustomerId=${bound}`);
      // 必须进客户专用页，避免员工会话打开同一 detail 露出管理控件
      wx.redirectTo({
        url: `/pages/product/view/view?${qs.join('&')}`,
      });
    } catch (e) {
      this.setData({ loading: false, error: e.message || '无法打开分享' });
    }
  },
});
