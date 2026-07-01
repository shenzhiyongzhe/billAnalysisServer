import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { CurrentUserId } from '../auth/current-user.decorator';
import { StatisticsService } from '../statistics/statistics.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly statisticsService: StatisticsService,
  ) {}

  @Get('users')
  async getUsers(@Query('search') search?: string) {
    return this.adminService.getUsers(search);
  }

  @Put('users/:id/queries')
  async updateUserQueries(
    @Param('id', ParseIntPipe) id: number,
    @Body('remainingQueries', ParseIntPipe) remainingQueries: number,
    @Body('reason') reason: string,
    @CurrentUserId() adminId: number,
  ) {
    return this.adminService.updateUserQueries(id, remainingQueries, adminId, reason);
  }

  @Post('users/:id/monthly-card')
  async grantMonthlyCard(
    @Param('id', ParseIntPipe) id: number,
    @Body('months') months: number | undefined,
    @Body('reason') reason: string,
    @CurrentUserId() adminId: number,
  ) {
    return this.adminService.grantMonthlyCard(id, months ?? 1, adminId, reason);
  }

  @Get('query-records')
  async getQueryRecords(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getQueryRecords(page, limit, search);
  }

  @Get('query-operation-records')
  async getQueryOperationRecords(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getQueryOperationRecords(page, limit);
  }

  @Get('statistics')
  async getDailyStatistics() {
    return this.statisticsService.getDailyStatistics();
  }

  @Get('users/ranking')
  async getUserRanking() {
    return this.adminService.getUserRanking();
  }

  @Get('category-keywords')
  async getGlobalKeywords() {
    return this.adminService.getGlobalKeywords();
  }

  @Post('category-keywords')
  async addGlobalKeyword(
    @Body('category') category: string,
    @Body('keyword') keyword: string,
  ) {
    if (!category || !keyword) {
      throw new BadRequestException('Category and keyword are required');
    }
    return this.adminService.addGlobalKeyword(category, keyword);
  }

  @Delete('category-keywords/:id')
  async deleteGlobalKeyword(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.deleteGlobalKeyword(id);
  }
}
