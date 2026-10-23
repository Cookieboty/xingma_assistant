/**
 * 发品上传队列（多任务并发、可恢复）
 * - 每个 job = 一次选图发品（独立 batch）
 * - 直传 OSS → POST /api/products/publish/from-oss 入队
 * - 锁屏/回前台：onShow 时 resumeAll 重试 pending/failed
 * - 不承诺后台无限传；仅 best-effort
 */

const { request } = require('./request');
const { requestJobSubscribe } = require('./profile');
const {
  fetchCredentials,
  uploadFileToOss,
  uploadFileViaProxy,
} = require('./oss-direct');

const STORAGE_KEY = 'wool_publish_upload_queue_v1';
const MAX_CONCURRENT_FILES = 3; // 单 job 内并发直传数
const MAX_ACTIVE_JOBS = 3; // 同时跑的发品任务数

/** @type {Array<Job>} */
let jobs = [];
/** @type {Array<Function>} */
const listeners = [];
let hydrated = false;

/**
 * @typedef {{
 *  id: string,
 *  createdAt: number,
 *  levelId: string,
 *  groupId: string,
 *  status: string,
 *  priceDisplay: string,
 *  phase: 'queued'|'uploading'|'enqueueing'|'done'|'failed',
 *  items: Array<{ path: string, status: 'pending'|'uploading'|'done'|'failed', objectKey?: string, error?: string, retries: number }>,
 *  objectKeys: string[],
 *  proxyBatchId: string,
 *  ossBatchId: string,
 *  mode: 'post'|'proxy'|'',
 *  jobId: string,
 *  productId: string,
 *  error: string,
 *  doneCount: number,
 *  total: number,
 * }} Job
 */

