const { request } = require('../../../utils/request');
const { startPublishUpload, getSnapshot, syncLeaveGuard, pendingUploadCount, leaveWarnMessage } = require('../../../utils/publish-upload-queue');

const ROLE_ORDER = ['hangtag', 'main', 'detail', 'multi_color', 'unknown'];
const ROLE_LABEL = {
  hangtag: '吊牌',
  main: '主图',
  detail: '细节',
  multi_color: '多色',
  unknown: '未分',
};

Page({
  data: {
    step: 1,
    localPaths: [],
    batchId: '',
    images: [],
    styleNo: '',
    name: '',
    material: '',
    sizeText: '',
    description: '',
    skus: [{ color: '', price: '' }],
    status: 'on_sale',
    levelId: '',
    ocrNote: '',
    roleLabel: ROLE_LABEL,
    submitting: false,
    runningHint: '',
  },
  async onLoad() {
    try {
      const levels = await request({ url: '/api/levels/product' });
      const list = levels || [];
      const open = list.find((l) => l.code === 'open' || l.id === 'pl_open') || list[0];
      this.setData({ levelId: open ? open.id : '' });
    } catch (e) {
      /* ignore */
    }
  },
  onShow() {
    const snap = getSnapshot();
    const n = (snap.running || []).length;
    this.setData({
      runningHint: n ? `后台已有 ${n} 批上传中，可再开新一批` : '',
    });
    syncLeaveGuard(snap);
  },
  onHide() {
    syncLeaveGuard(getSnapshot());
  },
  chooseImages() {
    const MAX = 60;
    const have = (this.data.localPaths || []).length;
    const remain = MAX - have;
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
        if (!paths.length) return;
        this.setData({ localPaths: this.data.localPaths.concat(paths).slice(0, MAX) });
      },
      fail: (err) => {
        const msg = (err && (err.errMsg || err.message)) || '';
        if (/cancel/i.test(msg)) return;
        wx.chooseImage({
          count,
          success: (res) => {
            const paths = res.tempFilePaths || [];
            if (!paths.length) return;
            this.setData({ localPaths: this.data.localPaths.concat(paths).slice(0, MAX) });
          },
        });
      },
    });
  },
  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(index)) return;
    const localPaths = this.data.localPaths.slice();
    localPaths.splice(index, 1);
    this.setData({ localPaths });
  },
  /**
   * 立刻把任务丢进全局队列并离开本页；上传在后台跑（浮窗看进度）。
   * 可与已有上传任务并发（多 batch）。
   */
  async uploadAndPublish() {
    if (this.data.submitting || !this.data.localPaths.length) return;
    if (!this.data.levelId) {
      wx.showToast({ title: '无商品等级，请先在设置里添加', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    const paths = this.data.localPaths.slice();
    try {
      await startPublishUpload({
        localPaths: paths,
        levelId: this.data.levelId,
        status: this.data.status || 'on_sale',
        priceDisplay: 'show',
      });
      this.setData({ localPaths: [], submitting: false });
      wx.showToast({ title: '已开始上传', icon: 'success', duration: 1200 });
      setTimeout(() => {
        wx.switchTab({
          url: '/pages/product/list/list',
          fail: () => {
            wx.navigateBack({ fail: () => {} });
          },
        });
      }, 200);
    } catch (e) {
      this.setData({ submitting: false });
      wx.showToast({
        title: String((e && e.message) || e).slice(0, 40),
        icon: 'none',
      });
    }
  },
  backToSelect() {
    this.setData({
      step: 1,
      localPaths: [],
      batchId: '',
      images: [],
    });
  },
  cycleRole(e) {
    const index = Number(e.currentTarget.dataset.index);
    const images = this.data.images.slice();
    const cur = images[index].role;
    const i = ROLE_ORDER.indexOf(cur);
    images[index] = { ...images[index], role: ROLE_ORDER[(i + 1) % ROLE_ORDER.length] };
    this.setData({ images });
  },
  onStyle(e) { this.setData({ styleNo: e.detail.value }); },
  onName(e) { this.setData({ name: e.detail.value }); },
  onMaterial(e) { this.setData({ material: e.detail.value }); },
  onSizeText(e) { this.setData({ sizeText: e.detail.value }); },
  onDesc(e) { this.setData({ description: e.detail.value }); },
  onStatusTap(e) { this.setData({ status: e.currentTarget.dataset.v }); },
  onSkusChange(e) { this.setData({ skus: e.detail.skus || [] }); },
  /** 保留旧 confirm（step2 人工确认）；主按钮已走异步建品 */
  async confirmPublish() {
    if (this.data.saving) return;
    const styleNo = this.data.styleNo.trim();
    const name = this.data.name.trim();
    if (!styleNo || !name) {
      wx.showToast({ title: '请填款号和名称', icon: 'none' });
      return;
    }
    if (!this.data.levelId) {
      wx.showToast({ title: '无商品等级，请先在设置里添加', icon: 'none' });
      return;
    }
    const skus = (this.data.skus || [])
      .filter((s) => (s.color || '').trim())
      .map((s) => ({ color: s.color.trim(), price: (s.price || '').trim() || null }));
    if (!skus.length) {
      wx.showToast({ title: '请至少保留一个颜色', icon: 'none' });
      return;
    }
    let description = (this.data.description || '').trim();
    const sizeText = (this.data.sizeText || '').trim();
    if (sizeText) {
      description = description ? `尺码：${sizeText}\n${description}` : `尺码：${sizeText}`;
    }
    this.setData({ saving: true });
    try {
      const product = await request({
        url: '/api/products/publish/confirm',
        method: 'POST',
        data: {
          batchId: this.data.batchId,
          styleNo,
          name,
          material: this.data.material.trim() || null,
          description: description || null,
          levelId: this.data.levelId,
          status: this.data.status,
          skus,
          images: this.data.images.map((im) => ({
            mediaId: im.mediaId,
            role: im.role,
            colorHint: im.colorHint || null,
          })),
        },
      });
      wx.showToast({ title: '发品成功' });
      setTimeout(() => {
        wx.redirectTo({ url: `/pages/product/edit/edit?id=${product.id}` });
      }, 400);
    } catch (e) {
      wx.showToast({ title: e.message || '发品失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
