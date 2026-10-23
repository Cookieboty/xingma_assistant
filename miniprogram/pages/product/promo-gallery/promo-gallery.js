const { request } = require('../../../utils/request');
const { saveUrlsToAlbum, saveVideoUrlsToAlbum } = require('../../../utils/saveAlbum');

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

function urlPath(u) {
  if (!u) return '';
  const s = String(u);
  const q = s.indexOf('?');
  return q >= 0 ? s.slice(0, q) : s;
}

function enrichSet(s, prev) {
  const prevItems = (prev && prev.items) || [];
  const prevByIdx = {};
  const prevByMedia = {};
  const prevSelectedByPath = {};
  prevItems.forEach((it, i) => {
    if (!it) return;
    prevByIdx[i] = it;
    if (it.mediaId) prevByMedia[it.mediaId] = it;
    if (it.albumSelected && it.url) prevSelectedByPath[urlPath(it.url)] = true;
    if (it.albumSelected) prevByIdx[i]._sel = true;
  });
  const items = (s.items || []).map((it, i) => {
    const prevIt = (it && it.mediaId && prevByMedia[it.mediaId]) || prevByIdx[i] || null;
    // 私有桶每次签名 URL 不同；同一资源沿用旧 src，避免 <image> 闪烁重载
    let url = it && it.url;
    if (url && prevIt && prevIt.url && urlPath(prevIt.url) === urlPath(url)) {
      url = prevIt.url;
    }
    const selected = !!(url && (prev
      ? (prevSelectedByPath[urlPath(url)] || (prevIt && prevIt._sel) || (prevIt && prevIt.albumSelected))
      : it.albumSelected));
    return Object.assign({}, it, {
      url,
      failed: it.status === 'failed',
      pending: !url && it.status !== 'failed',
      albumSelected: selected,
    });
  });
  const done = s.done != null ? s.done : items.filter((i) => i.url).length;
  const total = s.total != null ? s.total : items.length;
  const busy = !!(s.busy || s.status === 'generating' || s.status === 'queued' || s.status === 'running');
  const withUrl = items.filter((i) => i.url);
  const albumSelectedCount = withUrl.filter((i) => i.albumSelected).length;
  const albumAllSelected = withUrl.length > 0 && albumSelectedCount === withUrl.length;
  const kind = s.kind || s.type || 'image';
  const isVideo = kind === 'video' || kind === 'promo_video';
  const videoUrl = isVideo ? ((items.find((i) => i && i.url) || {}).url || '') : '';
  return Object.assign({}, s, {
    items,
    done,
    total,
    busy,
    isVideo,
    videoUrl,
    albumSelectedCount,
    albumAllSelected,
    albumSaveLabel: albumSelectedCount
      ? (isVideo ? `保存视频(${albumSelectedCount})` : `下载到相册(${albumSelectedCount})`)
      : (isVideo ? '保存视频到相册' : '下载到相册'),
    regenLabel: (!albumSelectedCount
      ? '重新生成'
      : (albumAllSelected
        ? '重新生成整组'
        : (albumSelectedCount === 1 ? '重新生成选中' : `重新生成(${albumSelectedCount})`))),
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

  async load(opts) {
    clearTimeout(this.timer);
    const silent = !!(opts && opts.silent);
    const id = this.data.id;
    if (!id) return;
    const prevMap = {};
    (this.data.sets || []).forEach((s) => { prevMap[s.id] = s; });
    if (!silent) this.setData({ loading: true });
    try {
      let product = this.data.product;
      let setsRaw;
      if (silent && product) {
        setsRaw = await request({ url: `/api/products/${id}/promo/sets` });
      } else {
        const both = await Promise.all([
          request({ url: `/api/products/${id}` }),
          request({ url: `/api/products/${id}/promo/sets` }),
        ]);
        product = both[0];
        setsRaw = both[1];
      }
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
        // 安静轮询：只刷进度，沿用已展示图的签名 URL，避免闪烁
        this.timer = setTimeout(() => this.load({ silent: true }), 4000);
      }
    } catch (e) {
      this.setData({ loading: false });
      if (!silent) wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  goGenerate() {
    wx.showActionSheet({
      itemList: ['新建图片', '新建视频'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/product/promo/promo?id=${this.data.id}&type=image` });
        } else if (res.tapIndex === 1) {
          wx.navigateTo({ url: `/pages/product/promo/promo?id=${this.data.id}&type=video` });
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

  playVideo(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    // 全屏用 video 组件即可；此处保证展开
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
      wx.showToast({ title: set && set.isVideo ? '请先勾选要保存的视频' : '请先勾选要下载的图片', icon: 'none' });
      return;
    }
    this.setData({ savingAlbumId: setId });
    wx.showLoading({ title: `保存中 0/${urls.length}`, mask: true });
    try {
      const saver = (set && set.isVideo) ? saveVideoUrlsToAlbum : saveUrlsToAlbum;
      const r = await saver(urls, {
        onProgress(cur, total) {
          wx.showLoading({ title: `保存中 ${cur}/${total}`, mask: true });
        },
      });
      wx.hideLoading();
      wx.showToast({
        title: r.fail
          ? `成功 ${r.ok} / 失败 ${r.fail}`
          : (set && set.isVideo ? `已保存 ${r.ok} 条视频` : `已保存 ${r.ok} 张到相册`),
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
        title: '删除这组素材',
        content: '删除后不可恢复，确定删除？',
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

  async regenSelected(e) {
    const setId = e.currentTarget.dataset.id;
    if (!setId || this.data.actingId) return;
    const set = this.data.sets.find((s) => s.id === setId);
    if (!set) return;
    const selected = ((set.items) || []).filter((i) => i && i.url && i.albumSelected);
    if (!selected.length) {
      wx.showToast({ title: '请先勾选要重新生成的图片', icon: 'none' });
      return;
    }
    const allWithUrl = ((set.items) || []).filter((i) => i && i.url);
    const whole = selected.length === allWithUrl.length;
    const title = whole ? '重新生成整组' : (selected.length === 1 ? '重新生成选中图片' : `重新生成 ${selected.length} 张`);
    const content = whole
      ? '将按原参数重新生成该组全部图片'
      : '将按原参数重新生成已勾选的图片';
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title,
        content,
        success: (r) => resolve(!!r.confirm),
      });
    });
    if (!ok) return;
    this.setData({ actingId: setId });
    try {
      if (whole) {
        await request({
          url: `/api/products/${this.data.id}/promo/sets/${setId}/regenerate`,
          method: 'POST',
          data: {},
        });
      } else {
        for (const im of selected) {
          const index = Number(im.index);
          if (!Number.isFinite(index)) throw new Error('图片序号缺失');
          await request({
            url: `/api/products/${this.data.id}/promo/sets/${setId}/images/${index}/regenerate`,
            method: 'POST',
            data: {},
          });
        }
      }
      wx.showToast({ title: '已提交重新生成', icon: 'none' });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message || '提交失败', icon: 'none' });
    } finally {
      this.setData({ actingId: '' });
    }
  },
});
