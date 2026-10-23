const { request } = require('../../../utils/request');
const { saveUrlsToAlbum } = require('../../../utils/saveAlbum');

const STATUS_LABEL = {
  generating: '生成中',
  queued: '排队中',
  running: '生成中',
  pending: '待生成',
  done: '已完成',
  partial: '部分完成',
  failed: '失败',
  succeeded: '已完成',
};

function enrichSet(s, prev) {
  const prevItems = (prev && prev.items) || [];
  const prevByUrl = {};
  const prevByIdx = {};
  prevItems.forEach((it, i) => {
    if (it && it.albumSelected) {
      if (it.url) prevByUrl[it.url] = true;
      prevByIdx[i] = true;
    }
  });
  const items = (s.items || []).map((it, i) => Object.assign({}, it, {
    failed: it.status === 'failed',
    pending: !it.url && it.status !== 'failed',
    albumSelected: !!(it.url && (prev
      ? (prevByUrl[it.url] || prevByIdx[i])
      : it.albumSelected)),
  }));
  const done = s.done != null ? s.done : items.filter((i) => i.url).length;
  const total = s.total != null ? s.total : items.length;
  const busy = !!(s.busy || s.status === 'generating' || s.status === 'queued' || s.status === 'running');
  const withUrl = items.filter((i) => i.url);
  const albumSelectedCount = withUrl.filter((i) => i.albumSelected).length;
  const albumAllSelected = withUrl.length > 0 && albumSelectedCount === withUrl.length;
  const kind = s.kind || s.type || 'image';
  const isVideo = kind === 'video' || kind === 'promo_video';
  return Object.assign({}, s, {
    items,
    done,
    total,
    busy,
    albumSelectedCount,
    albumAllSelected,
    albumSaveLabel: albumSelectedCount ? `下载(${albumSelectedCount})` : '下载到相册',
    statusLabel: STATUS_LABEL[s.status] || s.status,
    templateName: s.displayTitle || s.templateName || (isVideo ? '宣传视频' : '宣传图'),
    typeLabel: isVideo ? '视频' : '图',
    progressText: s.progress && s.progress.message ? s.progress.message : '',
    percent: (s.progress && s.progress.percent) || (total ? Math.round((done / total) * 100) : 0),
    expanded: prev ? !!prev.expanded : false,
    hasCaption: !!(s.caption && String(s.caption).trim()),
  });
}

