import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { GenerateInput, PromoService } from './promo.service';

/** 宣传图（商品生图）：仅业主/员工 */
@Controller('api')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'staff')
export class PromoController {
  constructor(private readonly promo: PromoService) {}

  @Get('promo/templates')
  templates() {
    return this.promo.listTemplates();
  }
  @Get('promo/models')
  models() {
    return this.promo.listModels();
  }
  @Get('promo/presets')
  presets() {
    return this.promo.presets();
  }

  @Post('products/:id/promo/start')
  start(@AuthUser() u: AuthContext, @Param('id') id: string, @Body() body: { templateId?: string }) {
    return this.promo.start(u, id, body);
  }
  @Get('products/:id/promo/feature')
  getFeature(@AuthUser() u: AuthContext, @Param('id') id: string) {
    return this.promo.getFeature(u, id);
  }
  @Put('products/:id/promo/feature')
  putFeature(@AuthUser() u: AuthContext, @Param('id') id: string, @Body() body: { feature: string }) {
    return this.promo.putFeature(u, id, body);
  }
  @Post('products/:id/promo/generate')
  generate(@AuthUser() u: AuthContext, @Param('id') id: string, @Body() body: GenerateInput) {
    return this.promo.generate(u, id, body);
  }

  /** 视频分镜脚本草案（业主可编辑后再 generate） */
  @Post('products/:id/promo/video-script')
  videoScript(
    @AuthUser() u: AuthContext,
    @Param('id') id: string,
    @Body()
    body: {
      feature?: string;
      sellingPoint?: string;
      referenceAssetIds?: string[];
      seconds?: number;
    },
  ) {
    return this.promo.draftVideoScript(u, id, body || {});
  }

  /** 风格样例识图 → 可编辑中文关键词（风格参考模板） */
  @Post('products/:id/promo/analyze-style-refs')
  analyzeStyleRefs(
    @AuthUser() u: AuthContext,
    @Param('id') id: string,
    @Body() body: { styleRefObjectKeys?: string[] },
  ) {
    return this.promo.analyzeStyleRefsApi(u, id, body || {});
  }

  /** 宣传图组列表（UI 主入口） */
  @Get('products/:id/promo/sets')
  sets(@AuthUser() u: AuthContext, @Param('id') id: string) {
    return this.promo.listSets(u, id);
  }
  @Get('products/:id/promo/sets/:setId')
  set(@AuthUser() u: AuthContext, @Param('id') id: string, @Param('setId') setId: string) {
    return this.promo.getSet(u, id, setId);
  }
  @Delete('products/:id/promo/sets/:setId')
  deleteSet(@AuthUser() u: AuthContext, @Param('id') id: string, @Param('setId') setId: string) {
    return this.promo.deleteSet(u, id, setId);
  }
  @Post('products/:id/promo/sets/:setId/regenerate')
  regenSet(
    @AuthUser() u: AuthContext,
    @Param('id') id: string,
    @Param('setId') setId: string,
    @Body() body?: { indexes?: number[] },
  ) {
    const indexes = Array.isArray(body?.indexes) ? body!.indexes : [];
    if (indexes.length) {
      return this.promo.regenerateImages(u, id, setId, indexes);
    }
    return this.promo.regenerateSet(u, id, setId);
  }
  @Post('products/:id/promo/sets/:setId/images/:index/regenerate')
  regenImage(
    @AuthUser() u: AuthContext,
    @Param('id') id: string,
    @Param('setId') setId: string,
    @Param('index') index: string,
  ) {
    return this.promo.regenerateImage(u, id, setId, Number(index));
  }

  @Get('products/:id/promo/jobs')
  jobs(@AuthUser() u: AuthContext, @Param('id') id: string) {
    return this.promo.listJobs(u, id);
  }
  @Get('products/:id/promo/jobs/:jobId')
  job(@AuthUser() u: AuthContext, @Param('id') id: string, @Param('jobId') jobId: string) {
    return this.promo.getJob(u, id, jobId);
  }
  @Post('products/:id/promo/jobs/:jobId/save')
  save(
    @AuthUser() u: AuthContext,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Body() body: { indexes?: number[] },
  ) {
    return this.promo.saveToProduct(u, id, jobId, body);
  }
}
