import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { MediaService } from './media.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';

@Controller('api/media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  /**
   * 员工上传凭证（阿里云 PostObject 直传；本地 mode=proxy）。
   * body: { filename?, mimeType?, purpose?, batchId?, count? }
   */
  @Post('upload-credential')
  @UseGuards(RolesGuard)
  @Roles('owner', 'staff')
  uploadCredential(
    @AuthUser() user: AuthContext,
    @Body()
    body: {
      filename?: string;
      mimeType?: string;
      purpose?: string;
      batchId?: string;
      count?: number;
      productId?: string;
    },
  ) {
    return this.mediaService.createUploadCredential(user, body || {});
  }

  /** 批量凭证别名（与 upload-credential 相同，count 默认多份） */
  @Post('upload-credentials')
  @UseGuards(RolesGuard)
  @Roles('owner', 'staff')
  uploadCredentials(
    @AuthUser() user: AuthContext,
    @Body()
    body: {
      filename?: string;
      mimeType?: string;
      purpose?: string;
      batchId?: string;
      count?: number;
      productId?: string;
    },
  ) {
    return this.mediaService.createUploadCredential(user, {
      ...(body || {}),
      count: body?.count || 1,
    });
  }

  /** 服务端中转上传（头像/联系二维码等小文件 / 本地 mock）。头像允许客户上传。 */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  upload(
    @AuthUser() user: AuthContext,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { purpose?: string; productId?: string },
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('缺少文件');
    const purpose = String(body?.purpose || 'misc');
    const isAvatar = purpose === 'avatar';
    const staffOk = user.role === 'owner' || user.role === 'staff';
    if (!isAvatar && !staffOk) {
      throw new BadRequestException('无权上传');
    }
    return this.mediaService.uploadBuffer(user, file, purpose, {
      productId: body?.productId,
    });
  }

  @Post('sign-url')
  signUrl(
    @AuthUser() user: AuthContext,
    @Body() body: { objectKey: string },
  ) {
    return this.mediaService.signAccessUrl(user, body.objectKey);
  }
}
