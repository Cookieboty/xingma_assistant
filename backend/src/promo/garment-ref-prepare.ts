/**
 * 生图前参考图准备 —— 按品类命名的标准流程。
 *
 * 当前落地：羊毛衫（knitwear）专用标准流程（挂拍/细节/不可用 → 宫格补细节 → 角色标注 → 硬约束 → 拒生）。
 * 鞋子 / 裤子 / 衬衣 等品类另立流程，经 CATEGORY_PREPARE_REGISTRY 扩展；禁止糊成一套泛用逻辑。
 *
 * 羊毛衫流程：
 * 1) 识别商品图类型：挂拍 hang / 细节 detail / 不可用 unusable
 * 2) 细节不够 → 对挂拍切 6/9 宫格，宫格细胞作为补充细节（原图保留，勿简单丢图）
 * 3) 生图 prompt 标明每张参考图角色
 * 4) 读出英文硬约束；非针织成衣 / 读不全 → 拒生
 */
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { VisionClient, VisionContentPart } from '../vision/vision.client';

const log = new Logger('GarmentRefPrepare');

export type GarmentRefKind = 'hang' | 'detail' | 'unusable' | 'grid_cell';

export interface GarmentRefInput {
  localPath: string;
  objectKey?: string;
  assetId?: string;
  filename?: string;
  /** 落库复用：已有异步分析结果 */
  priorKind?: GarmentRefKind;
  priorRoleZh?: string;
  priorRoleEn?: string;
}

/** 商品级异步分析结果（落 products.ref_analysis） */
export interface ProductRefAnalysis {
  analyzedAt: string;
  via: 'vision' | 'heuristic';
  isClothing: boolean;
  completeEnough: boolean;
  detailEnough: boolean;
  hasFullSilhouette?: boolean;
  garmentDescZh: string;
  garmentConstraintEn: string;
  refuseReasonZh?: string;
  assets: Array<{
    assetId: string;
    objectKey?: string;
    kind: GarmentRefKind;
    roleZh: string;
    roleEn: string;
    sortHint: number;
  }>;
}

export function sortHintForKind(kind: GarmentRefKind, roleZh?: string): number {
  if (kind === 'hang') return 0;
  if (kind === 'detail' || kind === 'grid_cell') return 1;
  const zh = roleZh || '';
  if (/场景|模特|上身|街拍/.test(zh)) return 2;
  return 3; // 文档/吊牌等
}

export interface ClassifiedRef {
  localPath: string;
  objectKey?: string;
  assetId?: string;
  kind: GarmentRefKind;
  /** 中文原因/角色 */
  roleZh: string;
  /** 英文角色，写入生图 prompt */
  roleEn: string;
  /** 宫格来源 */
  sourcePath?: string;
  cellIndex?: number;
  grid?: '2x3' | '3x3';
}

export interface GarmentPrepareOk {
  ok: true;
  /** 实际送 IMAGE_GEN 的参考图（含宫格；不含 unusable） */
  refs: ClassifiedRef[];
  /** 分类全量（含 unusable，便于留痕） */
  classified: ClassifiedRef[];
  garmentConstraintEn: string;
  garmentDescZh: string;
  refRolesPromptEn: string;
  refRolesPromptZh: string;
  via: 'vision' | 'heuristic';
  detailSufficiency: 'enough' | 'augmented_grid' | 'borderline';
}

export interface GarmentPrepareRefuse {
  ok: false;
  reasonZh: string;
  reasonEn?: string;
  classified?: ClassifiedRef[];
  via?: 'vision' | 'heuristic';
}

export type GarmentPrepareResult = GarmentPrepareOk | GarmentPrepareRefuse;

