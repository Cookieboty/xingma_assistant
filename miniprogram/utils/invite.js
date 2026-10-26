/** 员工邀请码：分享进线 / 首页回落时保活，避免点「房子」丢 code 被当成客户 */

var STORAGE_KEY = 'pendingInviteCode';

function parseScene(scene) {
  if (!scene) return '';
  var s = String(scene);
  try {
    s = decodeURIComponent(s);
  } catch (e) { /* */ }
  var m = s.match(/(?:^|[&?])c=([A-Za-z0-9]+)/i);
  if (m) return String(m[1] || '').toUpperCase();
  // 纯码（小程序码 scene 有时直接是 CODE）
  if (/^[A-Za-z0-9]{4,16}$/.test(s)) return s.toUpperCase();
  return '';
}

function normalizeCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);
}

/** 从启动/分享 query 或 scene 抠邀请码 */
function extractInviteCode(query) {
  var q = query || {};
  var fromQ = normalizeCode(q.invite || q.code || q.c || '');
  if (fromQ) return fromQ;
  if (q.scene) return normalizeCode(parseScene(q.scene));
  return '';
}

function savePendingInviteCode(code) {
  var c = normalizeCode(code);
  if (!c) return '';
  try {
    wx.setStorageSync(STORAGE_KEY, c);
  } catch (e) { /* */ }
  try {
    var app = getApp();
    if (app && app.globalData) app.globalData.pendingInviteCode = c;
  } catch (e2) { /* */ }
  return c;
}

function readPendingInviteCode() {
  try {
    var app = getApp();
    if (app && app.globalData && app.globalData.pendingInviteCode) {
      return normalizeCode(app.globalData.pendingInviteCode);
    }
  } catch (e) { /* */ }
  try {
    return normalizeCode(wx.getStorageSync(STORAGE_KEY) || '');
  } catch (e2) {
    return '';
  }
}

function clearPendingInviteCode() {
  try {
    wx.removeStorageSync(STORAGE_KEY);
  } catch (e) { /* */ }
  try {
    var app = getApp();
    if (app && app.globalData) app.globalData.pendingInviteCode = '';
  } catch (e2) { /* */ }
}

/**
 * App onLaunch/onShow：捕获分享/扫码带来的邀请码。
 * 若本次 path 已是 invite/accept，只存码；若落在首页等其它页，由 index 再跳转。
 */
function captureLaunchInvite(options) {
  var opts = options || {};
  var q = opts.query || {};
  var code = extractInviteCode(q);
  if (!code && opts.scene) {
    // 扫普通链接/小程序码：scene 可能在顶层
    code = normalizeCode(parseScene(opts.scene));
  }
  // path 形如 pages/invite/accept/accept
  var path = String(opts.path || opts.page || '');
  if (!code && path.indexOf('invite/accept') >= 0) {
    code = extractInviteCode(q);
  }
  if (code) savePendingInviteCode(code);
  return code;
}

module.exports = {
  parseScene: parseScene,
  normalizeCode: normalizeCode,
  extractInviteCode: extractInviteCode,
  savePendingInviteCode: savePendingInviteCode,
  readPendingInviteCode: readPendingInviteCode,
  clearPendingInviteCode: clearPendingInviteCode,
  captureLaunchInvite: captureLaunchInvite,
};
