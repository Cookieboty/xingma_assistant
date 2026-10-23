import { SharePolicy } from './product-access.service';

export type ProductStatus = 'on_sale' | 'off_sale' | 'draft';
export type PriceDisplay = 'show' | 'hide';

export interface ProductSkuRec {
  id: string;
  tenantId: string;
  productId: string;
  skuCode: string;
  color: string | null;
  size: string | null;
  price: string | null;
  stock: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductRec {
  id: string;
  tenantId: string;
  styleNo: string;
  name: string;
  description: string | null;
  material: string | null;
  levelId: string;
  groupId: string | null;
  priceDisplay: PriceDisplay;
  /** 覆盖等级默认；null 继承商品等级 */
  sharePolicy: SharePolicy | null;
  /** 客户是否可长按/保存商品图 */
  allowCustomerDownload: boolean;
  coverMediaIds: string[] | null;
  tags: string[] | null;
  status: ProductStatus;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductListQuery {
  q?: string;
  levelId?: string;
  status?: string;
  tag?: string;
  groupId?: string;
  page?: number;
  pageSize?: number;
}

export interface CreateSkuInput {
  skuCode?: string;
  color?: string | null;
  size?: string | null;
  price?: string | number | null;
  stock?: number;
  status?: string;
}

export interface CreateProductInput {
  styleNo: string;
  name: string;
  description?: string | null;
  material?: string | null;
  levelId: string;
  groupId?: string | null;
  priceDisplay?: PriceDisplay;
  sharePolicy?: SharePolicy | null;
  allowCustomerDownload?: boolean;
  coverMediaIds?: string[] | null;
  tags?: string[] | null;
  status?: ProductStatus;
  sortOrder?: number;
  skus?: CreateSkuInput[];
}

export interface UpdateProductInput {
  styleNo?: string;
  name?: string;
  description?: string | null;
  material?: string | null;
  levelId?: string;
  groupId?: string | null;
  priceDisplay?: PriceDisplay;
  sharePolicy?: SharePolicy | null;
  allowCustomerDownload?: boolean;
  coverMediaIds?: string[] | null;
  tags?: string[] | null;
  status?: ProductStatus;
  sortOrder?: number;
}
