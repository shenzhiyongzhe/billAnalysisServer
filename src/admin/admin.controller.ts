import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  async getUsers() {
    return this.adminService.getUsers();
  }

  @Put('users/:id/queries')
  async updateUserQueries(
    @Param('id', ParseIntPipe) id: number,
    @Body('remainingQueries', ParseIntPipe) remainingQueries: number,
  ) {
    return this.adminService.updateUserQueries(id, remainingQueries);
  }

  @Get('query-records')
  async getQueryRecords() {
    return this.adminService.getQueryRecords();
  }
}