function parseJsonLoose(text: string): any {
  const t = (text || '').trim();
  if (!t) throw new Error('空响应');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : t;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`无 JSON: ${t.slice(0, 120)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

function basenameOf(r: GarmentRefInput) {
  return r.filename || path.basename(r.localPath || r.objectKey || '');
}

/** 文件名启发式分类 */
function heuristicKind(name: string): { kind: GarmentRefKind; roleZh: string; roleEn: string } {
  const n = (name || '').toLowerCase();
  if (/尺码|尺寸表|size.?chart|质检|检验报告|lab.?report|吊牌|标签|hangtag|coupon|优惠券|细则/.test(n)) {
    return { kind: 'unusable', roleZh: '文档/吊牌/尺码表（不可用）', roleEn: 'document/hangtag (unusable)' };
  }
  if (/细节|领口|袖口|织纹|detail|close.?up|texture|cuff|neckline/.test(n)) {
    return { kind: 'detail', roleZh: '细节图', roleEn: 'garment detail close-up' };
  }
  if (/主图|封面|平铺|挂拍|全身|半身|main|cover|flat.?lay|hang/.test(n)) {
    return { kind: 'hang', roleZh: '挂拍/平铺主图', roleEn: 'full garment hang or flat-lay shot' };
  }
  if (/场景|模特|上身|街拍|lookbook|\bmodel\b/.test(n) && !/挂拍|平铺|主图/.test(n)) {
    return { kind: 'unusable', roleZh: '场景/模特图（非商品成衣主参考）', roleEn: 'lifestyle/model (not garment master)' };
  }
  // 默认当挂拍候选，后续 vision 再判
  return { kind: 'hang', roleZh: '商品图（待确认）', roleEn: 'product garment reference' };
}

function cutGridCells(
  srcPath: string,
  outDir: string,
  grid: '2x3' | '3x3',
): Array<{ path: string; cellIndex: number }> {
  fs.mkdirSync(outDir, { recursive: true });
  const cols = grid === '3x3' ? 3 : 3;
  const rows = grid === '3x3' ? 3 : 2;
  const script = `
from PIL import Image
import sys, os
im=Image.open(sys.argv[1]).convert('RGB')
w,h=im.size
cols,rows=int(sys.argv[2]),int(sys.argv[3])
out=sys.argv[4]
cw,ch=w//cols,h//rows
# 略重叠，避免切缝丢织纹
ox,oy=max(4,cw//12),max(4,ch//12)
idx=0
for r in range(rows):
  for c in range(cols):
    x0=max(0,c*cw-ox); y0=max(0,r*ch-oy)
    x1=min(w,(c+1)*cw+ox); y1=min(h,(r+1)*ch+oy)
    cell=im.crop((x0,y0,x1,y1))
    # 跳过过暗/近纯色无信息格
    small=cell.resize((32,32))
    px=list(small.getdata())
    avg=sum(sum(p) for p in px)/(3*len(px))
    var=sum((sum(p)/3-avg)**2 for p in px)/len(px)
    if var < 18 and (avg<25 or avg>240):
      idx+=1
      continue
    fp=os.path.join(out, f'grid_{cols}x{rows}_{idx:02d}.jpg')
    cell.save(fp,'JPEG',quality=88)
    print(f'{idx}\\t{fp}')
    idx+=1
`;
  try {
    const out = execFileSync(
      'python3',
      ['-c', script, srcPath, String(cols), String(rows), outDir],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const cells: Array<{ path: string; cellIndex: number }> = [];
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const [i, p] = t.split('\t');
      if (p && fs.existsSync(p)) cells.push({ path: p, cellIndex: Number(i) });
    }
    return cells;
  } catch (e: any) {
    log.warn(`宫格切割失败: ${String(e?.message || e).slice(0, 160)}`);
    return [];
  }
}

interface VisionClassifyItem {
  index: number;
  kind: GarmentRefKind;
  roleZh: string;
  roleEn: string;
}

interface VisionReadResult {
  items: VisionClassifyItem[];
  isClothing: boolean;
  completeEnough: boolean;
  hasFullSilhouette: boolean;
  hasNeckline: boolean;
  hasSleeve: boolean;
  hasTexture: boolean;
  detailEnough: boolean;
  garmentConstraintEn: string;
  garmentDescZh: string;
  refuseReasonZh?: string;
}

async function visionClassifyAndRead(
  vision: VisionClient,
  inputs: GarmentRefInput[],
): Promise<VisionReadResult | null> {
  if (!inputs.length) return null;
  const parts: VisionContentPart[] = [
    {
      type: 'text',
      text: `你是「羊毛衫」档口电商生图助手（本流程仅针对针织羊毛衫/毛衣/羊绒衫，不是泛服装）。下面共 ${inputs.length} 张商品参考图（index 0..${inputs.length - 1}）。
任务（羊毛衫专用）：
1) 给每张图分类 kind：
   - hang：挂拍/平铺/全身或半身，能看出整件（或绝大部分）针织衫轮廓
   - detail：领口/袖口/下摆/绞花织纹/罗纹/辅料等羊毛衫局部细节
   - unusable：非针织成衣（鞋/裤/衬衣/包等）、尺码表、质检报告、吊牌文字、优惠券、纯文字、杂乱一堆看不清单件、严重遮挡
2) 综合全部可用图，判断是否能还原「一件完整羊毛衫」的关键细节（领型、袖长、织法、颜色、版型）。
3) 写出英文硬约束（供 image generation，必须具体：颜色、领型、袖长、版型、织法/绞花/罗纹、口袋等可见细节），以及中文摘要。

