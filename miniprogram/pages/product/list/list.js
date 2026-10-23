const publishQueue = require('../../../utils/publish-upload-queue');
const { request } = require('../../../utils/request');

const PAGE_SIZE = 10;

function shortMaterial(m) {
  if (!m) return '';
  const s = String(m).replace(/\s+/g, ' ').trim();
  return s.length > 18 ? s.slice(0, 18) + '…' : s;
}

function normalizeItem(p) {
  const colorCount = p.colorCount != null
    ? p.colorCount
    : ((p.skus && p.skus.length) || 0);
  const priceText = p.priceText || '未标价';
  const priceMuted = priceText === '未标价' || priceText === '询价' || priceText === '价格请询价';
  return Object.assign({}, p, {
    coverUrl: p.coverUrl || (p.images && p.images[0] && p.images[0].url) || '',
    colorCount,
    materialShort: shortMaterial(p.material),
    priceText,
    priceMuted,
  });
}

function ensureStaff() {
  const app = getApp();
  const role = app.globalData.role || '';
  const token = app.globalData.token || '';
  if (!token || (role !== 'owner' && role !== 'staff')) {
    wx.reLaunch({ url: '/pages/index/index' });
    return false;
  }
  return true;
}

function promptText(title, placeholder, initial) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      editable: true,
      placeholderText: placeholder || '',
      content: initial || '',
      success: (r) => {
        if (!r.confirm) return resolve(null);
        resolve(String(r.content || '').trim());
      },
      fail: () => resolve(null),
    });
  });
}

function confirmModal(title, content) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
}

function actionSheet(itemList) {
  return new Promise((resolve) => {
    if (!itemList || !itemList.length) {
      resolve(-1);
      return;
    }
    wx.showActionSheet({
      itemList,
      success: (r) => resolve(r.tapIndex),
      fail: () => resolve(-1),
    });
  });
}

