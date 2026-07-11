import {
  Controller,
  Post,
  Body,
  UseGuards,
  ParseIntPipe,
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
    @Body('sharerId', ParseIntPipe) sharerId: number,
  ) {
    return this.shareService.recordShareOpen(sharerId, userId);
  }
}
