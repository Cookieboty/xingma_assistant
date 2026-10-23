import { Injectable } from '@nestjs/common';
import { newId } from '../../common/utils/id';
import {
  CustomerLevelRec,
  ProductLevelRec,
  UpsertCustomerLevelInput,
  UpsertProductLevelInput,
} from '../level.types';
import { ILevelsRepository } from './levels.repository';

@Injectable()
export class MemoryLevelsRepository implements ILevelsRepository {
  private readonly customerLevels = new Map<string, CustomerLevelRec>();
  private readonly productLevels = new Map<string, ProductLevelRec>();

  constructor() {
    const now = new Date();
    const tenantId = 'tenant_dev_001';
    const seedCl: CustomerLevelRec[] = [
      {
        id: 'cl_default',
        tenantId,
        code: 'L1',
        name: '普通客户',
        rank: 1,
        isDefault: true,
        remark: '首次建档默认',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'cl_vip',
        tenantId,
        code: 'L2',
        name: 'VIP 客户',
        rank: 2,
        isDefault: false,
        remark: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
    seedCl.forEach((c) => this.customerLevels.set(c.id, c));

    const seedPl: ProductLevelRec[] = [
      {
        id: 'pl_open',
        tenantId,
        code: 'OPEN',
        name: '公开款',
        rank: 0,
        defaultSharePolicy: 'open',
        minCustomerRank: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'pl_vip',
        tenantId,
        code: 'VIP',
        name: '定向款',
        rank: 1,
        defaultSharePolicy: 'designated_only',
        minCustomerRank: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'pl_match',
        tenantId,
        code: 'MATCH',
        name: '等级匹配款',
        rank: 2,
        defaultSharePolicy: 'level_match',
        minCustomerRank: 2,
        createdAt: now,
        updatedAt: now,
      },
    ];
    seedPl.forEach((p) => this.productLevels.set(p.id, p));
  }

  async listCustomerLevels(tenantId: string) {
    return [...this.customerLevels.values()]
      .filter((c) => c.tenantId === tenantId)
      .sort((a, b) => a.rank - b.rank)
      .map((c) => ({ ...c }));
  }

  async getCustomerLevel(tenantId: string, id: string) {
    const c = this.customerLevels.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    return { ...c };
  }

  async getDefaultCustomerLevel(tenantId: string) {
    const list = await this.listCustomerLevels(tenantId);
    return list.find((c) => c.isDefault) || list[0] || null;
  }

  async createCustomerLevel(tenantId: string, input: UpsertCustomerLevelInput) {
    if (input.isDefault) {
      for (const c of this.customerLevels.values()) {
        if (c.tenantId === tenantId) c.isDefault = false;
      }
    }
    const now = new Date();
    const rec: CustomerLevelRec = {
      id: newId('cl'),
      tenantId,
      code: input.code.trim(),
      name: input.name.trim(),
      rank: input.rank ?? 0,
      isDefault: !!input.isDefault,
      remark: input.remark ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.customerLevels.set(rec.id, rec);
    return { ...rec };
  }

  async updateCustomerLevel(tenantId: string, id: string, input: Partial<UpsertCustomerLevelInput>) {
    const c = this.customerLevels.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    if (input.isDefault) {
      for (const x of this.customerLevels.values()) {
        if (x.tenantId === tenantId) x.isDefault = false;
      }
    }
    if (input.code !== undefined) c.code = input.code.trim();
    if (input.name !== undefined) c.name = input.name.trim();
    if (input.rank !== undefined) c.rank = input.rank;
    if (input.isDefault !== undefined) c.isDefault = input.isDefault;
    if ('remark' in input) c.remark = input.remark ?? null;
    c.updatedAt = new Date();
    return { ...c };
  }

  async deleteCustomerLevel(tenantId: string, id: string) {
    const c = this.customerLevels.get(id);
    if (!c || c.tenantId !== tenantId) return false;
    if (c.isDefault) return false;
    this.customerLevels.delete(id);
    return true;
  }

  async listProductLevels(tenantId: string) {
    return [...this.productLevels.values()]
      .filter((p) => p.tenantId === tenantId)
      .sort((a, b) => a.rank - b.rank)
      .map((p) => ({ ...p }));
  }

  async getProductLevel(tenantId: string, id: string) {
    const p = this.productLevels.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    return { ...p };
  }

  async createProductLevel(tenantId: string, input: UpsertProductLevelInput) {
    const now = new Date();
    const rec: ProductLevelRec = {
      id: newId('pl'),
      tenantId,
      code: input.code.trim(),
      name: input.name.trim(),
      rank: input.rank ?? 0,
      defaultSharePolicy: input.defaultSharePolicy || 'designated_only',
      minCustomerRank: input.minCustomerRank ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.productLevels.set(rec.id, rec);
    return { ...rec };
  }

  async updateProductLevel(tenantId: string, id: string, input: Partial<UpsertProductLevelInput>) {
    const p = this.productLevels.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    if (input.code !== undefined) p.code = input.code.trim();
    if (input.name !== undefined) p.name = input.name.trim();
    if (input.rank !== undefined) p.rank = input.rank;
    if (input.defaultSharePolicy) p.defaultSharePolicy = input.defaultSharePolicy;
    if ('minCustomerRank' in input) p.minCustomerRank = input.minCustomerRank ?? null;
    p.updatedAt = new Date();
    return { ...p };
  }

  async deleteProductLevel(tenantId: string, id: string) {
    const p = this.productLevels.get(id);
    if (!p || p.tenantId !== tenantId) return false;
    this.productLevels.delete(id);
    return true;
  }
}