只回一行 JSON（无 markdown）：
{"items":[{"index":0,"kind":"hang|detail|unusable","roleZh":"挂拍主图","roleEn":"full knitwear hang shot"}],"isClothing":true,"completeEnough":true,"hasFullSilhouette":true,"hasNeckline":true,"hasSleeve":true,"hasTexture":true,"detailEnough":false,"garmentConstraintEn":"exact ...","garmentDescZh":"米白圆领长袖绞花羊毛衫","refuseReasonZh":null}
规则：
- 非羊毛衫/针织成衣，或一堆图拼不出完整单件 → isClothing=false 或 completeEnough=false，并填 refuseReasonZh（中文原因，点明品类问题）
- detailEnough=true 仅当已有足够羊毛衫细节（领/袖/织纹至少两类清晰）；否则 false（系统会切宫格补细节）
- garmentConstraintEn 用英文短句，列举可见硬细节，勿空泛；强调 knit/wool sweater；不要写姿势/场景
- 不要编造图中看不见的细节；不要按鞋子/裤子/衬衣逻辑描述`,
    },
  ];
  for (let i = 0; i < inputs.length; i++) {
    parts.push({ type: 'text', text: `index=${i} file=${basenameOf(inputs[i])}` });
    parts.push({
      type: 'image_url',
      image_url: { url: vision.fileToDataUrl(inputs[i].localPath) },
    });
  }
  try {
    const content = await vision.chat(parts, { maxTokens: 900, temperature: 0 });
    const parsed = parseJsonLoose(content);
    const itemsRaw = Array.isArray(parsed.items) ? parsed.items : [];
    const items: VisionClassifyItem[] = inputs.map((inp, i) => {
      const hit = itemsRaw.find((x: any) => Number(x.index) === i) || itemsRaw[i];
      const kindRaw = String(hit?.kind || '').toLowerCase();
      const kind: GarmentRefKind =
        kindRaw === 'detail' || kindRaw === 'unusable' || kindRaw === 'hang'
          ? (kindRaw as GarmentRefKind)
          : heuristicKind(basenameOf(inp)).kind;
      const fb = heuristicKind(basenameOf(inp));
      return {
        index: i,
        kind,
        roleZh: String(hit?.roleZh || fb.roleZh).slice(0, 80),
        roleEn: String(hit?.roleEn || fb.roleEn).slice(0, 120),
      };
    });
    return {
      items,
      isClothing: parsed.isClothing !== false,
      completeEnough: parsed.completeEnough !== false,
      hasFullSilhouette: !!parsed.hasFullSilhouette,
      hasNeckline: !!parsed.hasNeckline,
      hasSleeve: !!parsed.hasSleeve,
      hasTexture: !!parsed.hasTexture,
      detailEnough: !!parsed.detailEnough,
      garmentConstraintEn: String(parsed.garmentConstraintEn || '').trim().slice(0, 800),
      garmentDescZh: String(parsed.garmentDescZh || '').trim().slice(0, 200),
      refuseReasonZh: parsed.refuseReasonZh
        ? String(parsed.refuseReasonZh).trim().slice(0, 300)
        : undefined,
    };
  } catch (e: any) {
    log.warn(`vision 分类/读衣失败: ${String(e?.message || e).slice(0, 180)}`);
    return null;
  }
}

function buildRolePrompts(refs: ClassifiedRef[]): { en: string; zh: string } {
  if (!refs.length) return { en: '', zh: '' };
  const enLines = refs.map((r, i) => `Reference image ${i + 1}: ${r.roleEn}.`);
  const zhLines = refs.map((r, i) => `参考图${i + 1}：${r.roleZh}`);
  const en = [
    'REFERENCE IMAGE ROLES (follow strictly):',
    ...enLines,
    'Use hang/full shots for overall silhouette, color and cut; use detail/grid cells for stitch, neckline, cuffs and trims. Do not invent garment features absent from these references.',
  ].join(' ');
  const zh = ['参考图角色：', ...zhLines].join('；');
  return { en, zh };
}

function buildConstraintBlock(en: string): string {
  const body = en || 'Match the knit garment in the garment reference images exactly.';
  return [
    'GARMENT HARD CONSTRAINTS (from reference reading; highest priority):',
    body,
    'Reproduce every listed detail; do not redesign, recolor, or omit visible construction.',
  ].join(' ');
}

/**
 * 羊毛衫专用：准备生图参考图（分类 → 可选宫格补细节 → 角色说明 → 硬约束；失败则拒生）。
 */
export async function prepareGarmentRefs(
  vision: VisionClient | null | undefined,
  inputs: GarmentRefInput[],
  opts?: { workDir?: string; preferGrid?: '2x3' | '3x3'; reuseCached?: boolean; cachedAnalysis?: ProductRefAnalysis | null },
): Promise<GarmentPrepareResult> {
  const existing = (inputs || []).filter((r) => r?.localPath && fs.existsSync(r.localPath));
  if (!existing.length) {
    return { ok: false, reasonZh: '没有可用的商品参考图，无法生图' };
  }

  const allHavePrior = existing.every(
    (inp) => inp.priorKind === 'hang' || inp.priorKind === 'detail' || inp.priorKind === 'unusable',
  );
  const preferReuse = !!opts?.reuseCached && allHavePrior;

  let via: 'vision' | 'heuristic' = 'heuristic';
  let visionRead: VisionReadResult | null = null;
  if (preferReuse) {
    via = 'heuristic'; // 复用落库分类；硬约束可来自 opts.cachedAnalysis
    log.log(`复用落库分类 refs=${existing.length}`);
  } else if (vision?.configured()) {
    visionRead = await visionClassifyAndRead(vision, existing);
    if (visionRead) via = 'vision';
  }

  const classified: ClassifiedRef[] = existing.map((inp, i) => {
    if (preferReuse && inp.priorKind) {
      return {
        localPath: inp.localPath,
        objectKey: inp.objectKey,
        assetId: inp.assetId,
        kind: inp.priorKind,
        roleZh: inp.priorRoleZh || heuristicKind(basenameOf(inp)).roleZh,
        roleEn: inp.priorRoleEn || heuristicKind(basenameOf(inp)).roleEn,
      };
    }
    if (visionRead) {
      const it = visionRead.items[i];
      return {
        localPath: inp.localPath,
        objectKey: inp.objectKey,
        assetId: inp.assetId,
        kind: it.kind,
        roleZh: it.roleZh,
        roleEn: it.roleEn,
      };
    }
    const h = heuristicKind(basenameOf(inp));
    return {
      localPath: inp.localPath,
      objectKey: inp.objectKey,
      assetId: inp.assetId,
      kind: h.kind,
      roleZh: h.roleZh,
      roleEn: h.roleEn,
    };
  });

  const hangs = classified.filter((c) => c.kind === 'hang');
  const details = classified.filter((c) => c.kind === 'detail');
  const unusable = classified.filter((c) => c.kind === 'unusable');

  // 拒生：非衣服 / 读不全
  if (visionRead) {
    if (!visionRead.isClothing) {
      return {
        ok: false,
        reasonZh:
          visionRead.refuseReasonZh ||
          '参考图不像羊毛衫/针织成衣（或为其他品类），已拒绝生图',
        reasonEn: 'References are not recognizable clothing',
        classified,
        via,
      };
    }
    if (!visionRead.completeEnough && hangs.length === 0 && details.length === 0) {
      return {
        ok: false,
        reasonZh:
          visionRead.refuseReasonZh ||
          '参考图无法读出完整衣服（可能是一堆杂图/严重遮挡），已拒绝生图',
        reasonEn: 'Cannot reconstruct a complete garment from references',
        classified,
        via,
      };
    }
    if (!visionRead.completeEnough && !visionRead.hasFullSilhouette && hangs.length === 0) {
      return {
        ok: false,
        reasonZh:
          visionRead.refuseReasonZh ||
          '缺少能看清整件衣服的挂拍/平铺图，且细节不足以还原完整成衣，已拒绝生图',
        reasonEn: 'No full-garment shot and incomplete details',
        classified,
        via,
      };
    }
  } else {
    // 无 vision：若启发式全是 unusable → 拒
    if (hangs.length === 0 && details.length === 0) {
      return {
        ok: false,
        reasonZh:
          unusable.length > 0
            ? `参考图均为不可用类型（${unusable.map((u) => u.roleZh).join('、')}），无法生图`
            : '无法识别可用的成衣参考图，已拒绝生图',
        classified,
        via,
      };
    }
  }

  // 可用原图（挂拍+细节）一律保留 —— 勿简单丢图
  const usable: ClassifiedRef[] = [...hangs, ...details];

  let detailSufficiency: GarmentPrepareOk['detailSufficiency'] = 'enough';
  const cachedDetailEnough = preferReuse ? !!opts?.cachedAnalysis?.detailEnough : false;
  const needGrid =
    (visionRead && !visionRead.detailEnough) ||
    (preferReuse && !cachedDetailEnough && details.length === 0 && hangs.length > 0) ||
    (!visionRead && !preferReuse && details.length === 0 && hangs.length > 0);

  if (needGrid && hangs.length > 0) {
    detailSufficiency = 'augmented_grid';
    const grid: '2x3' | '3x3' = opts?.preferGrid || (visionRead && !visionRead.hasTexture ? '3x3' : '2x3');
    const workDir =
      opts?.workDir ||
      path.join(path.dirname(hangs[0].localPath), `_garment_grid_${Date.now()}`);
    // 对最多 2 张挂拍切宫格，控制 ref 数量
    const hangSources = hangs.slice(0, 2);
    const maxCellsTotal = 6;
    let added = 0;
    for (const src of hangSources) {
      if (added >= maxCellsTotal) break;
      const cells = cutGridCells(src.localPath, path.join(workDir, path.basename(src.localPath, path.extname(src.localPath))), grid);
      // 优先取中间与上排（领口/躯干），两端袖口也保留；截断到名额
      const ordered = cells.slice().sort((a, b) => {
        // 2x3/3x3：中间格优先
        const prefer = [4, 3, 1, 5, 0, 2, 6, 7, 8];
        return prefer.indexOf(a.cellIndex) - prefer.indexOf(b.cellIndex);
      });
      for (const cell of ordered) {
        if (added >= maxCellsTotal) break;
        usable.push({
          localPath: cell.path,
          kind: 'grid_cell',
          roleZh: `挂拍宫格细节#${cell.cellIndex + 1}（${grid}）`,
          roleEn: `grid cell #${cell.cellIndex + 1} cropped from full garment hang shot (${grid}) for stitch/neckline/cuff detail`,
          sourcePath: src.localPath,
          cellIndex: cell.cellIndex,
          grid,
        });
        added += 1;
      }
    }
    log.log(`细节不足，已切宫格补细节 cells=${added} grid=${grid}`);
  } else if (visionRead && !visionRead.detailEnough) {
    detailSufficiency = 'borderline';
  }

  if (!usable.length) {
    return {
      ok: false,
      reasonZh: '分类后无可用成衣参考图，已拒绝生图',
      classified,
      via,
    };
  }

  // 硬约束：vision 英文；复用缓存；否则用占位 + 中文特征由上层 FEATURE 补
  let garmentConstraintEn =
    visionRead?.garmentConstraintEn || String(opts?.cachedAnalysis?.garmentConstraintEn || '').trim();
  let garmentDescZh =
    visionRead?.garmentDescZh || String(opts?.cachedAnalysis?.garmentDescZh || '').trim();
  if (!garmentConstraintEn) {
    garmentConstraintEn =
      'Keep the exact wool/knit sweater from the hang/detail references: same color, neckline, sleeve length, cut, stitch/cable pattern, ribbing and all visible construction details.';
  }
  if (!garmentDescZh) {
    garmentDescZh = usable
      .filter((u) => u.kind !== 'grid_cell')
      .map((u) => u.roleZh)
      .slice(0, 4)
      .join('、');
  }


  // vision 说不够完整但仍有挂拍时：已宫格增强则放行；若仍无轮廓则拒
  if (visionRead && !visionRead.completeEnough && !visionRead.hasFullSilhouette && hangs.length === 0) {
    return {
      ok: false,
      reasonZh: visionRead.refuseReasonZh || '读衣不完整，已拒绝生图',
      classified,
      via,
    };
  }

  const roles = buildRolePrompts(usable);
  return {
    ok: true,
    refs: usable,
    classified,
    garmentConstraintEn: buildConstraintBlock(garmentConstraintEn),
    garmentDescZh,
    refRolesPromptEn: roles.en,
    refRolesPromptZh: roles.zh,
    via,
    detailSufficiency,
  };
}

