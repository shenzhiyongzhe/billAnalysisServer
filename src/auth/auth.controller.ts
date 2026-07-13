import { Controller, Post, Get, Put, Body, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUserId } from './current-user.decorator';
import { getClientIp } from '../common/client-ip';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body('code') code: string, @Req() req: Request) {
    return this.authService.wechatLogin(code, getClientIp(req));
  }

  @Post('refresh')
  async refresh(
    @Body('refreshToken') refreshToken: string,
    @Req() req: Request,
  ) {
    return this.authService.refreshSession(refreshToken, getClientIp(req));
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUserId() userId: number) {
    return this.authService.getProfile(userId);
  }

  @Put('profile')
  @UseGuards(JwtAuthGuard)
  async updateProfile(
    @CurrentUserId() userId: number,
    @Body('nickname') nickname?: string,
    @Body('avatar') avatar?: string,
  ) {
    return this.authService.updateProfile(userId, nickname, avatar);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@CurrentUserId() userId: number) {
    await this.authService.revokeSession(userId);
    return { success: true };
  }
}
