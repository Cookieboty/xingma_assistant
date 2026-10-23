import {
  CustomerLevelRec,
  ProductLevelRec,
  UpsertCustomerLevelInput,
  UpsertProductLevelInput,
} from '../level.types';

export const LEVELS_REPO = 'LEVELS_REPO';

export interface ILevelsRepository {
  listCustomerLevels(tenantId: string): Promise<CustomerLevelRec[]>;
  getCustomerLevel(tenantId: string, id: string): Promise<CustomerLevelRec | null>;
  getDefaultCustomerLevel(tenantId: string): Promise<CustomerLevelRec | null>;
  createCustomerLevel(tenantId: string, input: UpsertCustomerLevelInput): Promise<CustomerLevelRec>;
  updateCustomerLevel(
    tenantId: string,
    id: string,
    input: Partial<UpsertCustomerLevelInput>,
  ): Promise<CustomerLevelRec | null>;
  deleteCustomerLevel(tenantId: string, id: string): Promise<boolean>;

  listProductLevels(tenantId: string): Promise<ProductLevelRec[]>;
  getProductLevel(tenantId: string, id: string): Promise<ProductLevelRec | null>;
  createProductLevel(tenantId: string, input: UpsertProductLevelInput): Promise<ProductLevelRec>;
  updateProductLevel(
    tenantId: string,
    id: string,
    input: Partial<UpsertProductLevelInput>,
  ): Promise<ProductLevelRec | null>;
  deleteProductLevel(tenantId: string, id: string): Promise<boolean>;
}
