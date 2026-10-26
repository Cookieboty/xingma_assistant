/**
 * 保存网络图到系统相册（兼容 iOS 相册权限引导）
 * 流程：检查/申请 scope.writePhotosAlbum → downloadFile → saveImageToPhotosAlbum
 */

const OSS_HINT_DOMAIN = 'chathub.oss-cn-hangzhou.aliyuncs.com';

function ensureAlbumAuth() {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success(res) {
        const auth = res.authSetting['scope.writePhotosAlbum'];
        if (auth === true) {
          resolve(true);
          return;
        }
        if (auth === false) {
          // 曾拒绝：只能引导去设置页（iOS 不会再弹系统授权）
          wx.showModal({
            title: '需要相册权限',
            content: '保存图片需要「添加到相册」权限，请在设置中开启后重试',
            confirmText: '去设置',
            cancelText: '取消',
            success(m) {
              if (!m.confirm) {
                reject(new Error('未开启相册权限'));
                return;
              }
              wx.openSetting({
                success(s) {
                  if (s.authSetting && s.authSetting['scope.writePhotosAlbum']) resolve(true);
                  else reject(new Error('未开启相册权限'));
                },
                fail() { reject(new Error('打开设置失败')); },
              });
            },
          });
          return;
        }
        // 首次：拉起系统授权
        wx.authorize({
          scope: 'scope.writePhotosAlbum',
          success() { resolve(true); },
          fail() {
            wx.showModal({
              title: '需要相册权限',
              content: '保存图片需要「添加到相册」权限，请在设置中开启',
              confirmText: '去设置',
              cancelText: '取消',
              success(m) {
                if (!m.confirm) {
                  reject(new Error('未开启相册权限'));
                  return;
                }
                wx.openSetting({
                  success(s) {
                    if (s.authSetting && s.authSetting['scope.writePhotosAlbum']) resolve(true);
                    else reject(new Error('未开启相册权限'));
                  },
                  fail() { reject(new Error('打开设置失败')); },
                });
              },
            });
          },
        });
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '读取权限失败'));
      },
    });
  });
}

function isLocalPath(url) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return true;
  return /^(wxfile:\/\/|file:\/\/)/i.test(url);
}

function formatDownloadErr(err, url) {
  const msg = (err && (err.errMsg || err.message)) || '下载失败';
  const lower = String(msg).toLowerCase();
  const looksDomain =
    /domain|合法域名|not in domain|url not in domain list|invalid url/i.test(msg) ||
    (url && /oss-cn-hangzhou\.aliyuncs\.com/i.test(url));
  if (looksDomain || /fail/.test(lower)) {
    if (/domain|合法域名|not in domain/i.test(msg) || (url && /aliyuncs\.com/i.test(url))) {
      return `下载失败：请将 downloadFile 合法域名配置为 ${OSS_HINT_DOMAIN} 与业务域名 xingma.visitworld.me（外部视频走 /api/media/external-play 同域中转）`;
    }
  }
  return msg.length > 80 ? msg.slice(0, 80) : msg;
}

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('无图片地址'));
      return;
    }
    if (isLocalPath(url)) {
      resolve(url);
      return;
    }
    wx.downloadFile({
      url,
      success(r) {
        if (r.statusCode === 200 && r.tempFilePath) {
          resolve(r.tempFilePath);
        } else {
          reject(new Error(formatDownloadErr({ errMsg: `下载失败(${r.statusCode})` }, url)));
        }
      },
      fail(err) {
        reject(new Error(formatDownloadErr(err, url)));
      },
    });
  });
}

function saveTempToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success() { resolve(); },
      fail(err) {
        const msg = (err && err.errMsg) || '保存失败';
        if (/auth deny|authorize|permission|deny/i.test(msg)) {
          reject(new Error('相册权限被拒绝'));
        } else {
          reject(new Error(msg.length > 80 ? msg.slice(0, 80) : msg));
        }
      },
    });
  });
}

/**
 * 依次将 urls 保存到相册。
 * @param {string[]} urls
 * @param {{ onProgress?: (cur:number, total:number) => void }} [opts]
 * @returns {Promise<{ ok:number, fail:number, errors:string[] }>}
 */
async function saveUrlsToAlbum(urls, opts) {
  const list = (urls || []).filter(Boolean);
  if (!list.length) {
    return { ok: 0, fail: 0, errors: ['未选择图片'] };
  }
  await ensureAlbumAuth();
  let ok = 0;
  let fail = 0;
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    if (opts && typeof opts.onProgress === 'function') {
      try { opts.onProgress(i + 1, list.length); } catch (e) { /* ignore */ }
    }
    try {
      const path = await downloadToTemp(list[i]);
      await saveTempToAlbum(path);
      ok += 1;
    } catch (e) {
      fail += 1;
      const m = (e && e.message) || String(e);
      errors.push(m);
      if (/相册权限/.test(m)) break;
    }
  }
  return { ok, fail, errors };
}

function saveTempVideoToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    wx.saveVideoToPhotosAlbum({
      filePath,
      success() { resolve(); },
      fail(err) {
        const msg = (err && err.errMsg) || '保存失败';
        if (/auth deny|authorize|permission|deny/i.test(msg)) {
          reject(new Error('相册权限被拒绝'));
        } else {
          reject(new Error(msg.length > 80 ? msg.slice(0, 80) : msg));
        }
      },
    });
  });
}

/** 依次将视频 urls 保存到相册 */
async function saveVideoUrlsToAlbum(urls, opts) {
  const list = (urls || []).filter(Boolean);
  if (!list.length) {
    return { ok: 0, fail: 0, errors: ['未选择视频'] };
  }
  await ensureAlbumAuth();
  let ok = 0;
  let fail = 0;
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    if (opts && typeof opts.onProgress === 'function') {
      try { opts.onProgress(i + 1, list.length); } catch (e) { /* ignore */ }
    }
    try {
      const path = await downloadToTemp(list[i]);
      await saveTempVideoToAlbum(path);
      ok += 1;
    } catch (e) {
      fail += 1;
      const m = (e && e.message) || String(e);
      errors.push(m);
      if (/相册权限/.test(m)) break;
    }
  }
  return { ok, fail, errors };
}

module.exports = {
  OSS_HINT_DOMAIN,
  ensureAlbumAuth,
  downloadToTemp,
  saveTempToAlbum,
  saveTempVideoToAlbum,
  saveUrlsToAlbum,
  saveVideoUrlsToAlbum,
};
