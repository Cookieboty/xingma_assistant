import { Global, Module, forwardRef } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { JobSchedulerService } from './job-scheduler.service';
import { VisionClient } from '../vision/vision.client';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { CoverReselectRegistrar } from './handlers/cover-reselect.handler';

@Global()
@Module({
  imports: [AuthModule, forwardRef(() => ProductsModule)],
  controllers: [JobsController],
  providers: [JobsService, JobSchedulerService, VisionClient, CoverReselectRegistrar],
  exports: [JobsService, VisionClient],
})
export class JobsModule {}
