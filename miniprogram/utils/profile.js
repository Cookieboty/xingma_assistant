const { request } = require('./request');

const CONTACT_PROMPTED_KEY = 'contact_prompted_v1';
const PROFILE_PROMPTED_KEY = 'profile_complete_prompted_v1';

/** 剥掉 OSS 签名 query，避免公网读切换后头像/二维码 403 空白 */
function stableMediaUrl(url) {
  if (url == null) return '';
  const raw = String(url).trim();
  if (!raw) return '';
  if (
    /^wxfile:/i.test(raw) ||
    /^file:/i.test(raw) ||
    /^http:\/\/(tmp|usr)\//i.test(raw) ||
    /^\/(tmp|usr)\//i.test(raw)
  ) {
    return '';
  }
  if (/[?&](OSSAccessKeyId|Signature|Expires|security-token|x-oss-signature)=/i.test(raw)) {
    const q = raw.indexOf('?');
    return q >= 0 ? raw.slice(0, q) : raw;
  }
  return raw;
}

function currentRoute() {
  try {
    const pages = getCurrentPages();
    const cur = pages && pages.length ? pages[pages.length - 1] : null;
    return (cur && (cur.route || (cur.$page && cur.$page.fullPath))) || '';
  } catch (e) {
    return '';
  }
}

/** 是否已有可供客服联系的方式：手机 或 姓名/昵称 */
function hasContactInfo(me) {
  if (!me) return false;
  const phone = String(me.phone || '').trim();
  const name = String(me.nickname || '').trim();
  return !!(phone || name);
}


/** 头像+昵称+手机是否都齐（完善资料软提示用） */
function isProfileComplete(me) {
  if (!me) return false;
  const phone = String(me.phone || '').trim();
  const name = String(me.nickname || '').trim();
  const avatar = String(me.avatarUrl || '').trim();
  return !!(phone && name && avatar);
}

function isProfilePrompted() {
  try {
    return !!wx.getStorageSync(PROFILE_PROMPTED_KEY);
  } catch (e) {
    return false;
  }
}

function markProfilePrompted() {
  try {
    wx.setStorageSync(PROFILE_PROMPTED_KEY, '1');
  } catch (e) { /* ignore */ }
}

function isContactPrompted() {
  try {
    return !!wx.getStorageSync(CONTACT_PROMPTED_KEY);
  } catch (e) {
    return false;
  }
}

function markContactPrompted() {
  try {
    wx.setStorageSync(CONTACT_PROMPTED_KEY, '1');
  } catch (e) { /* ignore */ }
}

/** 微信 chooseAvatar 本地临时路径 */
function isTempAvatarPath(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  if (/^https?:\/\//i.test(u) && !/\/\/tmp\//i.test(u)) return false;
  return (
    /^wxfile:\/\//i.test(u) ||
    /^file:\/\//i.test(u) ||
    /^http:\/\/(tmp|usr)\//i.test(u) ||
    /^\/(tmp|usr)\//i.test(u) ||
    !/^https?:\/\//i.test(u)
  );
}

function uploadAvatar(filePath) {
  const app = getApp();
  const baseUrl = (app.globalData && app.globalData.baseUrl) || '';
  const token = app.globalData.token || wx.getStorageSync('token') || '';
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: baseUrl + '/api/media/upload',
      filePath,
      name: 'file',
      header: { Authorization: token ? `Bearer ${token}` : '' },
      formData: { purpose: 'avatar' },
      success: (r) => {
        try {
          const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
          if (r.statusCode >= 200 && r.statusCode < 300) {
            const url = stableMediaUrl((data && (data.url || data.publicUrl || data.avatarUrl)) || '')
              || ((data && (data.url || data.publicUrl || data.avatarUrl)) || '');
            if (!url) reject(new Error('上传未返回地址'));
            else resolve(url);
          } else {
            reject(new Error((data && data.message) || '头像上传失败'));
          }
        } catch (e) {
          reject(e);
        }
      },
      fail: (err) => reject(new Error((err && err.errMsg) || '头像上传失败')),
    });
  });
}

/**
 * 客户分享落地 / 商品页：不弹「去设置」；联系方式由 view 页选填弹层处理。
 * 其它页：若缺资料仅可选引导设置（自愿），不强调手填头像昵称。
 */