/** 组装写入生图记录的中文原话（用户输入，不被英文 enrich 覆盖） */
export function buildPromptZh(opts: {
  feature?: string;
  poseText?: string;
  sceneText?: string;
  garmentDescZh?: string;
  refRolesPromptZh?: string;
  extraZh?: string;
}): string {
  const parts: string[] = [];
  if (opts.feature) parts.push(`卖点/特征：${opts.feature}`);
  if (opts.poseText) parts.push(`姿势/呈现：${opts.poseText}`);
  if (opts.sceneText) parts.push(`场景/背景：${opts.sceneText}`);
  if (opts.garmentDescZh) parts.push(`读衣：${opts.garmentDescZh}`);
  if (opts.refRolesPromptZh) parts.push(opts.refRolesPromptZh);
  if (opts.extraZh) parts.push(opts.extraZh);
  return parts.filter(Boolean).join('\n').slice(0, 4000);
}



/**
 * 异步分析专用：对商品图做分类/读衣并返回可落库结构（不切宫格）。
 * 供 media_analyze job 写入 media_assets.meta + products.ref_analysis。
 */
export async function analyzeGarmentImagesForStorage(
  vision: VisionClient | null | undefined,
  inputs: GarmentRefInput[],
): Promise<ProductRefAnalysis> {
  const existing = (inputs || []).filter((r) => r?.localPath && fs.existsSync(r.localPath));
  const analyzedAt = new Date().toISOString();
  if (!existing.length) {
    return {
      analyzedAt,
      via: 'heuristic',
      isClothing: false,
      completeEnough: false,
      detailEnough: false,
      garmentDescZh: '',
      garmentConstraintEn: '',
      refuseReasonZh: '没有可用图片',
      assets: [],
    };
  }

  let via: 'vision' | 'heuristic' = 'heuristic';
  let visionRead: VisionReadResult | null = null;
  if (vision?.configured()) {
    visionRead = await visionClassifyAndRead(vision, existing);
    if (visionRead) via = 'vision';
  }

  const assets = existing.map((inp, i) => {
    let kind: GarmentRefKind;
    let roleZh: string;
    let roleEn: string;
    if (visionRead?.items[i]) {
      kind = visionRead.items[i].kind;
      roleZh = visionRead.items[i].roleZh;
      roleEn = visionRead.items[i].roleEn;
    } else {
      const h = heuristicKind(basenameOf(inp));
      kind = h.kind;
      roleZh = h.roleZh;
      roleEn = h.roleEn;
    }
    return {
      assetId: String(inp.assetId || ''),
      objectKey: inp.objectKey,
      kind,
      roleZh,
      roleEn,
      sortHint: sortHintForKind(kind, roleZh),
    };
  });

  return {
    analyzedAt,
    via,
    isClothing: visionRead ? visionRead.isClothing !== false : true,
    completeEnough: visionRead ? visionRead.completeEnough !== false : true,
    detailEnough: visionRead ? !!visionRead.detailEnough : assets.some((a) => a.kind === 'detail'),
    hasFullSilhouette: visionRead ? !!visionRead.hasFullSilhouette : assets.some((a) => a.kind === 'hang'),
    garmentDescZh: String(visionRead?.garmentDescZh || '').trim(),
    garmentConstraintEn: String(visionRead?.garmentConstraintEn || '').trim(),
    refuseReasonZh: visionRead?.refuseReasonZh,
    assets: assets.filter((a) => a.assetId),
  };
}

