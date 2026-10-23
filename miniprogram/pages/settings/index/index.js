const { request } = require('../../../utils/request');
const { saveProfileWithAvatarUpload } = require('../../../utils/profile');

Page({
  data: {
    showProfile: true,
    nickname: '',
    avatarUrl: '',
    phone: '',
    phoneBinding: false,
    needProfileGuide: false,
    profileSaving: false,
    contactQrUrl: '',
    allowCustomerDownload: false,
    isOwner: false,
    canInvite: false,
    invites: [],
    members: [],
    latestInvite: null,
  },
  onLoad(q) {
    if (q && q.profile === '1') this.setData({ showProfile: true });
  },
  onShow() {
    this.load();
  },
  async load() {
    try {
      const app = getApp();
      const role = (app.globalData && app.globalData.role) || wx.getStorageSync('role') || '';
      const isOwner = role === 'owner';
      const canInvite = role === 'owner' || role === 'staff';
      const tasks = [
        request({ url: '/api/auth/me' }).catch(() => null),
        request({ url: '/api/tenants/current' }).catch(() => null),
        request({ url: '/api/invites/members' }).catch(() => []),
      ];
      if (canInvite) tasks.push(request({ url: '/api/invites' }).catch(() => []));
      const results = await Promise.all(tasks);
      const me = results[0];
      const tenant = results[1];
      const rawMembers = results[2] || [];
      // 前端不展示 openid；统一显示为员工
      const members = (Array.isArray(rawMembers) ? rawMembers : []).map((m) => ({
        id: m.id,
        nickname: m.nickname || '',
        status: m.status,
      }));
      const invites = canInvite ? (results[3] || []) : [];
      const nickname = (me && me.nickname) || '';
      const avatarUrl = (me && me.avatarUrl) || '';
      const phone = (me && me.phone) || '';
      const needProfileGuide = !nickname || !avatarUrl;
      this.setData({
        isOwner,
        canInvite,
        nickname,
        avatarUrl,
        phone,
        needProfileGuide,
        contactQrUrl: (tenant && tenant.contactQrUrl) || '',
        allowCustomerDownload: !!(tenant && tenant.allowCustomerDownload),
        members,
        invites,
      });
      if (needProfileGuide && !this._profileGuideToasted) {
        this._profileGuideToasted = true;
        wx.showToast({ title: '请点选微信头像与昵称', icon: 'none', duration: 2500 });
      }
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },
  onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl;
    if (!url) return;
    this.setData({ avatarUrl: url });
    this.persistProfile({ avatarUrl: url });
  },
  onNickname(e) {
    const nickname = ((e.detail && e.detail.value) || '').trim();
    this.setData({ nickname });
    if (nickname) this.persistProfile({ nickname });
  },
  /** 微信手机号快速验证：code 交后端换号并写资料 */
  async onGetPhoneNumber(e) {
    const detail = (e && e.detail) || {};
    if (detail.errno === 1400001) {
      wx.showToast({ title: '手机号额度不足', icon: 'none' });
      return;
    }
    if (!detail.code) {
      const denied = (detail.errMsg || '').indexOf('deny') >= 0 || (detail.errMsg || '').indexOf('auth deny') >= 0;
      wx.showToast({ title: denied ? '已取消授权' : '无法获取微信手机号', icon: 'none' });
      return;
    }
    this.setData({ phoneBinding: true });
    try {
      const me = await request({
        url: '/api/auth/me/phone',
        method: 'POST',
        data: { code: detail.code },
      });
      const phone = (me && me.phone) || '';
      if (phone) this.setData({ phone });
      wx.showToast({ title: phone ? '手机号已绑定' : '已处理', icon: 'success' });
    } catch (err) {
      wx.showToast({
        title: (err && err.message) || '微信手机号不可用',
        icon: 'none',
      });
    } finally {
      this.setData({ phoneBinding: false });
    }
  },
  /** 选完微信头像/昵称后自动上传并 PATCH；返回值刷新展示 */
  async persistProfile(partial) {
    if (this.data.profileSaving) return;
    const nickname = partial.nickname != null
      ? String(partial.nickname).trim()
      : (this.data.nickname || '').trim();
    const avatarUrl = partial.avatarUrl != null
      ? partial.avatarUrl
      : (this.data.avatarUrl || '');
    if (!nickname && !avatarUrl) return;
    this.setData({ profileSaving: true });
    try {
      const { avatarUrl: persisted, nickname: nick, phone: ph } = await saveProfileWithAvatarUpload({
        nickname: nickname || undefined,
        avatarUrl: avatarUrl || undefined,
      });
      const patch = { needProfileGuide: false };
      if (persisted) patch.avatarUrl = persisted;
      if (nick != null) patch.nickname = nick;
      if (ph != null) patch.phone = ph;
      const nextNick = patch.nickname != null ? patch.nickname : nickname;
      const nextAvatar = patch.avatarUrl != null ? patch.avatarUrl : avatarUrl;
      patch.needProfileGuide = !nextNick || !nextAvatar;
      this.setData(patch);
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
    } finally {
      this.setData({ profileSaving: false });
    }
  },
  pickContactQr() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: async (res) => {
        const path = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath;
        if (!path) return;
        // 本地临时路径先直接回写（生产可改为上传 media）；小程序可展示本地/https
        try {
          // 若已有上传接口则优先；否则用本地路径仅开发可见——改为上传到商品无关的 media
          const app = getApp();
          const baseUrl = (app.globalData && app.globalData.baseUrl) || '';
          const token = app.globalData.token || wx.getStorageSync('token') || '';
          const upload = await new Promise((resolve, reject) => {
            wx.uploadFile({
              url: baseUrl + '/api/media/upload',
              filePath: path,
              name: 'file',
              header: { Authorization: token ? `Bearer ${token}` : '' },
              formData: { purpose: 'contact_qr' },
              success: (r) => {
                try {
                  const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
                  if (r.statusCode >= 200 && r.statusCode < 300) resolve(data);
                  else reject(new Error((data && data.message) || '上传失败'));
                } catch (e) { reject(e); }
              },
              fail: reject,
            });
          });
          const url = upload.url || upload.publicUrl || upload.avatarUrl || path;
          await request({
            url: '/api/tenants/current/contact-qr',
            method: 'PATCH',
            data: { url },
          });
          this.setData({ contactQrUrl: url });
          wx.showToast({ title: '二维码已更新', icon: 'none' });
        } catch (e) {
          // 无上传接口时：直接存临时路径不可跨端，提示
          wx.showToast({ title: (e && e.message) || '请配置媒体上传', icon: 'none' });
        }
      },
    });
  },
  async clearContactQr() {
    try {
      await request({ url: '/api/tenants/current/contact-qr', method: 'PATCH', data: { url: null } });
      this.setData({ contactQrUrl: '' });
      wx.showToast({ title: '已清除', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message || '失败', icon: 'none' });
    }
  },
  async onAllowDownloadTap(e) {
    const v = e.currentTarget.dataset.v;
    const allow = v === '1' || v === 1;
    try {
      await request({
        url: '/api/tenants/current/allow-customer-download',
        method: 'PATCH',
        data: { allowCustomerDownload: allow },
      });
      this.setData({ allowCustomerDownload: allow });
      wx.showToast({ title: allow ? '已允许客户存图' : '已禁止客户存图', icon: 'none' });
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    }
  },
  async createInvite() {
    wx.showLoading({ title: '生成中', mask: true });
    try {
      const inv = await request({
        url: '/api/invites',
        method: 'POST',
        data: { role: 'staff', maxUses: 1, expiresInDays: 7 },
      });
      wx.hideLoading();
      this.setData({ latestInvite: inv });
      this.load();
      wx.showToast({ title: '已生成', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: (e && e.message) || '失败', icon: 'none' });
    }
  },
  copyInviteCode(e) {
    const code = (e.currentTarget.dataset && e.currentTarget.dataset.code) || (this.data.latestInvite && this.data.latestInvite.code);
    if (!code) return;
    wx.setClipboardData({
      data: String(code),
      success: () => wx.showToast({ title: '已复制邀请码', icon: 'none' }),
    });
  },
  async revokeInvite(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    try {
      await request({ url: `/api/invites/${id}/revoke`, method: 'POST' });
      if (this.data.latestInvite && this.data.latestInvite.id === id) {
        this.setData({ latestInvite: null });
      }
      this.load();
      wx.showToast({ title: '已撤销', icon: 'none' });
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '失败', icon: 'none' });
    }
  },

});
