import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { JobsService } from './jobs.service';
import { JobStatus } from './job.types';

@Controller('api/jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'staff')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** 通用创建（调试/高级）；业务通常走 publish/async、promo/generate */
  @Post()
  create(
    @AuthUser() user: AuthContext,
    @Body()
    body: {
      type: string;
      payload?: Record<string, unknown>;
      maxAttempts?: number;
    },
  ) {
    return this.jobs.create(user, body.type, body.payload || {}, {
      maxAttempts: body.maxAttempts,
    });
  }

  @Get()
  list(
    @AuthUser() user: AuthContext,
    @Query('type') type?: string,
    @Query('status') status?: JobStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.jobs.list(user, {
      type,
      status,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Get('meta/handlers')
  handlers() {
    return { types: this.jobs.listHandlerTypes() };
  }

  @Get(':id')
  get(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.jobs.get(user, id);
  }

  @Get(':id/events')
  events(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.jobs.listEvents(user, id, limit ? parseInt(limit, 10) : 50);
  }

  @Post(':id/retry')
  retry(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.jobs.retry(user, id);
  }

  @Post(':id/cancel')
  cancel(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.jobs.cancel(user, id);
  }
}
