import {
  CreateProductInput,
  CreateSkuInput,
  ProductListQuery,
  ProductRec,
  ProductSkuRec,
  UpdateProductInput,
} from '../product.types';

export const PRODUCTS_REPO = 'PRODUCTS_REPO';

export interface IProductsRepository {
  list(tenantId: string, query?: ProductListQuery): Promise<{ items: ProductRec[]; total: number }>;
  findById(tenantId: string, id: string): Promise<ProductRec | null>;
  findByStyleNo(tenantId: string, styleNo: string): Promise<ProductRec | null>;
  create(tenantId: string, input: CreateProductInput): Promise<ProductRec>;
  update(tenantId: string, id: string, input: UpdateProductInput): Promise<ProductRec | null>;
  softOffSale(tenantId: string, id: string): Promise<ProductRec | null>;
  batchSetStatus(tenantId: string, ids: string[], status: string): Promise<number>;
  copy(tenantId: string, id: string, newStyleNo: string): Promise<ProductRec | null>;

  listSkus(tenantId: string, productId: string): Promise<ProductSkuRec[]>;
  findSku(tenantId: string, skuId: string): Promise<ProductSkuRec | null>;
  addSku(tenantId: string, productId: string, input: CreateSkuInput): Promise<ProductSkuRec>;
  updateSku(
    tenantId: string,
    skuId: string,
    input: Partial<CreateSkuInput>,
  ): Promise<ProductSkuRec | null>;
  removeSku(tenantId: string, skuId: string): Promise<boolean>;
}
