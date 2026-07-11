import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { SystemConfigService } from './system-config.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../admin/admin.guard';
import { CurrentUserId } from '../auth/current-user.decorator';

@Controller('system-config')
export class SystemConfigController {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  @Get('public')
  async getPublicConfig() {
    return this.systemConfigService.getPublicConfig();
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getAdminConfig() {
    return this.systemConfigService.getAdminConfig();
  }

  @Put('admin')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async updateAdminConfig(
    @Body('defaultRemainingQueries', ParseIntPipe)
    defaultRemainingQueries: number,
    @Body('noticeText') noticeText: string,
    @Body('enableCustomPrompt') enableCustomPrompt?: boolean,
  ) {
    return this.systemConfigService.updateAdminConfig(
      defaultRemainingQueries,
      noticeText,
      enableCustomPrompt,
    );
  }

  @Get('admin/ai-prompt')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getAdminAiSystemPrompt() {
    return this.systemConfigService.getAdminAiSystemPrompt();
  }

  @Put('admin/ai-prompt')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async updateAdminAiSystemPrompt(@Body('prompt') prompt: string) {
    return this.systemConfigService.updateAiSystemPrompt(prompt);
  }

  @Post('admin/ai-prompt/reset')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async resetAdminAiSystemPrompt() {
    return this.systemConfigService.resetAiSystemPrompt();
  }

  @Get('ai-prompt')
  @UseGuards(JwtAuthGuard)
  async getUserAiPromptDetail(@CurrentUserId() userId: number) {
    return this.systemConfigService.getUserAiPromptDetail(userId);
  }

  @Put('ai-prompt')
  @UseGuards(JwtAuthGuard)
  async updateUserAiPrompt(
    @CurrentUserId() userId: number,
    @Body('prompt') prompt: string,
  ) {
    return this.systemConfigService.updateUserAiPrompt(userId, prompt);
  }

  @Post('ai-prompt/reset')
  @UseGuards(JwtAuthGuard)
  async resetUserAiPrompt(@CurrentUserId() userId: number) {
    return this.systemConfigService.resetUserAiPrompt(userId);
  }
}
