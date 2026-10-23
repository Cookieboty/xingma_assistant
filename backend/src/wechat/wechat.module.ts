import { Global, Module } from '@nestjs/common';
import { WechatService } from './wechat.service';

@Global()
@Module({
  providers: [WechatService],
  exports: [WechatService],
})
export class WechatModule {}