Page({
  data: {
    list: [],
    isStaff: false,
    q: '',
    status: '',
    groupId: '',
    groups: [],
    currentGroupName: '本季款式',
    statusLabel: { on_sale: '在售', off_sale: '下架', draft: '草稿' },
    page: 1,
    total: 0,
    hasMore: true,
    loading: false,
    loadingMore: false,
    groupPanelVisible: false,
    groupPanelMode: 'manage',
    moveProductId: '',
  },

  onShow() {
    try { publishQueue.resumeAll(); } catch (e) { /* */ }
    if (!ensureStaff()) return;
    const app = getApp();
    this.setData({ isStaff: true, role: app.globalData.role });
    this.loadGroups().then(() => this.reload());
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return;
    this.loadMore();
  },

  onSearchInput(e) { this.setData({ q: e.detail.value }); },
  onSearch() { this.reload(); },
  onStatusFilter(e) {
    this.setData({ status: e.currentTarget.dataset.status || '' });
    this.reload();
  },
  onGroupFilter(e) {
    const id = e.currentTarget.dataset.id || '';
    const g = (this.data.groups || []).find((x) => x.id === id);
    this.setData({
      groupId: id,
      currentGroupName: (g && g.name) || '全部',
    });
    this.reload();
  },

  async loadGroups() {
    try {
      const res = await request({ url: '/api/product-groups' });
      const groups = (res && res.items) || [];
      let groupId = this.data.groupId;
      const stillThere = groupId && groups.some((g) => g.id === groupId);
      if (!groupId || !stillThere) {
        const latest = groups.find((g) => g.isLatest) || groups[0];
        groupId = latest ? latest.id : '';
      }
      const cur = groups.find((g) => g.id === groupId);
      this.setData({
        groups,
        groupId,
        currentGroupName: (cur && cur.name) || '本季款式',
      });
      return groups;
    } catch (e) {
      return this.data.groups || [];
    }
  },

  async afterGroupChange(needReloadList) {
    const prevId = this.data.groupId;
    await this.loadGroups();
    if (needReloadList || this.data.groupId !== prevId) {
      await this.reload();
    }
  },

  manageGroups() {
    this.setData({
      groupPanelVisible: true,
      groupPanelMode: 'manage',
      moveProductId: '',
    });
  },

  closeGroupPanel() {
    this.setData({
      groupPanelVisible: false,
      moveProductId: '',
    });
  },

  noop() {},

  async onGroupPanelRowTap(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.groupPanelMode === 'move') {
      const productId = this.data.moveProductId;
      const target = (this.data.groups || []).find((g) => g.id === id);
      if (!productId || !target) return;
      this.closeGroupPanel();
      try {
        await request({
          url: '/api/product-groups/move-product',
          method: 'POST',
          data: { productId, groupId: target.id },
        });
        wx.showToast({ title: `已移到${target.name}`, icon: 'none' });
        this.reload();
      } catch (err) {
        wx.showToast({ title: err.message || '调组失败', icon: 'none' });
      }
      return;
    }
    const group = (this.data.groups || []).find((g) => g.id === id);
    if (!group) return;
    await this.manageOneGroup(group);
  },

  async createGroup() {
    const name = await promptText('新建分组', '例如：春季新款');
    if (name == null) return;
    if (!name) {
      wx.showToast({ title: '请输入分组名称', icon: 'none' });
      return;
    }
    try {
      await request({
        url: '/api/product-groups',
        method: 'POST',
        data: { name },
      });
      wx.showToast({ title: '已创建', icon: 'success' });
      await this.afterGroupChange(false);
    } catch (err) {
      wx.showToast({ title: err.message || '创建失败', icon: 'none' });
    }
  },

  async manageOneGroup(group) {
    const actions = ['改名'];
    if (!group.isLatest) actions.push('设为本季');
    actions.push('删除');
    const tap = await actionSheet(actions);
    if (tap < 0) return;
    const action = actions[tap];
    if (action === '改名') {
      await this.renameGroup(group);
    } else if (action === '设为本季') {
      await this.setLatestGroup(group);
    } else if (action === '删除') {
      await this.deleteGroup(group);
    }
  },

  async renameGroup(group) {
    const name = await promptText('改名', '分组名称', group.name);
    if (name == null) return;
    if (!name) {
      wx.showToast({ title: '请输入分组名称', icon: 'none' });
      return;
    }
    if (name === group.name) return;
    try {
      await request({
        url: `/api/product-groups/${group.id}`,
        method: 'PATCH',
        data: { name },
      });
      wx.showToast({ title: '已改名', icon: 'success' });
      await this.afterGroupChange(false);
    } catch (err) {
      wx.showToast({ title: err.message || '改名失败', icon: 'none' });
    }
  },

  async setLatestGroup(group) {
    try {
      await request({
        url: `/api/product-groups/${group.id}/latest`,
        method: 'PATCH',
      });
      wx.showToast({ title: '已设为本季', icon: 'success' });
      await this.afterGroupChange(false);
    } catch (err) {
      wx.showToast({ title: err.message || '设置失败', icon: 'none' });
    }
  },

  async deleteGroup(group) {
    const ok = await confirmModal(
      '删除分组',
      `确定删除「${group.name}」？组内须先无商品。`,
    );
    if (!ok) return;
    try {
      await request({
        url: `/api/product-groups/${group.id}`,
        method: 'DELETE',
      });
      wx.showToast({ title: '已删除', icon: 'success' });
      await this.afterGroupChange(true);
    } catch (err) {
      wx.showToast({ title: err.message || '删除失败', icon: 'none' });
    }
  },

  async moveGroup(e) {
    const productId = e.currentTarget.dataset.id;
    const groups = this.data.groups || [];
    if (!productId) return;
    if (groups.length < 2) {
      wx.showToast({ title: '请先新建分组', icon: 'none' });
      return;
    }
    // ≤5 其它目标时用 ActionSheet；更多则走面板（ActionSheet 上限 6）
    const others = groups; // 允许移到当前组（幂等），列表更直观
    if (others.length <= 6) {
      const names = others.map((g) => (g.isLatest ? `${g.name}（本季）` : g.name));
      const tap = await actionSheet(names);
      if (tap < 0) return;
      const target = others[tap];
      try {
        await request({
          url: '/api/product-groups/move-product',
          method: 'POST',
          data: { productId, groupId: target.id },
        });
        wx.showToast({ title: `已移到${target.name}`, icon: 'none' });
        this.reload();
      } catch (err) {
        wx.showToast({ title: err.message || '调组失败', icon: 'none' });
      }
      return;
    }
    this.setData({
      groupPanelVisible: true,
      groupPanelMode: 'move',
      moveProductId: productId,
    });
  },

  reload() {
    this.setData({ page: 1, hasMore: true, list: [] });
    return this.fetchPage(1, false);
  },

  loadMore() {
    const next = this.data.page + 1;
    return this.fetchPage(next, true);
  },

  async fetchPage(page, append) {
    if (append) this.setData({ loadingMore: true });
    else this.setData({ loading: true });
    try {
      const qs = [
        `page=${page}`,
        `pageSize=${PAGE_SIZE}`,
      ];
      if (this.data.q) qs.push(`q=${encodeURIComponent(this.data.q)}`);
      if (this.data.status) qs.push(`status=${this.data.status}`);
      if (this.data.groupId) qs.push(`groupId=${this.data.groupId}`);
      const res = await request({ url: `/api/products?${qs.join('&')}` });
      const raw = Array.isArray(res) ? res : (res.items || []);
      const total = Array.isArray(res) ? raw.length : (res.total != null ? res.total : raw.length);
      const items = raw.map(normalizeItem);
      const list = append ? this.data.list.concat(items) : items;
      const hasMore = list.length < total && items.length >= PAGE_SIZE;
      this.setData({
        list,
        total,
        page,
        hasMore,
        loading: false,
        loadingMore: false,
      });
    } catch (e) {
      this.setData({ loading: false, loadingMore: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/product/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
  goEdit(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: id ? `/pages/product/edit/edit?id=${id}` : '/pages/product/edit/edit',
    });
  },
  goPublish() {
    wx.navigateTo({ url: '/pages/product/publish/publish' });
  },
  goSettings() {
    wx.navigateTo({ url: '/pages/settings/index/index' });
  },
  async toggleSale(e) {
    const { id, status } = e.currentTarget.dataset;
    const next = status === 'on_sale' ? 'off_sale' : 'on_sale';
    try {
      await request({
        url: '/api/products/batch-status',
        method: 'POST',
        data: { ids: [id], status: next },
      });
      this.reload();
    } catch (err) {
      wx.showToast({ title: err.message || '失败', icon: 'none' });
    }
  },
});
