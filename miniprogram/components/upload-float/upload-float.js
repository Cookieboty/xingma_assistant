const queue = require('../../utils/publish-upload-queue');

Component({
  data: {
    visible: false,
    title: '',
    subtitle: '',
    percent: 0,
    showBar: true,
    canRetry: false,
    canOpen: false,
    canDismiss: false,
    primaryId: '',
  },
  lifetimes: {
    attached() {
      this._unsub = queue.subscribe((snap) => this.applySnap(snap));
      this.applySnap(queue.getSnapshot());
    },
    detached() {
      if (this._unsub) this._unsub();
    },
  },
  pageLifetimes: {
    show() {
      queue.resumeAll();
      this.applySnap(queue.getSnapshot());
    },
  },
  methods: {
    noop() {},
    applySnap(snap) {
      if (!snap) return;
      const primary = snap.primary;
      const running = snap.running || [];
      let title = '';
      let subtitle = '';
      let percent = 0;
      let showBar = true;
      let canRetry = false;
      let canOpen = false;
      let canDismiss = false;
      let primaryId = primary ? primary.id : '';

      if (running.length) {
        const j = running[0];
        const done = j.doneCount || 0;
        const total = j.total || 1;
        percent = Math.min(100, Math.round((done / total) * 100));
        if (j.phase === 'enqueueing') {
          title = running.length > 1
            ? `入队中 · 另有 ${running.length - 1} 个任务`
            : '正在入队…';
          subtitle = `已上传 ${done}/${total}`;
          percent = 95;
        } else {
          title = running.length > 1
            ? `上传中 ${done}/${total} · 共 ${running.length} 批`
            : `上传中 ${done}/${total}`;
          const left = Math.max(0, total - done);
          subtitle = left
            ? `还有 ${left} 张在传，传完才能建品，先别退出`
            : (j.mode === 'post' ? '直传 OSS，可继续逛商品' : '上传中，可继续逛商品');
        }
        showBar = true;
        canOpen = false;
        canRetry = false;
        canDismiss = false;
      } else if (primary && primary.phase === 'failed') {
        title = '上传失败';
        subtitle = primary.error || '可点重试';
        showBar = false;
        canRetry = true;
        canDismiss = true;
        percent = 0;
      } else if (primary && primary.phase === 'done') {
        title = primary.productId ? '已开始建品' : '已入队';
        subtitle = '点查看打开草稿或任务';
        showBar = false;
        canOpen = true;
        canDismiss = true;
        percent = 100;
      }

      const visible = !!(running.length || (primary && (primary.phase === 'failed' || primary.phase === 'done') && Date.now() - primary.createdAt < 90 * 1000));

      this.setData({
        visible,
        title,
        subtitle,
        percent,
        showBar,
        canRetry,
        canOpen,
        canDismiss,
        primaryId,
      });
    },
    onTap() {
      const snap = queue.getSnapshot();
      if (snap.primary && snap.primary.phase === 'done') {
        queue.openResult(snap.primary);
      } else {
        wx.switchTab({ url: '/pages/jobs/list/list' });
      }
    },
    onRetry() {
      if (this.data.primaryId) queue.retryJob(this.data.primaryId);
    },
    onOpen() {
      const snap = queue.getSnapshot();
      queue.openResult(snap.primary);
    },
    onDismiss() {
      if (this.data.primaryId) queue.dismissJob(this.data.primaryId);
    },
  },
});
