import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { InquiriesService } from './inquiries.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';

@Controller('api/inquiries')
@UseGuards(JwtAuthGuard)
export class InquiriesController {
  constructor(private readonly inquiriesService: InquiriesService) {}

  @Post()
  create(
    @AuthUser() user: AuthContext,
    @Body() body: { productId: string; content: string },
  ) {
    return this.inquiriesService.create(user, body);
  }

  @Get()
  list(@AuthUser() user: AuthContext) {
    return this.inquiriesService.list(user);
  }

  @Get(':id')
  detail(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.inquiriesService.get(user, id);
  }
}
