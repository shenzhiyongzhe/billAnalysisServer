import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
  Query,
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
  async getUsers() {
    return this.adminService.getUsers();
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

  @Get('query-records')
  async getQueryRecords(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getQueryRecords(page, limit);
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
}