Page({
  data: {
    id: '',
    focusSetId: '',
    product: null,
    sets: [],
    loading: true,
    actingId: '',
    savingAlbumId: '',
    showJobsEntry: false,
  },

  onLoad(q) {
    this.setData({ id: q.id || '', focusSetId: q.setId || '' });
  },
  onShow() {
    if (this.data.id) this.load();
  },
  onHide() { clearTimeout(this.timer); },
  onUnload() { clearTimeout(this.timer); },
  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    clearTimeout(this.timer);
    const id = this.data.id;
    if (!id) return;
    const prevMap = {};
    (this.data.sets || []).forEach((s) => { prevMap[s.id] = s; });
    this.setData({ loading: true });
    try {
      const [product, setsRaw] = await Promise.all([
        request({ url: `/api/products/${id}` }),
        request({ url: `/api/products/${id}/promo/sets` }),
      ]);
      const list = Array.isArray(setsRaw) ? setsRaw : setsRaw.items || [];
      const focusSetId = this.data.focusSetId;
      const sets = list.map((s) => {
        const enriched = enrichSet(s, prevMap[s.id]);
        if (focusSetId && s.id === focusSetId) {
          enriched.expanded = true;
        }
        return enriched;
      });
      const showJobsEntry = sets.some((s) => s.busy);
      this.setData({ product, sets, loading: false, showJobsEntry });
      if (focusSetId) {
        // 仅首次从详情深链进来时锁定展开；之后刷新保留用户操作
        this.setData({ focusSetId: '' });
        setTimeout(() => {
          wx.pageScrollTo({ selector: `#set-${focusSetId}`, duration: 300 });
        }, 200);
      }
      if (showJobsEntry) {
        this.timer = setTimeout(() => this.load(), 4000);
      }
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  goGenerate() {
    wx.showActionSheet({
      itemList: ['新建宣传图', '新建宣传视频（即将支持）'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/product/promo/promo?id=${this.data.id}` });
        } else if (res.tapIndex === 1) {
          wx.showToast({ title: '宣传视频即将支持', icon: 'none' });
        }
      },
    });
  },
  goJobs() {
    wx.switchTab({ url: '/pages/jobs/list/list' });
  },

  toggleExpand(e) {
    const id = e.currentTarget.dataset.id;
    const sets = this.data.sets.map((s) => (
      s.id === id ? Object.assign({}, s, { expanded: !s.expanded }) : s
    ));
    this.setData({ sets });
  },

  preview(e) {
    const { url, setid } = e.currentTarget.dataset;
    const set = this.data.sets.find((s) => s.id === setid);
    const urls = ((set && set.items) || []).filter((i) => i.url).map((i) => i.url);
    if (!url || !urls.length) return;
    wx.previewImage({ urls, current: url });
  },

  toggleAlbumItem(e) {
    const { setid, index } = e.currentTarget.dataset;
    const sets = this.data.sets.map((s) => {
      if (s.id !== setid) return s;
      const items = (s.items || []).slice();
      const idx = Number(index);
      const it = items[idx];
      if (!it || !it.url) return s;
      items[idx] = Object.assign({}, it, { albumSelected: !it.albumSelected });
      return enrichSet(Object.assign({}, s, { items, expanded: s.expanded }), null);
    });
    this.setData({ sets });
  },

  toggleSelectAllAlbum(e) {
    const setId = e.currentTarget.dataset.id;
    const sets = this.data.sets.map((s) => {
      if (s.id !== setId) return s;
      const allOn = s.albumAllSelected;
      const items = (s.items || []).map((it) => (it && it.url
        ? Object.assign({}, it, { albumSelected: !allOn })
        : it));
      return enrichSet(Object.assign({}, s, { items, expanded: s.expanded }), null);
    });
    this.setData({ sets });
  },

  async saveToAlbum(e) {
    const setId = e.currentTarget.dataset.id;
    if (!setId || this.data.savingAlbumId) return;
    const set = this.data.sets.find((s) => s.id === setId);
    const urls = ((set && set.items) || [])
      .filter((i) => i && i.url && i.albumSelected)
      .map((i) => i.url);
    if (!urls.length) {
      wx.showToast({ title: '请先勾选要下载的图片', icon: 'none' });
      return;
    }
    this.setData({ savingAlbumId: setId });
    wx.showLoading({ title: `保存中 0/${urls.length}`, mask: true });
    try {
      const r = await saveUrlsToAlbum(urls, {
        onProgress(cur, total) {
          wx.showLoading({ title: `保存中 ${cur}/${total}`, mask: true });
        },
      });
      wx.hideLoading();
      wx.showToast({
        title: r.fail ? `成功 ${r.ok} / 失败 ${r.fail}` : `已保存 ${r.ok} 张到相册`,
        icon: 'none',
        duration: 2500,
      });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    } finally {
      this.setData({ savingAlbumId: '' });
    }
  },

  copyCaption(e) {
    const setId = e.currentTarget.dataset.id;
    const set = this.data.sets.find((s) => s.id === setId);
    const text = (set && set.caption) || '';
    if (!text) {
      wx.showToast({ title: '暂无文案', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '文案已复制', icon: 'none' }),
    });
  },

  async deleteSet(e) {
    const setId = e.currentTarget.dataset.id;
    if (!setId || this.data.actingId) return;
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '删除整组',
        content: '将删除该组宣传图及其商品关联，确定？',
        success: (r) => resolve(!!r.confirm),
      });
    });
    if (!ok) return;
    this.setData({ actingId: setId });
    try {
      await request({
        url: `/api/products/${this.data.id}/promo/sets/${setId}`,
        method: 'DELETE',
      });
      wx.showToast({ title: '已删除', icon: 'none' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '删除失败', icon: 'none' });
    } finally {
      this.setData({ actingId: '' });
    }
  },

  async regenSet(e) {
    const setId = e.currentTarget.dataset.id;
    if (!setId || this.data.actingId) return;
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '整组重新生成',
        content: '将按原参数重新生成该组全部图片',
        success: (r) => resolve(!!r.confirm),
      });
    });
    if (!ok) return;
    this.setData({ actingId: setId });
    try {
      await request({
        url: `/api/products/${this.data.id}/promo/sets/${setId}/regenerate`,
        method: 'POST',
        data: {},
      });
      wx.showToast({ title: '已提交重生成', icon: 'none' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '提交失败', icon: 'none' });
    } finally {
      this.setData({ actingId: '' });
    }
  },

  async regenImage(e) {
    const { setid, index } = e.currentTarget.dataset;
    if (!setid || this.data.actingId) return;
    this.setData({ actingId: `${setid}_${index}` });
    try {
      await request({
        url: `/api/products/${this.data.id}/promo/sets/${setid}/images/${index}/regenerate`,
        method: 'POST',
        data: {},
      });
      wx.showToast({ title: '单张已提交', icon: 'none' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '提交失败', icon: 'none' });
    } finally {
      this.setData({ actingId: '' });
    }
  },
});
