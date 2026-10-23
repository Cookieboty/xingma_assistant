export interface CustomerLevelRec {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  rank: number;
  isDefault: boolean;
  remark: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductLevelRec {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  rank: number;
  defaultSharePolicy: string;
  minCustomerRank: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertCustomerLevelInput {
  code: string;
  name: string;
  rank?: number;
  isDefault?: boolean;
  remark?: string | null;
}

export interface UpsertProductLevelInput {
  code: string;
  name: string;
  rank?: number;
  defaultSharePolicy?: string;
  minCustomerRank?: number | null;
}
