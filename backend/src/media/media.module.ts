import { Module, Global } from '@nestjs/common';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { MediaExternalPlayController } from './media-external-play.controller';
import { OssClient } from './oss.client';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [MediaController, MediaExternalPlayController],
  providers: [MediaService, OssClient],
  exports: [MediaService, OssClient],
})
export class MediaModule {}
