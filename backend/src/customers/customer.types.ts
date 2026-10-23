export interface CustomerRec {
  id: string;
  tenantId: string;
  openid: string;
  unionId: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  levelId: string;
  levelCode: string;
  rank: number;
  phone: string | null;
  remark: string | null;
  firstShareEventId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FollowUpRec {
  id: string;
  tenantId: string;
  inquiryId: string | null;
  customerId: string | null;
  authorMemberId: string;
  content: string;
  kind: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerProductRuleRec {
  id: string;
  tenantId: string;
  customerId: string;
  productId: string;
  effect: 'allow' | 'deny';
  remark: string | null;
  createdAt: Date;
  updatedAt: Date;
}
