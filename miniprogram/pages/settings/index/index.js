const { request } = require('../../../utils/request');
const { saveProfileWithAvatarUpload, isTempAvatarPath } = require('../../../utils/profile');

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
    isOwner: false,
    canInvite: false,
    myMemberId: '',
    invites: [],
    members: [],
    latestInvite: null,
  },
  _nickSaveTimer: null,
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
      // 前端不展示 openid；统一显示为员工（平权）
      const members = (Array.isArray(rawMembers) ? rawMembers : []).map((m) => ({
        id: m.id,
        nickname: m.nickname || '',
        status: m.status,
        role: 'staff',
      }));
      const invites = canInvite ? (results[3] || []) : [];
      const nickname = (me && me.nickname) || '';
      const avatarUrl = (me && me.avatarUrl) || '';
      const phone = (me && me.phone) || '';
      const needProfileGuide = !nickname || !avatarUrl;
      this.setData({
        isOwner,
        canInvite,
        myMemberId: (me && me.memberId) || '',
        nickname,
        avatarUrl,
        phone,
        needProfileGuide,
        contactQrUrl: (tenant && tenant.contactQrUrl) || '',
        members,
        invites,
      });
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
    if (!nickname) return;
    this.setData({ nickname });
    this.scheduleNicknameSave(nickname);
  },
  onNicknameReview(e) {
    const pass = !!(e.detail && e.detail.pass);
    if (!pass) {
      wx.showToast({ title: '昵称未通过校验', icon: 'none' });
      return;
    }
    const nickname = (this.data.nickname || '').trim();
    if (nickname) this.scheduleNicknameSave(nickname);
  },
  scheduleNicknameSave(nickname) {
    if (this._nickSaveTimer) clearTimeout(this._nickSaveTimer);
    this._nickSaveTimer = setTimeout(() => {
      this._nickSaveTimer = null;
      this.persistProfile({ nickname });
    }, 120);
  },
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
  /** 选完微信头像/昵称后自动上传并 PATCH；昵称不附带临时头像，避免上传失败拖垮保存 */
  async persistProfile(partial) {
    if (this._profileSaveChain) {
      try { await this._profileSaveChain; } catch (e) { /* 串行下一次 */ }
    }
    const run = this._doPersistProfile(partial);
    this._profileSaveChain = run.finally(() => {
      if (this._profileSaveChain === run) this._profileSaveChain = null;
    });
    return run;
  },
  async _doPersistProfile(partial) {
    const nickname = partial.nickname != null
      ? String(partial.nickname).trim()
      : undefined;
    let avatarUrl = partial.avatarUrl != null
      ? partial.avatarUrl
      : undefined;
    // 只改昵称：绝不带上页面里可能残留的 wxfile 临时头像
    const uploadAvatarIfTemp = partial.avatarUrl != null;
    if (!uploadAvatarIfTemp) {
      avatarUrl = undefined;
    }
    if (!(nickname || avatarUrl)) return;
    this.setData({ profileSaving: true });
    try {
      const saved = await saveProfileWithAvatarUpload({
        nickname: nickname || undefined,
        avatarUrl: avatarUrl || undefined,
        uploadAvatarIfTemp,
      });
      const patch = {};
      if (saved.avatarUrl) patch.avatarUrl = saved.avatarUrl;
      if (saved.nickname != null) patch.nickname = saved.nickname;
      if (saved.phone != null) patch.phone = saved.phone;
      const nextNick = patch.nickname != null ? patch.nickname : (this.data.nickname || '');
      const nextAvatar = patch.avatarUrl != null ? patch.avatarUrl : (this.data.avatarUrl || '');
      // 若页面仍挂着临时头像且本次未更新头像，清掉以免下次误上传
      if (!saved.avatarUrl && isTempAvatarPath(this.data.avatarUrl)) {
        patch.avatarUrl = '';
      }
      patch.needProfileGuide = !nextNick || !nextAvatar || isTempAvatarPath(nextAvatar);
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
        try {
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
  async createInvite() {
    wx.showLoading({ title: '生成中', mask: true });
    try {
      const inv = await request({
        url: '/api/invites',
        method: 'POST',
        data: { role: 'staff', maxUses: 3, expiresInDays: 7 },
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
  kickMember(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || '该员工';
    if (!id) return;
    wx.showModal({
      title: '踢除员工',
      content: `确定踢除「${name}」？踢后不能再以员工身份进入档口。`,
      confirmText: '踢除',
      confirmColor: '#ef4444',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await request({ url: `/api/invites/members/${id}/disable`, method: 'POST' });
          this.load();
          wx.showToast({ title: '已踢除', icon: 'none' });
        } catch (err) {
          wx.showToast({ title: (err && err.message) || '踢除失败', icon: 'none' });
        }
      },
    });
  },
});
