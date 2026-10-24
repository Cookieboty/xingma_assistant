import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { JobsModule } from '../jobs/jobs.module';
import { PromoController } from './promo.controller';
import { PromoService } from './promo.service';
import { ImageGenClient } from './image-gen.client';
import { VideoGenClient } from './video-gen.client';
import { LkbVideoClient } from './lkb-video.client';
import { ExternalOutfitClient } from './external-outfit.client';

@Module({
  imports: [AuthModule, forwardRef(() => ProductsModule), forwardRef(() => JobsModule)],
  controllers: [PromoController],
  providers: [PromoService, ImageGenClient, VideoGenClient, LkbVideoClient, ExternalOutfitClient],
  exports: [PromoService],
})
export class PromoModule {}
