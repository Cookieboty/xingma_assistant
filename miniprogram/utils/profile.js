const { request } = require('./request');

/** 客户：昵称+头像授权（不阻断看货）；员工也可补昵称 */
function maybeCollectProfile() {
  const app = getApp();
  const role = app.globalData.role || '';
  if (role !== 'customer' && role !== 'owner' && role !== 'staff') return Promise.resolve();
  if (wx.getStorageSync('profile_prompted_v1')) return Promise.resolve();
  return request({ url: '/api/auth/me' })
    .then((me) => {
      if (me && me.nickname && (role !== 'customer' || me.avatarUrl)) {
        wx.setStorageSync('profile_prompted_v1', '1');
        return;
      }
      return new Promise((resolve) => {
        wx.showModal({
          title: '完善资料',
          content: '授权昵称和头像，方便档口认出你（可跳过）',
          confirmText: '去授权',
          cancelText: '跳过',
          success: (r) => {
            wx.setStorageSync('profile_prompted_v1', '1');
            if (!r.confirm) {
              resolve();
              return;
            }
            wx.navigateTo({
              url: '/pages/settings/index/index?profile=1',
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

function saveProfile({ nickname, avatarUrl }) {
  const data = {};
  if (nickname != null) data.nickname = nickname;
  if (avatarUrl != null) data.avatarUrl = avatarUrl;
  return request({ url: '/api/auth/me', method: 'PATCH', data });
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

module.exports = { maybeCollectProfile, saveProfile, requestJobSubscribe };