function maybeCollectProfile(opts) {
  const app = getApp();
  const role = app.globalData.role || '';
  if (role !== 'customer' && role !== 'owner' && role !== 'staff') return Promise.resolve();
  if (wx.getStorageSync('profile_prompted_v1')) return Promise.resolve();
  const route = currentRoute();
  const onCustomerShareUi =
    /pages\/product\/view|pages\/share\/landing/.test(route) ||
    (opts && opts.allowNavigate === false);
  if (onCustomerShareUi) return Promise.resolve();
  return request({ url: '/api/auth/me' })
    .then((me) => {
      if (me && (hasContactInfo(me) || (me.nickname && (role !== 'customer' || me.avatarUrl)))) {
        wx.setStorageSync('profile_prompted_v1', '1');
        return;
      }
      // 员工自愿完善；客户主路径已在 view 弹联系方式，此处不再强推
      if (role === 'customer') {
        wx.setStorageSync('profile_prompted_v1', '1');
        return;
      }
      return new Promise((resolve) => {
        wx.showModal({
          title: '完善资料',
          content: '可自愿完善昵称（方便档口认出你），可跳过',
          confirmText: '去设置',
          cancelText: '跳过',
          success: (r) => {
            wx.setStorageSync('profile_prompted_v1', '1');
            if (!r.confirm) {
              resolve();
              return;
            }
            wx.switchTab({
              url: '/pages/settings/index/index',
              complete: () => resolve(),
              fail: () => resolve(),
            });
          },
          fail: () => resolve(),
        });
      });
    })
    .catch(() => {});
}

function saveProfile({ nickname, avatarUrl, phone }) {
  const data = {};
  if (nickname != null) data.nickname = nickname;
  if (avatarUrl != null) data.avatarUrl = avatarUrl;
  if (phone != null) data.phone = phone;
  return request({ url: '/api/auth/me', method: 'PATCH', data });
}

/**
 * 头像若为本地临时路径则先上传再 PATCH。
 * 只改昵称/手机时不要传入临时头像路径，否则上传失败会拖垮整次保存。
 * 稳定 https 头像可一并回写；非 https 临时路径在未显式要求上传时忽略。
 */
function saveProfileWithAvatarUpload({ nickname, avatarUrl, phone, uploadAvatarIfTemp }) {
  const nick = nickname != null ? String(nickname).trim() : undefined;
  const ph = phone != null ? String(phone).trim() : undefined;
  const wantUpload = uploadAvatarIfTemp !== false;
  let avatar = avatarUrl;
  const shouldUpload = wantUpload && isTempAvatarPath(avatar);
  const chain = shouldUpload
    ? uploadAvatar(avatar).then((url) => {
        avatar = url;
        return url;
      })
    : Promise.resolve(avatar);
  return chain.then(() => {
    // 未上传成功的临时路径绝不写入后端
    let stableAvatar = avatar;
    if (stableAvatar != null && isTempAvatarPath(stableAvatar)) {
      stableAvatar = undefined;
    }
    return saveProfile({
      nickname: nick !== undefined ? nick : undefined,
      avatarUrl: stableAvatar != null ? stableAvatar : undefined,
      phone: ph !== undefined ? ph : undefined,
    }).then((me) => ({
      me,
      avatarUrl: stableAvatar != null ? stableAvatar : (me && me.avatarUrl) || null,
      nickname: nick !== undefined ? nick : (me && me.nickname) || null,
      phone: ph !== undefined ? ph : (me && me.phone) || null,
    }));
  });
}

/** 任务完成订阅：模板 ID 由后端/小程序后台配置；未配置则静默跳过 */
function requestJobSubscribe() {
  const tmplIds = [];
  try {
    const app = getApp();
    const fromApp = (app.globalData && app.globalData.subscribeTmplIds) || [];
    if (Array.isArray(fromApp)) tmplIds.push(...fromApp);
  } catch (e) { /* ignore */ }
  const cached = wx.getStorageSync('subscribe_tmpl_job') || '';
  if (cached) tmplIds.push(cached);
  const ids = [...new Set(tmplIds.filter(Boolean))].slice(0, 3);
  if (!ids.length) return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: (res) => resolve(res),
      fail: (err) => resolve({ err }),
    });
  });
}

module.exports = {
  maybeCollectProfile,
  saveProfile,
  saveProfileWithAvatarUpload,
  uploadAvatar,
  isTempAvatarPath,
  stableMediaUrl,
  hasContactInfo,
  isContactPrompted,
  markContactPrompted,
  CONTACT_PROMPTED_KEY,
  isProfileComplete,
  isProfilePrompted,
  markProfilePrompted,
  PROFILE_PROMPTED_KEY,
  requestJobSubscribe,
};