/** 生图参考图准备的品类标识（按品类扩展，勿糊成通用） */
export type PromoGarmentCategory = 'knitwear' | 'shoes' | 'pants' | 'shirt';

export const PROMO_CATEGORY_LABEL_ZH: Record<PromoGarmentCategory, string> = {
  knitwear: '羊毛衫',
  shoes: '鞋子',
  pants: '裤子',
  shirt: '衬衣',
};

type CategoryPrepareFn = (
  vision: VisionClient | null | undefined,
  inputs: GarmentRefInput[],
  opts?: { workDir?: string; preferGrid?: '2x3' | '3x3'; reuseCached?: boolean; cachedAnalysis?: ProductRefAnalysis | null },
) => Promise<GarmentPrepareResult>;

/**
 * 品类 → 准备流程。当前仅注册羊毛衫；鞋子/裤子/衬衣后续各自实现后再挂入。
 * 调用方应显式选品类，缺省 knitwear。
 */
export const CATEGORY_PREPARE_REGISTRY: Partial<Record<PromoGarmentCategory, CategoryPrepareFn>> = {
  knitwear: prepareGarmentRefs,
  // shoes / pants / shirt：另立专用流程后再注册，禁止复用羊毛衫逻辑充数
};

/** 按品类调度；未注册品类直接拒生，避免落入糊质量通用逻辑 */
export async function prepareRefsForCategory(
  category: PromoGarmentCategory | string | undefined,
  vision: VisionClient | null | undefined,
  inputs: GarmentRefInput[],
  opts?: { workDir?: string; preferGrid?: '2x3' | '3x3'; reuseCached?: boolean; cachedAnalysis?: ProductRefAnalysis | null },
): Promise<GarmentPrepareResult> {
  const cat = (category || 'knitwear') as PromoGarmentCategory;
  const fn = CATEGORY_PREPARE_REGISTRY[cat];
  if (!fn) {
    const label = PROMO_CATEGORY_LABEL_ZH[cat as PromoGarmentCategory] || String(cat);
    return {
      ok: false,
      reasonZh: `品类「${label}」的生图标准流程尚未落地，当前仅支持羊毛衫`,
      reasonEn: `Category ${cat} prepare pipeline not implemented`,
    };
  }
  return fn(vision, inputs, opts);
}
