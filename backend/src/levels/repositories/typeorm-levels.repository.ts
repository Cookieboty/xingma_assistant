import { Injectable, Optional } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { CustomerLevel } from '../../common/entities/customer-level.entity';
import { ProductLevel } from '../../common/entities/product-level.entity';
import {
  CustomerLevelRec,
  ProductLevelRec,
  UpsertCustomerLevelInput,
  UpsertProductLevelInput,
} from '../level.types';
import { ILevelsRepository } from './levels.repository';

@Injectable()
export class TypeOrmLevelsRepository implements ILevelsRepository {
  private readonly customerLevels: Repository<CustomerLevel>;
  private readonly productLevels: Repository<ProductLevel>;

  constructor(@Optional() dataSource?: DataSource) {
    if (!dataSource) {
      throw new Error('TypeOrmLevelsRepository 需要 DataSource');
    }
    this.customerLevels = dataSource.getRepository(CustomerLevel);
    this.productLevels = dataSource.getRepository(ProductLevel);
  }

  private toCl(e: CustomerLevel): CustomerLevelRec {
    return {
      id: e.id,
      tenantId: e.tenantId,
      code: e.code,
      name: e.name,
      rank: e.rank,
      isDefault: !!e.isDefault,
      remark: e.remark,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  }

  private toPl(e: ProductLevel): ProductLevelRec {
    return {
      id: e.id,
      tenantId: e.tenantId,
      code: e.code,
      name: e.name,
      rank: e.rank,
      defaultSharePolicy: e.defaultSharePolicy,
      minCustomerRank: e.minCustomerRank,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  }

  async listCustomerLevels(tenantId: string) {
    const rows = await this.customerLevels.find({
      where: { tenantId },
      order: { rank: 'ASC' },
    });
    return rows.map((r) => this.toCl(r));
  }

  async getCustomerLevel(tenantId: string, id: string) {
    const e = await this.customerLevels.findOne({ where: { id, tenantId } });
    return e ? this.toCl(e) : null;
  }

  async getDefaultCustomerLevel(tenantId: string) {
    const e = await this.customerLevels.findOne({ where: { tenantId, isDefault: true } });
    if (e) return this.toCl(e);
    const list = await this.listCustomerLevels(tenantId);
    return list[0] || null;
  }

  async createCustomerLevel(tenantId: string, input: UpsertCustomerLevelInput) {
    if (input.isDefault) {
      await this.customerLevels.update({ tenantId }, { isDefault: false });
    }
    const saved = await this.customerLevels.save(
      this.customerLevels.create({
        tenantId,
        code: input.code.trim(),
        name: input.name.trim(),
        rank: input.rank ?? 0,
        isDefault: !!input.isDefault,
        remark: input.remark ?? null,
      }),
    );
    return this.toCl(saved);
  }

  async updateCustomerLevel(tenantId: string, id: string, input: Partial<UpsertCustomerLevelInput>) {
    const e = await this.customerLevels.findOne({ where: { id, tenantId } });
    if (!e) return null;
    if (input.isDefault) {
      await this.customerLevels.update({ tenantId }, { isDefault: false });
    }
    if (input.code !== undefined) e.code = input.code.trim();
    if (input.name !== undefined) e.name = input.name.trim();
    if (input.rank !== undefined) e.rank = input.rank;
    if (input.isDefault !== undefined) e.isDefault = input.isDefault;
    if ('remark' in input) e.remark = input.remark ?? null;
    return this.toCl(await this.customerLevels.save(e));
  }

  async deleteCustomerLevel(tenantId: string, id: string) {
    const e = await this.customerLevels.findOne({ where: { id, tenantId } });
    if (!e || e.isDefault) return false;
    await this.customerLevels.delete({ id, tenantId });
    return true;
  }

  async listProductLevels(tenantId: string) {
    const rows = await this.productLevels.find({
      where: { tenantId },
      order: { rank: 'ASC' },
    });
    return rows.map((r) => this.toPl(r));
  }

  async getProductLevel(tenantId: string, id: string) {
    const e = await this.productLevels.findOne({ where: { id, tenantId } });
    return e ? this.toPl(e) : null;
  }

  async createProductLevel(tenantId: string, input: UpsertProductLevelInput) {
    const saved = await this.productLevels.save(
      this.productLevels.create({
        tenantId,
        code: input.code.trim(),
        name: input.name.trim(),
        rank: input.rank ?? 0,
        defaultSharePolicy: input.defaultSharePolicy || 'designated_only',
        minCustomerRank: input.minCustomerRank ?? null,
      }),
    );
    return this.toPl(saved);
  }

  async updateProductLevel(tenantId: string, id: string, input: Partial<UpsertProductLevelInput>) {
    const e = await this.productLevels.findOne({ where: { id, tenantId } });
    if (!e) return null;
    if (input.code !== undefined) e.code = input.code.trim();
    if (input.name !== undefined) e.name = input.name.trim();
    if (input.rank !== undefined) e.rank = input.rank;
    if (input.defaultSharePolicy) e.defaultSharePolicy = input.defaultSharePolicy;
    if ('minCustomerRank' in input) e.minCustomerRank = input.minCustomerRank ?? null;
    return this.toPl(await this.productLevels.save(e));
  }

  async deleteProductLevel(tenantId: string, id: string) {
    const result = await this.productLevels.delete({ id, tenantId });
    return (result.affected || 0) > 0;
  }
}
