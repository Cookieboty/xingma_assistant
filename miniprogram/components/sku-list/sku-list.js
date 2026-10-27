Component({
  properties: {
    skus: { type: Array, value: [] },
    title: { type: String, value: '颜色 SKU' },
    showHeader: { type: Boolean, value: true },
    readonly: { type: Boolean, value: false },
  },
  methods: {
    onField(e) {
      const { index, field } = e.currentTarget.dataset;
      const skus = (this.data.skus || []).map((s, i) => {
        if (i !== Number(index)) return { ...s };
        return { ...s, [field]: e.detail.value };
      });
      this.triggerEvent('change', { skus });
    },
    onAdd() {
      const skus = (this.data.skus || []).concat([{ color: '', price: '' }]);
      this.triggerEvent('change', { skus });
    },
    onRemove(e) {
      if (this.data.readonly) return;
      const index = Number(e.currentTarget.dataset.index);
      const skus = (this.data.skus || []).slice();
      if (skus.length <= 1) {
        skus[0] = { color: '', price: '' };
      } else {
        skus.splice(index, 1);
      }
      this.triggerEvent('change', { skus });
    },
    /**
     * 一键复制价格：优先用第一行已填价格；若第一行为空则取第一个非空价格；
     * 填到全部颜色 SKU，之后仍可单行修改。
     */
    onCopyPrice() {
      if (this.data.readonly) return;
      const list = this.data.skus || [];
      if (!list.length) {
        wx.showToast({ title: '请先添加颜色', icon: 'none' });
        return;
      }
      let src = '';
      const first = String((list[0] && list[0].price) || '').trim();
      if (first) {
        src = first;
      } else {
        for (let i = 0; i < list.length; i++) {
          const p = String((list[i] && list[i].price) || '').trim();
          if (p) { src = p; break; }
        }
      }
      if (!src) {
        wx.showToast({ title: '请先在某一行填写价格', icon: 'none' });
        return;
      }
      const skus = list.map((s) => Object.assign({}, s, { price: src }));
      this.triggerEvent('change', { skus });
      // 静默复制：成功后不弹 toast/tips
    },
  },
});
