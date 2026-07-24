import {
  BadRequestException,
  Controller,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ShareService } from './share.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';

@Controller('share')
@UseGuards(JwtAuthGuard)
export class ShareController {
  constructor(private readonly shareService: ShareService) {}

  @Post('open')
  async recordOpen(
    @CurrentUserId() userId: number,
    @Body('code') code?: string,
  ) {
    if (!code || typeof code !== 'string') {
      throw new BadRequestException('缺少分享码');
    }
    return this.shareService.recordShareOpen(code, userId);
  }
}
