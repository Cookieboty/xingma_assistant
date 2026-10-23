const { request } = require('../../../utils/request');

function buildDescription(sizeText, description) {
  const size = (sizeText || '').trim();
  let desc = (description || '').trim();
  desc = desc.replace(/^尺码[：:].+$/m, '').trim();
  if (size) desc = desc ? `尺码：${size}\n${desc}` : `尺码：${size}`;
  return desc || null;
}

function parseSizeFromDesc(description) {
  const m = (description || '').match(/尺码[：:]\s*(.+)/);
  return m ? m[1].trim() : '';
}

/** 从 suggestion.description 去掉已单独展示的尺码/颜色行，避免重复 */
function cleanDescFromSuggestion(s) {
  let desc = (s && s.description) || '';
  desc = desc
    .replace(/^尺码[：:].+$/m, '')
    .replace(/^颜色[：:].+$/m, '')
    .replace(/^克重[：:].+$/m, '')
    .trim();
  const weight = (s && s.weight) || '';
  if (weight && !desc.includes(weight)) {
    desc = desc ? `克重：${weight}\n${desc}` : `克重：${weight}`;
  }
  return desc;
}

Page({
  data: {
    id: '',
    // 新建：笔记流
    noteText: '',
    parsed: false,
    parsing: false,
    parseHint: '',
    // 商品字段
    styleNo: '',
    name: '',
    material: '',
    description: '',
    sizeText: '',
    levelId: '',
    priceDisplay: 'show',
    status: 'on_sale',
    skus: [{ color: '', price: '' }],
    productLevels: [],
    levelIndex: 0,
    images: [],
    allowCustomerDownload: false,
    saving: false,
    uploading: false,
    reordering: false,
  },
  async onLoad(q) {
    await this.loadLevels();
    if (q.id) {
      this.setData({ id: q.id, parsed: true });
      wx.setNavigationBarTitle({ title: '编辑商品' });
      await this.loadProduct(q.id);
    } else {
      wx.setNavigationBarTitle({ title: '手工发品' });
    }
  },
  async loadLevels() {
    try {
      const productLevels = await request({ url: '/api/levels/product' });
      const list = productLevels || [];
      this.setData({
        productLevels: list,
        levelId: this.data.levelId || (list[0] && list[0].id) || '',
        levelIndex: 0,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '等级加载失败', icon: 'none' });
    }
  },
  async loadProduct(id) {
    try {
      const p = await request({ url: `/api/products/${id}` });
      const levels = this.data.productLevels;
      let levelIndex = levels.findIndex((l) => l.id === p.levelId);
      if (levelIndex < 0) levelIndex = 0;
      const sizeText = parseSizeFromDesc(p.description);
      let description = p.description || '';
      description = description.replace(/^尺码[：:].+\n?/m, '').trim();
      this.setData({
        styleNo: p.styleNo || '',
        name: p.name || '',
        material: p.material || '',
        description,
        sizeText,
        levelId: p.levelId || '',
        priceDisplay: p.priceDisplay || 'show',
        status: p.status || 'draft',
        skus: (p.skus && p.skus.length)
          ? p.skus.map((s) => ({
              id: s.id,
              color: s.color || '',
              price: s.price != null ? String(s.price) : '',
            }))
          : [{ color: '', price: '' }],
        levelIndex,
        images: (p.images || []).filter((im) => im && im.url),
        allowCustomerDownload: !!p.allowCustomerDownload,
      });
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },
  onNoteInput(e) {
    this.setData({ noteText: e.detail.value });
  },
  clearNote() {
    this.setData({ noteText: '' });
  },
  backToNote() {
    this.setData({ parsed: false });
  },
  async parseNote() {
    if (this.data.parsing) return;
    const text = (this.data.noteText || '').trim();
    if (!text) {
      wx.showToast({ title: '请先粘贴笔记文字', icon: 'none' });
      return;
    }
    this.setData({ parsing: true });
    try {
      const res = await request({
        url: '/api/products/parse-note',
        method: 'POST',
        data: { text },
      });
      const s = (res && res.suggestion) || res || {};
      const skus = (s.skus && s.skus.length)
        ? s.skus.map((row) => ({
            color: row.color || '',
            price: row.price != null && row.price !== '' ? String(row.price) : '',
          }))
        : (s.colors || []).map((c) => ({ color: c, price: s.defaultPrice ? String(s.defaultPrice) : '' }));
      if (!skus.length) skus.push({ color: '', price: '' });

      const sizeText = s.sizeText || parseSizeFromDesc(s.description) || '';
      this.setData({
        parsed: true,
        styleNo: s.styleNo || '',
        name: s.name || '',
        material: s.material || '',
        sizeText,
        description: cleanDescFromSuggestion(s),
        skus,
        parseHint: s.ocrNote || '已解析，可改后再保存',
      });
      if (!s.styleNo && !(s.colors && s.colors.length)) {
        wx.showToast({ title: '未识别到款号/颜色，请手改', icon: 'none' });
      } else {
        wx.showToast({ title: '已解析', icon: 'success' });
      }
    } catch (e) {
      wx.showToast({ title: e.message || '解析失败', icon: 'none' });
    } finally {
      this.setData({ parsing: false });
    }
  },
  previewImage(e) {
    const url = e.currentTarget.dataset.url;
    const urls = (this.data.images || []).map((im) => im.url).filter(Boolean);
    if (!url || !urls.length) return;
    wx.previewImage({ urls, current: url });
  },
  addImages() {
    if (!this.data.id || this.data.uploading) return;
    const MAX = 60;
    const remain = MAX - (this.data.images || []).length;
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX} 张`, icon: 'none' });
      return;
    }
    const count = Math.min(9, remain);
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const paths = (res.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean);
        if (paths.length) this.uploadPaths(paths);
      },
      fail: (err) => {
        const msg = (err && (err.errMsg || err.message)) || '';
        if (/cancel/i.test(msg)) return;
        wx.chooseImage({
          count,
          success: (res) => {
            const paths = res.tempFilePaths || [];
            if (paths.length) this.uploadPaths(paths);
          },
        });
      },
    });
  },
  uploadPaths(paths) {
    const app = getApp();
    const baseUrl = app.globalData.baseUrl || '';
    const token = app.globalData.token || wx.getStorageSync('token') || '';
    const tenantId = app.globalData.tenantId || 'tenant_dev_001';
    const id = this.data.id;
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中' });
    (async () => {
      try {
        for (const filePath of paths) {
          await new Promise((resolve, reject) => {
            wx.uploadFile({
              url: `${baseUrl}/api/products/${id}/images`,
              filePath,
              name: 'files',
              header: {
                Authorization: token ? `Bearer ${token}` : '',
                'X-Tenant-Id': tenantId,
                'X-Wx-Appid': app.globalData.appId || 'wx394d23ea099d8a01',
              },
              success: (res) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  try {
                    const body = JSON.parse(res.data);
                    if (body.images) this.setData({ images: body.images.filter((im) => im && im.url) });
                    resolve(body);
                  } catch (e) {
                    reject(new Error('上传响应解析失败'));
                  }
                } else {
                  let msg = `上传失败 ${res.statusCode}`;
                  try { msg = JSON.parse(res.data).message || msg; } catch (e) { /* */ }
                  reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)));
                }
              },
              fail: reject,
            });
          });
        }
        wx.hideLoading();
        wx.showToast({ title: `已添加 ${paths.length} 张`, icon: 'none' });
      } catch (e) {
        wx.hideLoading();
        const msg = (e && (e.message || e.errMsg)) || '上传失败';
        wx.showToast({ title: String(msg).slice(0, 40), icon: 'none', duration: 3000 });
      } finally {
        this.setData({ uploading: false });
      }
    })();
  },
  async removeImage(e) {
    const mediaId = e.currentTarget.dataset.id;
    if (!mediaId || !this.data.id) return;
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '删除图片',
        content: '确定从商品中删除这张图？',
        success: (r) => resolve(!!r.confirm),
      });
    });
    if (!ok) return;
    try {
      const p = await request({
        url: `/api/products/${this.data.id}/images/${mediaId}`,
        method: 'DELETE',
        data: {},
      });
      this.setData({ images: (p.images || []).filter((im) => im && im.url) });
    } catch (err) {
      wx.showToast({ title: err.message || '删除失败', icon: 'none' });
    }
  },
  onStyle(e) { this.setData({ styleNo: e.detail.value }); },
  onName(e) { this.setData({ name: e.detail.value }); },
  onMaterial(e) { this.setData({ material: e.detail.value }); },
  onDesc(e) { this.setData({ description: e.detail.value }); },
  onSizeText(e) { this.setData({ sizeText: e.detail.value }); },
  onStatusTap(e) { this.setData({ status: e.currentTarget.dataset.v }); },
  onPriceDisplayTap(e) { this.setData({ priceDisplay: e.currentTarget.dataset.v }); },
  onLevelChange(e) {
    const idx = Number(e.detail.value);
    const level = this.data.productLevels[idx];
    this.setData({ levelIndex: idx, levelId: level ? level.id : '' });
  },
  onSkusChange(e) {
    this.setData({ skus: e.detail.skus || [] });
  },
  onDownloadTap(e) {
    const v = e.currentTarget.dataset.v;
    this.setData({ allowCustomerDownload: v === '1' || v === 1 });
  },
  async moveImage(e) {
    if (this.data.reordering || !this.data.id) return;
    const id = e.currentTarget.dataset.id;
    const dir = e.currentTarget.dataset.dir;
    const images = (this.data.images || []).slice();
    const idx = images.findIndex((im) => im.id === id);
    if (idx < 0) return;
    let next = idx;
    if (dir === 'left') next = idx - 1;
    else if (dir === 'right') next = idx + 1;
    else if (dir === 'top') next = 0;
    if (next < 0 || next >= images.length || next === idx) return;
    const [item] = images.splice(idx, 1);
    images.splice(next, 0, item);
    this.setData({ images, reordering: true });
    try {
      await request({
        url: `/api/products/${this.data.id}`,
        method: 'PATCH',
        data: { coverMediaIds: images.map((im) => im.id) },
      });
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '调序失败', icon: 'none' });
      await this.loadProduct(this.data.id);
    } finally {
      this.setData({ reordering: false });
    }
  },
  buildPayload() {
    const skus = (this.data.skus || [])
      .filter((s) => (s.color || '').trim())
      .map((s) => ({
        color: s.color.trim(),
        size: null,
        price: (s.price || '').trim() || null,
        stock: 0,
        status: 'active',
      }));
    return {
      styleNo: this.data.styleNo.trim(),
      name: this.data.name.trim(),
      material: this.data.material.trim() || null,
      description: buildDescription(this.data.sizeText, this.data.description),
      levelId: this.data.levelId,
      priceDisplay: this.data.priceDisplay,
      status: this.data.status,
      allowCustomerDownload: !!this.data.allowCustomerDownload,
      skus,
    };
  },
  async save() {
    if (this.data.saving) return;
    if (!this.data.id && !this.data.parsed) {
      wx.showToast({ title: '请先解析笔记', icon: 'none' });
      return;
    }
    const payload = this.buildPayload();
    if (!payload.styleNo || !payload.name || !payload.levelId) {
      wx.showToast({ title: '请填款号、名称', icon: 'none' });
      return;
    }
    if (!payload.skus.length) {
      wx.showToast({ title: '请至少填写一个颜色', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      if (this.data.id) {
        const { skus, ...rest } = payload;
        rest.coverMediaIds = (this.data.images || []).map((im) => im.id).filter(Boolean);
        await request({ url: `/api/products/${this.data.id}`, method: 'PATCH', data: rest });
        const detail = await request({ url: `/api/products/${this.data.id}` });
        for (const s of detail.skus || []) {
          await request({
            url: `/api/products/${this.data.id}/skus/${s.id}`,
            method: 'DELETE',
          }).catch(() => {});
        }
        for (const s of skus) {
          await request({
            url: `/api/products/${this.data.id}/skus`,
            method: 'POST',
            data: s,
          });
        }
      } else {
        await request({ url: '/api/products', method: 'POST', data: payload });
      }
      wx.showToast({ title: '已保存' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
  async copyProduct() {
    if (!this.data.id) return;
    try {
      const res = await request({
        url: `/api/products/${this.data.id}/copy`,
        method: 'POST',
        data: {},
      });
      wx.showToast({ title: '已复制' });
      wx.redirectTo({ url: `/pages/product/edit/edit?id=${res.id}` });
    } catch (e) {
      wx.showToast({ title: e.message || '复制失败', icon: 'none' });
    }
  },
});
