/** 客户端直传阿里云 OSS（PostObject）或回退服务端中转 */

const { request } = require('./request');

function guessMime(filePath) {
  const p = String(filePath || '').toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

/**
 * 申请一批直传凭证
 * @returns {Promise<{mode:'post'|'proxy', batchId:string, items:Array}>}
 */
function fetchCredentials({ count, purpose, batchId, mimeType, productId }) {
  return request({
    url: '/api/media/upload-credentials',
    method: 'POST',
    data: {
      count: count || 1,
      purpose: purpose || 'uploads',
      batchId: batchId || undefined,
      mimeType: mimeType || 'image/jpeg',
      productId: productId || undefined,
    },
  });
}

/**
 * PostObject 直传到 OSS host
 * @param {object} cred createPostUploadCredential 返回项
 * @param {string} filePath 本地临时路径
 */
function uploadFileToOss(cred, filePath) {
  return new Promise((resolve, reject) => {
    if (!cred || !cred.host || !cred.key) {
      reject(new Error('缺少 OSS 凭证'));
      return;
    }
    const mime = guessMime(filePath);
    wx.uploadFile({
      url: cred.host,
      filePath,
      name: 'file',
      formData: {
        key: cred.key,
        policy: cred.policy,
        OSSAccessKeyId: cred.accessKeyId,
        Signature: cred.signature,
        success_action_status: String(cred.successActionStatus || '200'),
        'x-oss-object-acl': cred.acl || 'private',
        'Content-Type': mime,
      },
      success: (res) => {
        const code = res.statusCode || 0;
        if (code >= 200 && code < 300) {
          resolve({
            objectKey: cred.objectKey,
            url: cred.publicUrl,
            statusCode: code,
          });
          return;
        }
        let msg = `OSS 上传失败 ${code}`;
        try {
          const raw = typeof res.data === 'string' ? res.data : '';
          const m = raw.match(/<Message>([^<]+)<\/Message>/i);
          if (m) msg = m[1];
        } catch (e) { /* */ }
        reject(new Error(msg));
      },
      fail: (err) => reject(new Error((err && (err.errMsg || err.message)) || 'OSS 上传失败')),
    });
  });
}

/**
 * 回退：经后端 /api/products/publish/upload 中转（本地 mock / OSS 未就绪）
 */
function uploadFileViaProxy(filePath, batchId) {
  const app = getApp();
  const baseUrl = (app.globalData && app.globalData.baseUrl) || '';
  const token = (app.globalData && app.globalData.token) || wx.getStorageSync('token') || '';
  const tenantId = (app.globalData && app.globalData.tenantId) || 'tenant_dev_001';
  const appId = (app.globalData && app.globalData.appId) || 'wx394d23ea099d8a01';
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${baseUrl}/api/products/publish/upload`,
      filePath,
      name: 'files',
      formData: batchId ? { batchId } : {},
      header: {
        Authorization: token ? `Bearer ${token}` : '',
        'X-Tenant-Id': tenantId,
        'X-Wx-Appid': appId,
      },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(res.data);
            resolve(data);
          } catch (e) {
            reject(new Error('上传响应解析失败'));
          }
        } else {
          let msg = `上传失败 ${res.statusCode}`;
          try {
            msg = JSON.parse(res.data).message || msg;
          } catch (e) { /* */ }
          reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)));
        }
      },
      fail: (err) => reject(new Error((err && (err.errMsg || err.message)) || '上传失败')),
    });
  });
}

/**
 * 经后端 /api/media/upload 中转（风格样例等非发品用途；不进商品图库）
 */
function uploadFileViaMediaProxy(filePath, { purpose, productId } = {}) {
  const app = getApp();
  const baseUrl = (app.globalData && app.globalData.baseUrl) || '';
  const token = (app.globalData && app.globalData.token) || wx.getStorageSync('token') || '';
  const tenantId = (app.globalData && app.globalData.tenantId) || 'tenant_dev_001';
  const appId = (app.globalData && app.globalData.appId) || 'wx394d23ea099d8a01';
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${baseUrl}/api/media/upload`,
      filePath,
      name: 'file',
      formData: {
        purpose: purpose || 'misc',
        ...(productId ? { productId: String(productId) } : {}),
      },
      header: {
        Authorization: token ? `Bearer ${token}` : '',
        'X-Tenant-Id': tenantId,
        'X-Wx-Appid': appId,
      },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(res.data);
            resolve(data);
          } catch (e) {
            reject(new Error('上传响应解析失败'));
          }
        } else {
          let msg = `上传失败 ${res.statusCode}`;
          try {
            msg = JSON.parse(res.data).message || msg;
          } catch (e) { /* */ }
          reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)));
        }
      },
      fail: (err) => reject(new Error((err && (err.errMsg || err.message)) || '上传失败')),
    });
  });
}

/**
 * 直传优先，失败/proxy 则走 /api/media/upload。
 * @returns {Promise<{objectKey:string, url?:string}>}
 */
async function uploadOneMedia(filePath, { purpose, productId, batchId } = {}) {
  const mime = guessMime(filePath);
  try {
    const creds = await fetchCredentials({
      count: 1,
      purpose: purpose || 'uploads',
      productId,
      batchId,
      mimeType: mime,
    });
    const item = (creds.items && creds.items[0]) || null;
    if (creds.mode === 'post' && item) {
      return await uploadFileToOss(item, filePath);
    }
  } catch (e) {
    /* fall through to media proxy */
  }
  return uploadFileViaMediaProxy(filePath, { purpose, productId });
}

module.exports = {
  fetchCredentials,
  uploadFileToOss,
  uploadFileViaProxy,
  uploadFileViaMediaProxy,
  uploadOneMedia,
  guessMime,
};
