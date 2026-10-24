const { request } = require('../../../utils/request');
const { saveUrlsToAlbum, saveVideoUrlsToAlbum } = require('../../../utils/saveAlbum');
const { requestJobSubscribe } = require('../../../utils/profile');
const { uploadOneMedia } = require('../../../utils/oss-direct');

const STYLE_REF_MAX = 4;
const STYLE_REF_MAX_BYTES = 5 * 1024 * 1024;
const STYLE_STRENGTH_OPTS = [
  { id: 'weak', name: '弱' },
  { id: 'medium', name: '中' },
  { id: 'strong', name: '强' },
];

const STEP_NAMES = {
  reference: '选参考图', colors: '选颜色', feature: '商品特征', script: '分镜脚本', model: '选模特',
  pose: '动作 / 呈现', scene: '场景 / 背景', pose_scene: '姿势与场景',
  style_keywords: '风格关键词', count: '张数与尺寸',
};

function matchPreset(options, text) {
  const t = String(text || '').trim();
  if (!t || !options || !options.length) return null;
  return options.find((o) => o.name === t || o.id === t)
    || options.find((o) => t.indexOf(o.name) >= 0 || o.name.indexOf(t) >= 0)
    || null;
}


Page({
  data: {
    id: '', mediaKind: 'image', loading: true,
    templates: [], models: [], tpl: null,
    steps: [], stepIdx: -1, stepKey: '', stepNames: STEP_NAMES,
    assets: [], colors: [], feature: '', featureDirty: false,
    sellingPoint: '',
    script: '', scriptSeconds: 10, scriptVia: '', scriptLoading: false, scriptDirty: false,
    sel: { refs: [], colors: [], modelId: '', poses: [], scenes: [], poseText: '', sceneText: '', count: 1, sizeId: '' },
    // 风格样例（可选，不进商品图库）：{ objectKey, url, uploading? }
    styleRefs: [],
    styleStrength: 'medium',
    styleStrengthOpts: STYLE_STRENGTH_OPTS,
    styleRefMax: STYLE_REF_MAX,
    styleUploading: false,
    styleKeywords: { scene: '', hasPerson: null, personVibe: '', shotType: '', mood: '', background: '', keywords: [], promptZh: '', suggestedModelId: null },
    styleKeywordsText: '',
    styleAnalyzing: false,
    styleKeywordChips: [],
    job: null, submitting: false, saving: false, singlePoseScene: false,
    voiceTarget: '', voiceListening: false, voiceHint: '按住说话',
    savingAlbum: false, albumSelectedCount: 0, albumAllSelected: false, albumSaveLabel: '保存到相册',
  },

  async onLoad(q) {
    const mediaKind = (q.type === 'video' || q.kind === 'video') ? 'video' : 'image';
    this.setData({ id: q.id, mediaKind });
    try {
      const [p, s] = await Promise.all([
        request({ url: '/api/promo/presets' }),
        request({ url: `/api/products/${q.id}/promo/start`, method: 'POST', data: {} }),
      ]);
      const templates = mediaKind === 'video'
        ? (p.videoTemplates || []).concat((p.templates || []).filter((t) => t.mediaKind === 'video' || t.id === 'product_showcase_video'))
        : (p.templates || []).filter((t) => t.mediaKind !== 'video' && t.id !== 'product_showcase_video');
      // 去重
      const seen = {};
      const uniq = [];
      templates.forEach((t) => { if (t && t.id && !seen[t.id]) { seen[t.id] = 1; uniq.push(t); } });
      this.setData({
        templates: uniq, models: p.models,
        assets: s.assets.map((a) => Object.assign(a, { checked: false })),
        colors: s.colors.map((c) => ({ name: c, checked: false })),
        feature: s.feature, product: s.product, loading: false,
      });
      if (mediaKind === 'video') {
        if (!s.videoConfigured && !s.configured) {
          wx.showToast({ title: '服务端未配置视频密钥', icon: 'none' });
        }
        // MVP：自动选中唯一视频模板，跳过选模板页
        const vt = uniq[0];
        if (vt) {
          this.pickTemplate({ currentTarget: { dataset: { id: vt.id } } });
        }
      } else if (!s.configured) {
        wx.showToast({ title: '服务端未配置生图密钥', icon: 'none' });
      }
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },
  onUnload() {
    clearTimeout(this.timer);
    this._stopVoice();
  },

  // ---- 模板 ----
  pickTemplate(e) {
    const tpl = this.data.templates.find((t) => t.id === e.currentTarget.dataset.id);
    const steps = tpl.steps.filter((s) => !(s === 'model' && tpl.model === 'none'));
    const singlePoseScene = tpl.id === 'multi_color';
    this.setData({
      tpl, steps, stepIdx: 0, stepKey: steps[0], job: null,
      singlePoseScene,
      sel: {
        refs: [], colors: [], modelId: tpl.model === 'required' ? (this.data.models[0] || {}).id : '',
        poses: tpl.poses.length ? [tpl.poses[0].id] : [], scenes: tpl.scenes.length ? [tpl.scenes[0].id] : [],
        poseText: '', sceneText: '',
        count: tpl.count.default, sizeId: tpl.defaultSize,
      },
      styleRefs: [],
      styleStrength: 'medium',
      styleUploading: false,
      styleKeywords: { scene: '', hasPerson: null, personVibe: '', shotType: '', mood: '', background: '', keywords: [], promptZh: '', suggestedModelId: null },
      styleKeywordsText: '',
      styleAnalyzing: false,
      styleKeywordChips: [],
      assets: this.data.assets.map((a) => Object.assign(a, { checked: false })),
      colors: this.data.colors.map((c) => Object.assign(c, { checked: false })),
    });
    this.refreshOptionFlags();
  },
  backToTemplates() { this.setData({ tpl: null, stepIdx: -1, stepKey: '', job: null }); },

  // ---- 步骤 ----
  prev() {
    if (this.data.stepIdx <= 0) return this.backToTemplates();
    const i = this.data.stepIdx - 1;
    this.setData({ stepIdx: i, stepKey: this.data.steps[i] });
  },
  async next() {
    const err = this.validate(this.data.stepKey);
    if (err) return wx.showToast({ title: err, icon: 'none' });
    if (this.data.stepKey === 'feature' && this.data.featureDirty) {
      try {
        await request({ url: `/api/products/${this.data.id}/promo/feature`, method: 'PUT', data: { feature: this.data.feature } });
        this.setData({ featureDirty: false });
      } catch (e) { wx.showToast({ title: '特征保存失败', icon: 'none' }); }
    }
    const leavingRef = this.data.stepKey === 'reference';
    const leavingFeature = this.data.stepKey === 'feature';
    const tpl = this.data.tpl || {};
    const needAnalyze = leavingRef && (tpl.id === 'style_ref' || (tpl.styleRef && tpl.styleRef.min > 0));
    if (this.data.stepIdx >= this.data.steps.length - 1) return this.submit();
    const i = this.data.stepIdx + 1;
    const nextKey = this.data.steps[i];
    this.setData({ stepIdx: i, stepKey: nextKey });
    if (needAnalyze && nextKey === 'style_keywords') {
      this.analyzeStyleRefs();
    }
    if (this.data.mediaKind === 'video' && nextKey === 'script' && (leavingFeature || leavingRef) && !this.data.scriptDirty) {
      this.draftVideoScript();
    }
  },
  validate(k) {
    const { tpl, sel } = this.data;
    if (k === 'reference' && (sel.refs.length < tpl.reference.min || sel.refs.length > tpl.reference.max)) {
      return `请选择 ${tpl.reference.min}-${tpl.reference.max} 张参考图`;
    }
    if (k === 'reference') {
      const styleMin = (tpl.styleRef && tpl.styleRef.min) || 0;
      const styleReady = (this.data.styleRefs || []).filter((x) => x && x.objectKey && !x.uploading);
      if (styleMin > 0 && styleReady.length < styleMin) {
        return `请至少上传 ${styleMin} 张风格样例`;
      }
      if (this.data.styleUploading || (this.data.styleRefs || []).some((x) => x.uploading)) {
        return '风格样例上传中…';
      }
    }
    if (k === 'colors') {
      if (tpl.id === 'multi_color') {
        if (sel.colors.length < 2) return '多色展示至少选 2 个颜色';
        if (sel.colors.length !== sel.refs.length) {
          return `已选 ${sel.refs.length} 张图，请选同样数量的颜色（按顺序对应）`;
        }
      } else if (sel.colors.length && sel.colors.length !== sel.refs.length) {
        return `已选 ${sel.refs.length} 张图，请选同样数量的颜色（按顺序对应）`;
      }
    }
    if (k === 'script') {
      if (this.data.scriptLoading) return '脚本生成中…';
      if (!(this.data.script || '').trim()) return '请先生成或填写分镜脚本';
    }
    if (k === 'model' && tpl.model === 'required' && !sel.modelId) return '请选择模特';
    if (k === 'pose' && tpl.poses.length && !sel.poses.length && !sel.poseText) return '请选择动作或填写描述';
    if (k === 'scene' && tpl.scenes.length && !sel.scenes.length && !sel.sceneText) return '请选择场景或填写描述';
    if (k === 'pose_scene') {
      const needPose = tpl.poses && tpl.poses.length;
      const needScene = tpl.scenes && tpl.scenes.length;
      if (needPose && !sel.poses.length && !(sel.poseText || '').trim()) return '请选择姿势或填写描述';
      if (needScene && !sel.scenes.length && !(sel.sceneText || '').trim()) return '请选择场景或填写描述';
    }
    return '';
  },

  toggleRef(e) {
    const id = e.currentTarget.dataset.id;
    let refs = this.data.sel.refs.slice();
    const i = refs.indexOf(id);
    if (i >= 0) refs.splice(i, 1);
    else {
      if (refs.length >= this.data.tpl.reference.max) return wx.showToast({ title: `最多 ${this.data.tpl.reference.max} 张`, icon: 'none' });
      refs.push(id);
    }
    this.setData({
      'sel.refs': refs,
      assets: this.data.assets.map((a) => Object.assign(a, { checked: refs.indexOf(a.id) >= 0, order: refs.indexOf(a.id) + 1 })),
    });
  },
  previewAsset(e) {
    wx.previewImage({ urls: [e.currentTarget.dataset.url] });
  },

  /** 风格样例：选图并上传（不进 coverMediaIds / 商品轮播） */
  addStyleRef() {
    if (this.data.styleUploading) return;
    const max = ((this.data.tpl && this.data.tpl.styleRef && this.data.tpl.styleRef.max) || STYLE_REF_MAX);
    const have = (this.data.styleRefs || []).length;
    if (have >= max) {
      return wx.showToast({ title: `最多 ${max} 张`, icon: 'none' });
    }
    const remain = max - have;
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: async (res) => {
        const files = (res.tempFiles || []).filter(Boolean);
        if (!files.length) return;
        const accepted = [];
        for (const f of files) {
          const p = String(f.tempFilePath || '').toLowerCase();
          if (p.endsWith('.gif') || p.endsWith('.heic') || p.endsWith('.heif') || p.endsWith('.bmp')) {
            wx.showToast({ title: '仅支持 jpg/png/webp', icon: 'none' });
            continue;
          }
          if (f.size && f.size > STYLE_REF_MAX_BYTES) {
            wx.showToast({ title: '单张不超过 5MB', icon: 'none' });
            continue;
          }
          accepted.push(f);
        }
        if (!accepted.length) return;
        const room = max - (this.data.styleRefs || []).length;
        const batch = accepted.slice(0, room);
        if (accepted.length > room) {
          wx.showToast({ title: `最多 ${max} 张`, icon: 'none' });
        }
        this.setData({ styleUploading: true });
        try {
          for (const f of batch) {
            const localUrl = f.tempFilePath;
            // 先占位，上传成功后换 objectKey
            const placeholder = { objectKey: '', url: localUrl, uploading: true };
            const next = (this.data.styleRefs || []).concat([placeholder]);
            this.setData({ styleRefs: next });
            try {
              const up = await uploadOneMedia(localUrl, {
                purpose: 'promo_style_ref',
                productId: this.data.id,
              });
              const objectKey = up.objectKey || (up.items && up.items[0] && up.items[0].objectKey) || '';
              const url = up.url || up.publicUrl || localUrl;
              if (!objectKey) throw new Error('未返回 objectKey');
              const list = (this.data.styleRefs || []).slice();
              // 替换最后一个 uploading 占位
              for (let i = list.length - 1; i >= 0; i--) {
                if (list[i].uploading && list[i].url === localUrl) {
                  list[i] = { objectKey, url, uploading: false };
                  break;
                }
              }
              this.setData({ styleRefs: list });
            } catch (e) {
              const list = (this.data.styleRefs || []).filter((x) => !(x.uploading && x.url === localUrl));
              this.setData({ styleRefs: list });
              wx.showToast({ title: (e && e.message) || '风格图上传失败', icon: 'none' });
            }
          }
        } finally {
          this.setData({ styleUploading: false });
        }
      },
    });
  },
  removeStyleRef(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const list = (this.data.styleRefs || []).slice();
    if (idx < 0 || idx >= list.length) return;
    list.splice(idx, 1);
    this.setData({ styleRefs: list });
  },
  previewStyleRef(e) {
    const urls = (this.data.styleRefs || []).map((x) => x.url).filter(Boolean);
    const current = e.currentTarget.dataset.url || urls[0];
    if (!urls.length) return;
    wx.previewImage({ urls, current });
  },
  pickStyleStrength(e) {
    const id = e.currentTarget.dataset.id;
    if (id !== 'weak' && id !== 'medium' && id !== 'strong') return;
    this.setData({ styleStrength: id });
  },

  toggleColor(e) {
    const name = e.currentTarget.dataset.name;
    let cs = this.data.sel.colors.slice();
    const i = cs.indexOf(name);
    if (i >= 0) cs.splice(i, 1); else cs.push(name);
    this.setData({ 'sel.colors': cs, colors: this.data.colors.map((c) => Object.assign(c, { checked: cs.indexOf(c.name) >= 0 })) });
  },
  onFeature(e) { this.setData({ feature: e.detail.value, featureDirty: true }); },
  onSellingPoint(e) { this.setData({ sellingPoint: e.detail.value }); },
  onScript(e) { this.setData({ script: e.detail.value, scriptDirty: true }); },
  /** mode: heuristic（默认即时）| polish（可选润色，慢） */
  async draftVideoScript(opts) {
    if (this.data.scriptLoading) return;
    const mode = (opts && opts.mode === 'polish') ? 'polish' : 'heuristic';
    this.setData({ scriptLoading: true });
    try {
      const r = await request({
        url: `/api/products/${this.data.id}/promo/video-script`,
        method: 'POST',
        data: {
          feature: this.data.feature,
          sellingPoint: this.data.sellingPoint || undefined,
          referenceAssetIds: (this.data.sel && this.data.sel.refs) || [],
          seconds: this.data.scriptSeconds || 10,
          mode,
        },
      });
      this.setData({
        script: r.script || '',
        scriptSeconds: r.seconds || 10,
        scriptVia: r.via || '',
        scriptDirty: false,
        scriptLoading: false,
      });
    } catch (e) {
      this.setData({ scriptLoading: false });
      wx.showToast({ title: (e && e.message) || '脚本生成失败', icon: 'none' });
    }
  },
  /** 规则草稿：进入脚本步默认调用，即时 */
  refreshScript() { this.setData({ scriptDirty: false }); this.draftVideoScript({ mode: 'heuristic' }); },
  /** 可选润色：调 VISION LLM */
  polishScript() { this.setData({ scriptDirty: false }); this.draftVideoScript({ mode: 'polish' }); },
  pickModel(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ 'sel.modelId': this.data.sel.modelId === id && this.data.tpl.model !== 'required' ? '' : id });
  },
  toggleMulti(e) {
    const { kind, id } = e.currentTarget.dataset; // kind = poses | scenes
    const tpl = this.data.tpl || {};
    const opts = kind === 'poses' ? (tpl.poses || []) : (tpl.scenes || []);
    const opt = opts.find((o) => o.id === id);
    const fillText = () => {
      // 预设作为快捷填入：写入对应自由文本框（可再改）
      if (!opt) return {};
      if (kind === 'poses') return { 'sel.poseText': opt.name };
      return { 'sel.sceneText': opt.name };
    };
    // multi_color 或单选合并步：姿态/场景单选（整组共用）
    if (this.data.singlePoseScene || (tpl && tpl.id === 'multi_color') || this.data.stepKey === 'pose_scene') {
      // pose_scene 下姿势仍可多选（非 multi_color）；multi_color 强制单选
      const forceSingle = this.data.singlePoseScene || (tpl && tpl.id === 'multi_color');
      if (forceSingle || this.data.stepKey === 'pose_scene') {
        if (forceSingle) {
          this.setData(Object.assign({ [`sel.${kind}`]: [id] }, fillText()));
          this.refreshOptionFlags();
          return;
        }
      }
    }
    let arr = this.data.sel[kind].slice();
    const i = arr.indexOf(id);
    if (i >= 0) { if (arr.length > 1) arr.splice(i, 1); } else arr.push(id);
    const patch = { [`sel.${kind}`]: arr };
    // 点选预设时把名称填进文本框作起点（用户可继续改成完整描述）
    if (opt && i < 0) Object.assign(patch, fillText());
    this.setData(patch);
    this.refreshOptionFlags();
  },
  refreshOptionFlags() {
    const { tpl, sel } = this.data;
    if (!tpl) return;
    this.setData({
      poseOpts: tpl.poses.map((o) => Object.assign({}, o, { on: sel.poses.indexOf(o.id) >= 0 })),
      sceneOpts: tpl.scenes.map((o) => Object.assign({}, o, { on: sel.scenes.indexOf(o.id) >= 0 })),
    });
  },
  onPoseText(e) { this.setData({ 'sel.poseText': e.detail.value }); },
  onSceneText(e) { this.setData({ 'sel.sceneText': e.detail.value }); },

  /** 按住说话：优先 WechatSI 语音识别；未开通插件则提示打字 */
  _ensureVoice() {
    if (this._voiceReady) return this._voiceReady;
    try {
      const plugin = requirePlugin('WechatSI');
      const manager = plugin.getRecordRecognitionManager();
      manager.onStart = () => this.setData({ voiceListening: true, voiceHint: '松手结束' });
      manager.onStop = (res) => {
        const result = (res && res.result) || '';
        this.setData({ voiceListening: false, voiceHint: '按住说话' });
        if (!result) {
          wx.showToast({ title: '没听清，请再说或打字', icon: 'none' });
          return;
        }
        this._applyVoiceResult(result);
      };
      manager.onError = () => {
        this.setData({ voiceListening: false, voiceHint: '按住说话' });
        wx.showToast({ title: '语音识别失败，请打字', icon: 'none' });
      };
      this._voiceMgr = manager;
      this._voiceReady = true;
    } catch (e) {
      this._voiceReady = false;
    }
    return this._voiceReady;
  },
  _applyVoiceResult(result) {
    const target = this.data.voiceTarget || 'pose';
    const tpl = this.data.tpl || {};
    if (target === 'pose') {
      const hit = matchPreset(tpl.poses || [], result);
      const patch = { 'sel.poseText': result };
      if (hit) patch['sel.poses'] = [hit.id];
      this.setData(patch);
      this.refreshOptionFlags();
    } else {
      const hit = matchPreset(tpl.scenes || [], result);
      const patch = { 'sel.sceneText': result };
      if (hit) patch['sel.scenes'] = [hit.id];
      this.setData(patch);
      this.refreshOptionFlags();
    }
    wx.showToast({ title: '已填入：' + String(result).slice(0, 12), icon: 'none' });
  },
  _stopVoice() {
    try { if (this._voiceMgr) this._voiceMgr.stop(); } catch (e) { /* ignore */ }
    this.setData({ voiceListening: false, voiceHint: '按住说话' });
  },
  onVoiceStart(e) {
    const target = (e.currentTarget.dataset && e.currentTarget.dataset.target) || 'pose';
    this.setData({ voiceTarget: target });
    if (!this._ensureVoice()) {
      wx.showToast({ title: '未开通语音插件，请直接打字', icon: 'none' });
      return;
    }
    try {
      this._voiceMgr.start({ duration: 15000, lang: 'zh_CN' });
    } catch (err) {
      wx.showToast({ title: '无法开始录音', icon: 'none' });
    }
  },
  onVoiceEnd() { this._stopVoice(); },
  onVoiceCancel() { this._stopVoice(); },

  countMinus() { if (this.data.sel.count > this.data.tpl.count.min) this.setData({ 'sel.count': this.data.sel.count - 1 }); },
  countPlus() { if (this.data.sel.count < this.data.tpl.count.max) this.setData({ 'sel.count': this.data.sel.count + 1 }); },
  pickSize(e) { this.setData({ 'sel.sizeId': e.currentTarget.dataset.id }); },

  async analyzeStyleRefs() {
    const keys = (this.data.styleRefs || []).map((x) => x && x.objectKey).filter(Boolean);
    if (!keys.length) {
      this.setData({
        styleKeywordsText: '',
        styleKeywordChips: [],
        styleAnalyzing: false,
      });
      return;
    }
    this.setData({ styleAnalyzing: true });
    try {
      const r = await request({
        url: `/api/products/${this.data.id}/promo/analyze-style-refs`,
        method: 'POST',
        data: { styleRefObjectKeys: keys },
      });
      const chips = [];
      if (r.scene) chips.push(r.scene);
      if (r.hasPerson === true) chips.push('有模特');
      if (r.hasPerson === false) chips.push('无人');
      if (r.personVibe) chips.push(r.personVibe);
      if (r.shotType) chips.push(r.shotType);
      if (r.mood) chips.push(r.mood);
      if (r.background) chips.push(r.background);
      (r.keywords || []).forEach((k) => { if (k && chips.indexOf(k) < 0) chips.push(k); });
      const patch = {
        styleKeywords: {
          scene: r.scene || '',
          hasPerson: r.hasPerson == null ? null : !!r.hasPerson,
          personVibe: r.personVibe || '',
          shotType: r.shotType || '',
          mood: r.mood || '',
          background: r.background || '',
          keywords: r.keywords || [],
          promptZh: r.promptZh || '',
          suggestedModelId: r.suggestedModelId || null,
        },
        styleKeywordsText: r.promptZh || chips.join('；'),
        styleKeywordChips: chips,
        styleAnalyzing: false,
      };
      // 若分析认为有人且未选手模，预填建议模特（可改）
      if (r.suggestedModelId && !(this.data.sel && this.data.sel.modelId)) {
        patch['sel.modelId'] = r.suggestedModelId;
      }
      this.setData(patch);
      if (!(r.analyzed || r.via === 'llm')) {
        wx.showToast({ title: '未识别出关键词，可手填或直接生成', icon: 'none' });
      }
    } catch (e) {
      this.setData({ styleAnalyzing: false });
      wx.showToast({ title: (e && e.message) || '分析失败，可手填关键词', icon: 'none' });
    }
  },
  onStyleKeywordsText(e) {
    this.setData({ styleKeywordsText: e.detail.value });
  },
  toggleStyleChip(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    let text = String(this.data.styleKeywordsText || '');
    const parts = text.split(/[；;、,，]/).map((s) => s.trim()).filter(Boolean);
    const i = parts.indexOf(name);
    if (i >= 0) parts.splice(i, 1);
    else parts.push(name);
    this.setData({ styleKeywordsText: parts.join('；') });
  },
  reAnalyzeStyle() { this.analyzeStyleRefs(); },

  // ---- 提交与进度 ----
  /** 合并轮询结果时保留相册勾选状态 */
  mergeJobAlbumSel(job) {
    const prev = ((this.data.job && this.data.job.items) || []);
    const prevByUrl = {};
    const prevByIdx = {};
    prev.forEach((it, i) => {
      if (it && it.albumSelected) {
        if (it.url) prevByUrl[it.url] = true;
        prevByIdx[i] = true;
      }
    });
    const items = (job.items || []).map((it, i) => Object.assign({}, it, {
      albumSelected: !!(it && it.url && (prevByUrl[it.url] || prevByIdx[i])),
    }));
    return Object.assign({}, job, { items });
  },
  syncAlbumSel(items) {
    const list = items || ((this.data.job && this.data.job.items) || []);
    const withUrl = list.filter((i) => i && i.url);
    const selected = withUrl.filter((i) => i.albumSelected);
    const n = selected.length;
    this.setData({
      albumSelectedCount: n,
      albumAllSelected: withUrl.length > 0 && n === withUrl.length,
      albumSaveLabel: n ? `保存到相册(${n})` : '保存到相册',
    });
  },
  setJobWithAlbum(job) {
    const merged = this.mergeJobAlbumSel(job);
    this.setData({ job: merged });
    this.syncAlbumSel(merged.items);
  },

  async submit() {
    try { await requestJobSubscribe(); } catch (e) { /* ignore */ }
    const { tpl, sel, feature, id } = this.data;
    if (this.data.styleUploading || (this.data.styleRefs || []).some((x) => x.uploading)) {
      return wx.showToast({ title: '风格样例上传中…', icon: 'none' });
    }
    this.setData({ submitting: true });
    try {
      const isMulti = tpl.id === 'multi_color';
      if (isMulti) {
        if (sel.colors.length < 2) {
          wx.showToast({ title: '多色展示至少选 2 个颜色', icon: 'none' });
          return;
        }
        if (sel.colors.length !== sel.refs.length) {
          wx.showToast({ title: '颜色数量需与参考图一致', icon: 'none' });
          return;
        }
        if (!sel.modelId) {
          wx.showToast({ title: '请选择模特', icon: 'none' });
          return;
        }
      }
      const count = isMulti ? sel.colors.length : sel.count;
      let poses = isMulti ? (sel.poses || []).slice(0, 1) : (sel.poses || []).slice();
      let scenes = isMulti ? (sel.scenes || []).slice(0, 1) : (sel.scenes || []).slice();
      const poseText = String(sel.poseText || '').trim();
      const sceneText = String(sel.sceneText || '').trim();
      if (poseText) {
        const hit = matchPreset(tpl.poses || [], poseText);
        if (hit) poses = [hit.id];
      }
      if (sceneText) {
        const hit = matchPreset(tpl.scenes || [], sceneText);
        if (hit) scenes = [hit.id];
      }
      if (isMulti) {
        poses = poses.slice(0, 1);
        scenes = scenes.slice(0, 1);
      }
      const styleRefObjectKeys = (this.data.styleRefs || [])
        .map((x) => x && x.objectKey)
        .filter(Boolean)
        .slice(0, STYLE_REF_MAX);
      const payload = {
        templateId: tpl.id,
        mediaKind: this.data.mediaKind === 'video' ? 'video' : 'image',
        feature, sellingPoint: this.data.sellingPoint || undefined, script: this.data.script || undefined, seconds: this.data.scriptSeconds || undefined, referenceAssetIds: sel.refs,
        modelId: sel.modelId || null, poses, scenes,
        poseText: poseText || undefined,
        sceneText: sceneText || undefined,
        colors: sel.colors, count, sizeId: sel.sizeId,
      };
      const styleAllowed = !!(tpl.styleRef && tpl.styleRef.max > 0);
      if (styleAllowed && this.data.mediaKind !== 'video' && styleRefObjectKeys.length) {
        payload.styleRefObjectKeys = styleRefObjectKeys;
        payload.styleStrength = this.data.styleStrength || (tpl.id === 'style_ref' ? 'strong' : 'medium');
      }
      if (styleAllowed) {
        if (!styleRefObjectKeys.length) {
          wx.showToast({ title: '请上传风格样例', icon: 'none' });
          return;
        }
        const sk = this.data.styleKeywords || {};
        payload.styleKeywords = {
          scene: sk.scene || '',
          hasPerson: sk.hasPerson,
          personVibe: sk.personVibe || '',
          shotType: sk.shotType || '',
          mood: sk.mood || '',
          background: sk.background || '',
          keywords: sk.keywords || [],
          promptZh: this.data.styleKeywordsText || sk.promptZh || '',
          suggestedModelId: sk.suggestedModelId || null,
        };
        payload.styleKeywordsText = this.data.styleKeywordsText || '';
      }
      const job = await request({
        url: `/api/products/${id}/promo/generate`, method: 'POST',
        data: payload,
      });
      // 视频：建单即回素材列表/进度，不等 LKB；图仍可在向导结果页看槽位
      if (this.data.mediaKind === 'video') {
        const setId = (job && (job.setId || (job.payload && job.payload.setId))) || '';
        const q = setId
          ? `/pages/product/promo-gallery/promo-gallery?id=${id}&setId=${setId}`
          : `/pages/product/promo-gallery/promo-gallery?id=${id}`;
        wx.showToast({ title: '已提交，后台生成中', icon: 'none' });
        wx.redirectTo({ url: q });
        return;
      }
      this.setData({
        job: Object.assign({}, job, {
          items: (job.items || []).map((it) => Object.assign({}, it, { albumSelected: false })),
        }),
        stepKey: 'result',
        albumSelectedCount: 0,
        albumAllSelected: false,
      });
      this.poll();
    } catch (e) {
      wx.showToast({ title: e.message || '提交失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
  async poll() {
    clearTimeout(this.timer);
    const j = this.data.job;
    if (!j || ['done', 'failed', 'partial', 'cancelled'].indexOf(j.status) >= 0) return;
    this.timer = setTimeout(async () => {
      try {
        // getJob 已兼容框架 jobId → 进度 / 结果图
        const job = await request({ url: `/api/products/${this.data.id}/promo/jobs/${j.id}` });
        this.setJobWithAlbum(job);
      } catch (e) { /* 继续重试 */ }
      this.poll();
    }, 3500);
  },
  previewResult(e) {
    const urls = this.data.job.items.filter((i) => i.url).map((i) => i.url);
    wx.previewImage({ urls, current: e.currentTarget.dataset.url });
  },
  toggleAlbumItem(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const items = (this.data.job.items || []).slice();
    const it = items[idx];
    if (!it || !it.url) return;
    items[idx] = Object.assign({}, it, { albumSelected: !it.albumSelected });
    this.setData({ 'job.items': items });
    this.syncAlbumSel(items);
  },
  toggleSelectAllAlbum() {
    const items = (this.data.job.items || []).slice();
    const withUrl = items.filter((i) => i && i.url);
    const allOn = withUrl.length > 0 && withUrl.every((i) => i.albumSelected);
    const next = items.map((it) => (it && it.url
      ? Object.assign({}, it, { albumSelected: !allOn })
      : it));
    this.setData({ 'job.items': next });
    this.syncAlbumSel(next);
  },
  async saveToAlbum() {
    if (this.data.savingAlbum) return;
    const urls = ((this.data.job && this.data.job.items) || [])
      .filter((i) => i && i.url && i.albumSelected)
      .map((i) => i.url);
    if (!urls.length) {
      wx.showToast({ title: '请先选择要保存的图片', icon: 'none' });
      return;
    }
    this.setData({ savingAlbum: true });
    wx.showLoading({ title: `保存中 0/${urls.length}`, mask: true });
    try {
      const r = await (this.data.mediaKind === 'video' ? saveVideoUrlsToAlbum : saveUrlsToAlbum)(urls, {
        onProgress(cur, total) {
          wx.showLoading({ title: `保存中 ${cur}/${total}`, mask: true });
        },
      });
      wx.hideLoading();
      const tip = r.fail
        ? `成功 ${r.ok} / 失败 ${r.fail}`
        : `已保存 ${r.ok} 张到相册`;
      wx.showToast({ title: tip, icon: 'none', duration: 2500 });
      if (r.fail && r.errors && r.errors[0]) {
        setTimeout(() => {
          wx.showModal({
            title: '部分保存失败',
            content: r.errors.slice(0, 3).join('\n'),
            showCancel: false,
          });
        }, 400);
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
    } finally {
      this.setData({ savingAlbum: false });
    }
  },
  async saveAll() {
    this.setData({ saving: true });
    try {
      const r = await request({ url: `/api/products/${this.data.id}/promo/jobs/${this.data.job.id}/save`, method: 'POST', data: {} });
      this.setJobWithAlbum(r.job);
      wx.showToast({ title: r.added.length ? `已存入商品 ${r.added.length} 张` : '已全部保存过', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
  copyCaption() {
    const text = (this.data.job && this.data.job.caption) || '';
    if (!text) {
      wx.showToast({ title: '文案生成后可复制', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '文案已复制', icon: 'none' }),
    });
  },
  goGallery() {
    wx.redirectTo({ url: `/pages/product/promo-gallery/promo-gallery?id=${this.data.id}` });
  },
  again() {
    this.setData({
      job: null, stepIdx: 0, stepKey: this.data.steps[0],
      albumSelectedCount: 0, albumAllSelected: false, savingAlbum: false,
    });
  },
});
