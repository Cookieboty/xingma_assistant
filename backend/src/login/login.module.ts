import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomersModule } from '../customers/customers.module';
import { TenantsModule } from '../tenants/tenants.module';
import { WechatModule } from '../wechat/wechat.module';
import { InvitesModule } from '../invites/invites.module';
import { LoginController } from './login.controller';
import { LoginService } from './login.service';

@Module({
  imports: [AuthModule, TenantsModule, CustomersModule, WechatModule, InvitesModule],
  controllers: [LoginController],
  providers: [LoginService],
})
export class LoginModule {}