function uid() {
  return `pu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function persist() {
  try {
    const slim = jobs.map((j) => ({
      ...j,
      // 不持久化上传中瞬时态为 uploading，回前台当 pending 重试
      items: (j.items || []).map((it) => ({
        ...it,
        status: it.status === 'uploading' ? 'pending' : it.status,
      })),
      phase: j.phase === 'uploading' || j.phase === 'enqueueing' ? 'queued' : j.phase,
    }));
    wx.setStorageSync(STORAGE_KEY, slim);
  } catch (e) { /* ignore */ }
}

let _leaveGuardOn = false;

function pendingUploadCount(snap) {
  const s = snap || getSnapshot();
  const running = s.running || [];
  let n = 0;
  running.forEach((j) => {
    (j.items || []).forEach((it) => {
      if (it.status === 'pending' || it.status === 'uploading') n += 1;
    });
    // enqueueing 也算未完成建品
    if (j.phase === 'enqueueing') n += Math.max(0, (j.total || 0) - (j.doneCount || 0));
  });
  // 至少显示「还有任务」
  if (!n && running.length) {
    running.forEach((j) => { n += Math.max(1, (j.total || 0) - (j.doneCount || 0)); });
  }
  return n;
}

function leaveWarnMessage(n) {
  const count = Math.max(1, n || 1);
  return `还有 ${count} 张图片在上传，上传完后才能创建出商品，先别退出`;
}

/** 小程序离开前提醒（关闭/部分返回）。网络在后台可能被挂起，仅 best-effort。 */
function syncLeaveGuard(snap) {
  const s = snap || getSnapshot();
  const n = pendingUploadCount(s);
  const need = n > 0 || (s.running && s.running.length > 0);
  try {
    if (need) {
      const msg = leaveWarnMessage(n);
      if (typeof wx.enableAlertBeforeUnload === 'function') {
        wx.enableAlertBeforeUnload({ message: msg });
        _leaveGuardOn = true;
      }
    } else if (_leaveGuardOn && typeof wx.disableAlertBeforeUnload === 'function') {
      wx.disableAlertBeforeUnload();
      _leaveGuardOn = false;
    }
  } catch (e) { /* 低版本无此 API */ }
}

function emit() {
  const snap = getSnapshot();
  syncLeaveGuard(snap);
  listeners.forEach((fn) => {
    try { fn(snap); } catch (e) { /* */ }
  });
  try {
    const app = getApp();
    if (app && app.globalData) app.globalData.publishUpload = snap;
  } catch (e) { /* */ }
}

function getSnapshot() {
  const running = jobs.filter((j) => ['queued', 'uploading', 'enqueueing'].includes(j.phase));
  const totalPending = running.reduce((n, j) => n + j.items.filter((i) => i.status !== 'done').length, 0);
  const totalDone = running.reduce((n, j) => n + j.doneCount, 0);
  const totalAll = running.reduce((n, j) => n + j.total, 0);
  return {
    jobs: jobs.slice(),
    running,
    visible: running.length > 0 || jobs.some((j) => j.phase === 'failed' && Date.now() - j.createdAt < 60 * 1000),
    runningCount: running.length,
    totalPending,
    totalDone,
    totalAll,
    primary: running[0] || jobs.filter((j) => j.phase === 'failed').slice(-1)[0] || null,
  };
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    if (Array.isArray(raw) && raw.length) {
      jobs = raw.filter((j) => j && j.id && Array.isArray(j.items));
      // 清理过久的 done
      const now = Date.now();
      jobs = jobs.filter((j) => {
        if (j.phase === 'done' && now - j.createdAt > 30 * 60 * 1000) return false;
        if (j.phase === 'failed' && now - j.createdAt > 2 * 60 * 60 * 1000) return false;
        return true;
      });
      jobs.forEach((j) => {
        if (j.phase === 'uploading' || j.phase === 'enqueueing') j.phase = 'queued';
        (j.items || []).forEach((it) => {
          if (it.status === 'uploading') it.status = 'pending';
        });
      });
    }
  } catch (e) { /* */ }
  emit();
}

function subscribe(fn) {
  hydrate();
  if (typeof fn === 'function') listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function copyToUserData(srcPath, jobId, index) {
  return new Promise((resolve) => {
    try {
      const fs = wx.getFileSystemManager();
      const ext = (() => {
        const m = String(srcPath).match(/\.[a-zA-Z0-9]+$/);
        return m ? m[0] : '.jpg';
      })();
      const dest = `${wx.env.USER_DATA_PATH}/pub_${jobId}_${index}${ext}`;
      fs.copyFile({
        srcPath,
        destPath: dest,
        success: () => resolve(dest),
        fail: () => resolve(srcPath), // 拷贝失败仍用原临时路径
      });
    } catch (e) {
      resolve(srcPath);
    }
  });
}

/**
 * 启动一个新的发品上传任务（可与已有任务并发）
 * @returns {Promise<{jobId:string}>} 本地 queue job id（非后端 job）
 */
async function startPublishUpload({ localPaths, levelId, groupId, status, priceDisplay }) {
  hydrate();
  const paths = (localPaths || []).filter(Boolean);
  if (!paths.length) throw new Error('请先选图');
  if (!levelId) throw new Error('无商品等级');

  const id = uid();
  const items = [];
  for (let i = 0; i < paths.length; i++) {
    const persisted = await copyToUserData(paths[i], id, i);
    items.push({
      path: persisted,
      status: 'pending',
      objectKey: '',
      error: '',
      retries: 0,
    });
  }

  /** @type {Job} */
  const job = {
    id,
    createdAt: Date.now(),
    levelId,
    groupId: groupId || '',
    status: status || 'on_sale',
    priceDisplay: priceDisplay || 'show',
    phase: 'queued',
    items,
    objectKeys: [],
    proxyBatchId: '',
    ossBatchId: id.replace(/^pu_/, 'b').slice(0, 32),
    mode: '',
    jobId: '',
    productId: '',
    error: '',
    doneCount: 0,
    total: items.length,
  };
  jobs.unshift(job);
  // 限制历史：done 只留最近几个
  const done = jobs.filter((j) => j.phase === 'done');
  if (done.length > 5) {
    const drop = new Set(done.slice(5).map((j) => j.id));
    jobs = jobs.filter((j) => !drop.has(j.id));
  }
  persist();
  emit();

  try { await requestJobSubscribe(); } catch (e) { /* */ }

  pump();
  return { queueJobId: id };
}

function recompute(job) {
  job.doneCount = job.items.filter((i) => i.status === 'done').length;
  job.total = job.items.length;
}

async function uploadOneItem(job, item, cred) {
  item.status = 'uploading';
  emit();
  try {
    if (job.mode === 'post' && cred) {
      const r = await uploadFileToOss(cred, item.path);
      item.objectKey = r.objectKey;
      item.status = 'done';
      item.error = '';
      if (!job.objectKeys.includes(r.objectKey)) job.objectKeys.push(r.objectKey);
    } else {
      const r = await uploadFileViaProxy(item.path, job.proxyBatchId || undefined);
      job.proxyBatchId = r.batchId || job.proxyBatchId;
      // proxy 路径没有 per-file objectKey；标记 done，入队走 batch enqueue
      item.status = 'done';
      item.error = '';
      item.objectKey = item.objectKey || `proxy:${job.proxyBatchId}:${item.path}`;
    }
  } catch (e) {
    item.status = 'failed';
    item.error = String((e && e.message) || e).slice(0, 80);
    item.retries = (item.retries || 0) + 1;
  }
  recompute(job);
  persist();
  emit();
}

async function runJob(job) {
  if (!job || job.phase === 'done') return;
  if (job.phase === 'failed' && !job.items.some((i) => i.status === 'pending' || i.status === 'failed')) return;

  job.phase = 'uploading';
  job.error = '';
  emit();

  // 重置可重试的 failed → pending（手动 resume / 回前台）
  job.items.forEach((it) => {
    if (it.status === 'failed' && (it.retries || 0) < 5) {
      it.status = 'pending';
      it.error = '';
    }
  });

  // 探测模式（仅首次）
  if (!job.mode) {
    try {
      const pendingCount = job.items.filter((i) => i.status === 'pending').length || 1;
      const creds = await fetchCredentials({
        count: Math.min(pendingCount, 9),
        purpose: 'uploads',
        batchId: job.ossBatchId,
        mimeType: 'image/jpeg',
      });
      job.mode = creds.mode === 'post' ? 'post' : 'proxy';
      job._credPool = Array.isArray(creds.items) ? creds.items.slice() : [];
      if (creds.batchId) job.ossBatchId = creds.batchId;
    } catch (e) {
      job.mode = 'proxy';
      job._credPool = [];
    }
  }

  // 并发上传 pending
  const pending = () => job.items.filter((i) => i.status === 'pending');
  while (pending().length) {
    const batch = pending().slice(0, MAX_CONCURRENT_FILES);
    // 补凭证
    if (job.mode === 'post') {
      const need = batch.length - (job._credPool || []).length;
      if (need > 0) {
        try {
          const more = await fetchCredentials({
            count: need,
            purpose: 'uploads',
            batchId: job.ossBatchId,
          });
          job._credPool = (job._credPool || []).concat(more.items || []);
          job.mode = more.mode === 'post' ? 'post' : 'proxy';
        } catch (e) {
          job.mode = 'proxy';
        }
      }
    }
    await Promise.all(
      batch.map((item) => {
        const cred = job.mode === 'post' ? (job._credPool || []).shift() : null;
        return uploadOneItem(job, item, cred);
      }),
    );
  }

  const failed = job.items.filter((i) => i.status === 'failed');
  const doneItems = job.items.filter((i) => i.status === 'done');
  if (!doneItems.length) {
    job.phase = 'failed';
    job.error = failed[0]?.error || '全部上传失败';
    persist();
    emit();
    wx.showToast({ title: String(job.error).slice(0, 40), icon: 'none' });
    return;
  }
  if (failed.length) {
    // 部分失败：先用成功的入队，失败项留在 job 上可再点重试；但产品要求独立 batch 入队一次
    // 策略：成功图先 enqueue；失败的拆成提示，用户可在 float 点重试剩余（新子任务）
  }

  job.phase = 'enqueueing';
  emit();

  try {
    let result;
    if (job.mode === 'post') {
      const keys = job.objectKeys.filter(Boolean);
      if (!keys.length) throw new Error('无已上传对象');
      result = await request({
        url: '/api/products/publish/from-oss',
        method: 'POST',
        data: {
          objectKeys: keys,
          levelId: job.levelId,
          groupId: job.groupId || undefined,
          status: job.status || 'on_sale',
          priceDisplay: job.priceDisplay,
        },
      });
    } else {
      if (!job.proxyBatchId) throw new Error('中转上传未返回 batchId');
      result = await request({
        url: `/api/products/publish/${job.proxyBatchId}/enqueue`,
        method: 'POST',
        data: {
          levelId: job.levelId,
          groupId: job.groupId || undefined,
          status: job.status || 'on_sale',
          priceDisplay: job.priceDisplay,
        },
      });
    }
    job.jobId = result.jobId || (result.job && result.job.id) || '';
    job.productId = result.productId || '';
    if (!job.jobId) throw new Error('入队未返回 jobId');
    job.phase = 'done';
    job.error = '';
    persist();
    emit();

    const title = job.productId ? '已开始建品' : '已入队';
    wx.showToast({ title, icon: 'success', duration: 2000 });

    // 部分失败：自动再开一个独立 queue job 仅传失败图（多 batch 并发）
    if (failed.length) {
      const left = failed.map((f) => f.path).filter(Boolean);
      setTimeout(() => {
        wx.showToast({ title: `${failed.length} 张失败，已加入重试队列`, icon: 'none' });
        startPublishUpload({
          localPaths: left,
          levelId: job.levelId,
          groupId: job.groupId,
          status: job.status || 'on_sale',
          priceDisplay: job.priceDisplay,
        }).catch(() => {});
      }, 600);
    }
  } catch (e) {
    job.phase = 'failed';
    job.error = String((e && e.message) || e).slice(0, 80);
    persist();
    emit();
    wx.showToast({ title: job.error.slice(0, 40), icon: 'none' });
  }
}

const _runningJobIds = new Set();

async function pump() {
  hydrate();
  // 尽量填满并发槽；每个 job 独立跑完后回调再 pump
  while (true) {
    const activeUploading = _runningJobIds.size;
    if (activeUploading >= MAX_ACTIVE_JOBS) break;
    const next = jobs.find(
      (j) =>
        !_runningJobIds.has(j.id) &&
        (j.phase === 'queued' ||
          (j.phase === 'failed' && j.items.some((i) => i.status === 'pending'))),
    );
    if (!next) break;
    if (next.phase === 'failed') next.phase = 'queued';
    _runningJobIds.add(next.id);
    // 并发：不 await 全部，各自完成后再调度
    Promise.resolve()
      .then(() => runJob(next))
      .catch((e) => {
        next.phase = 'failed';
        next.error = String((e && e.message) || e).slice(0, 80);
        persist();
        emit();
      })
      .finally(() => {
        _runningJobIds.delete(next.id);
        setTimeout(() => pump(), 30);
      });
  }
}

/** 回前台 / 锁屏恢复：把中断的任务重新排队 */
function resumeAll() {
  hydrate();
  let changed = false;
  jobs.forEach((j) => {
    if (j.phase === 'done') return;
    j.items.forEach((it) => {
      if (it.status === 'uploading') {
        it.status = 'pending';
        changed = true;
      }
      // 失败且重试次数未超：回前台再试
      if (it.status === 'failed' && (it.retries || 0) < 5) {
        it.status = 'pending';
        changed = true;
      }
    });
    if (j.phase === 'uploading' || j.phase === 'enqueueing' || j.phase === 'failed') {
      if (j.items.some((i) => i.status === 'pending')) {
        j.phase = 'queued';
        j.error = '';
        changed = true;
      }
    }
  });
  if (changed) {
    persist();
    emit();
  }
  pump();
}

function retryJob(queueJobId) {
  const job = jobs.find((j) => j.id === queueJobId);
  if (!job) return;
  job.items.forEach((it) => {
    if (it.status === 'failed') {
      it.status = 'pending';
      it.error = '';
    }
  });
  // 若已 enqueue 成功则不要重入队；仅补传失败图时开新任务更清晰
  if (job.phase === 'done') {
    const failedPaths = job.items.filter((i) => i.status === 'pending').map((i) => i.path);
    if (failedPaths.length) {
      startPublishUpload({
        localPaths: failedPaths,
        levelId: job.levelId,
        groupId: job.groupId,
        status: job.status || 'on_sale',
        priceDisplay: job.priceDisplay,
      });
    }
    return;
  }
  job.phase = 'queued';
  job.error = '';
  // 已成功的 objectKeys 保留，pending 会再传
  persist();
  emit();
  pump();
}

function dismissJob(queueJobId) {
  jobs = jobs.filter((j) => j.id !== queueJobId);
  persist();
  emit();
}

function openResult(job) {
  if (!job) return;
  if (job.productId) {
    wx.navigateTo({ url: `/pages/product/edit/edit?id=${job.productId}` });
    return;
  }
  if (job.jobId) {
    wx.switchTab({ url: '/pages/jobs/list/list' });
    return;
  }
  wx.switchTab({ url: '/pages/jobs/list/list' });
}

module.exports = {
  startPublishUpload,
  subscribe,
  getSnapshot,
  resumeAll,
  retryJob,
  dismissJob,
  openResult,
  hydrate,
  pump,
  pendingUploadCount,
  leaveWarnMessage,
  syncLeaveGuard,
};
