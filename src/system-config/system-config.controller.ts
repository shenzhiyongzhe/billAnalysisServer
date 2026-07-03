import { Controller, Get, Put, Post, Body, UseGuards, ParseIntPipe } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../admin/admin.guard';

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
    @Body('defaultRemainingQueries', ParseIntPipe) defaultRemainingQueries: number,
    @Body('noticeText') noticeText: string,
  ) {
    return this.systemConfigService.updateAdminConfig(defaultRemainingQueries, noticeText);
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
}
