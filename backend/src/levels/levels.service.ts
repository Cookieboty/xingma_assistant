import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  UpsertCustomerLevelInput,
  UpsertProductLevelInput,
} from './level.types';
import { ILevelsRepository, LEVELS_REPO } from './repositories/levels.repository';

@Injectable()
export class LevelsService {
  constructor(@Inject(LEVELS_REPO) private readonly repo: ILevelsRepository) {}

  listCustomerLevels(tenantId: string) {
    return this.repo.listCustomerLevels(tenantId);
  }

  async getCustomerLevel(tenantId: string, id: string) {
    const c = await this.repo.getCustomerLevel(tenantId, id);
    if (!c) throw new NotFoundException('客户等级不存在');
    return c;
  }

  getDefaultCustomerLevel(tenantId: string) {
    return this.repo.getDefaultCustomerLevel(tenantId);
  }

  async createCustomerLevel(tenantId: string, input: UpsertCustomerLevelInput) {
    if (!input.code?.trim() || !input.name?.trim()) {
      throw new BadRequestException('code/name 必填');
    }
    const list = await this.repo.listCustomerLevels(tenantId);
    if (list.some((c) => c.code === input.code.trim())) {
      throw new ConflictException('等级编码已存在');
    }
    return this.repo.createCustomerLevel(tenantId, input);
  }

  async updateCustomerLevel(tenantId: string, id: string, input: Partial<UpsertCustomerLevelInput>) {
    if (input.code) {
      const list = await this.repo.listCustomerLevels(tenantId);
      if (list.some((c) => c.code === input.code!.trim() && c.id !== id)) {
        throw new ConflictException('等级编码已存在');
      }
    }
    const updated = await this.repo.updateCustomerLevel(tenantId, id, input);
    if (!updated) throw new NotFoundException('客户等级不存在');
    return updated;
  }

  async deleteCustomerLevel(tenantId: string, id: string) {
    const ok = await this.repo.deleteCustomerLevel(tenantId, id);
    if (!ok) throw new BadRequestException('无法删除（不存在或为默认等级）');
    return { ok: true };
  }

  listProductLevels(tenantId: string) {
    return this.repo.listProductLevels(tenantId);
  }

  async getProductLevel(tenantId: string, id: string) {
    const p = await this.repo.getProductLevel(tenantId, id);
    if (!p) throw new NotFoundException('商品等级不存在');
    return p;
  }

  async createProductLevel(tenantId: string, input: UpsertProductLevelInput) {
    if (!input.code?.trim() || !input.name?.trim()) {
      throw new BadRequestException('code/name 必填');
    }
    const list = await this.repo.listProductLevels(tenantId);
    if (list.some((p) => p.code === input.code.trim())) {
      throw new ConflictException('等级编码已存在');
    }
    return this.repo.createProductLevel(tenantId, input);
  }

  async updateProductLevel(tenantId: string, id: string, input: Partial<UpsertProductLevelInput>) {
    if (input.code) {
      const list = await this.repo.listProductLevels(tenantId);
      if (list.some((p) => p.code === input.code!.trim() && p.id !== id)) {
        throw new ConflictException('等级编码已存在');
      }
    }
    const updated = await this.repo.updateProductLevel(tenantId, id, input);
    if (!updated) throw new NotFoundException('商品等级不存在');
    return updated;
  }

  async deleteProductLevel(tenantId: string, id: string) {
    const ok = await this.repo.deleteProductLevel(tenantId, id);
    if (!ok) throw new NotFoundException('商品等级不存在');
    return { ok: true };
  }
}
