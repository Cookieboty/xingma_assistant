/** 选图发品：图角色 */
export type ImageRole = 'hangtag' | 'main' | 'detail' | 'multi_color' | 'unknown';

export interface PublishBatchAsset {
  mediaId: string;
  objectKey: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
}

export interface PublishBatch {
  batchId: string;
  tenantId: string;
  createdAt: number;
  assets: PublishBatchAsset[];
  suggestion?: PublishSuggestion;
}

export interface ImageSuggestion {
  mediaId: string;
  url: string;
  filename: string;
  role: ImageRole;
  roleConfidence: number;
  /** 建议归属颜色名（可空） */
  colorHint: string | null;
  ocrText?: string;
}

export interface ColorSkuDraft {
  color: string;
  price: string | null;
  /** 该色建议挂的图 mediaId */
  mediaIds: string[];
}

export type ColorSuggestionSource = 'ocr' | 'note' | 'product' | 'mixed' | 'vision' | 'placeholder';

export type TitleSuggestionSource = 'hangtag' | 'input' | 'vision' | 'fallback' | 'styleNo';

export interface PublishSuggestion {
  styleNo: string;
  name: string;
  /** 可选副标题（vision 生成时可能有） */
  subtitle?: string;
  material: string;
  weight: string;
  sizeText: string;
  description: string;
  tags: string[];
  colors: string[];
  /** 颜色列表主要来源：ocr / note / product / mixed / vision / placeholder */
  colorSource?: ColorSuggestionSource;
  /** 回填说明，便于 UI 提示可编辑 */
  colorSourceNote?: string;
  /** 标题来源 */
  titleSource?: TitleSuggestionSource;
  images: ImageSuggestion[];
  skus: ColorSkuDraft[];
  ocrUsed: boolean;
  ocrNote: string;
  levelIdHint?: string;
  /** 异步建品时：占位色/临时款号等需人工复核 */
  needReview?: boolean;
  reviewReasons?: string[];
}

export interface ConfirmPublishInput {
  batchId: string;
  styleNo: string;
  name: string;
  material?: string | null;
  description?: string | null;
  levelId: string;
  priceDisplay?: 'show' | 'hide';
  status?: 'on_sale' | 'off_sale' | 'draft';
  tags?: string[];
  /** 颜色 SKU：一色一行，仅 color + price */
  skus: Array<{ color: string; price?: string | null }>;
  /** 图角色与归属（用户可改） */
  images: Array<{
    mediaId: string;
    role: ImageRole;
    colorHint?: string | null;
  }>;
  /** cover 顺序；默认 主图→细节→场景→文字类，封面置顶 */
  coverMediaIds?: string[];
}
