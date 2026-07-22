import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { FeedbackService } from './feedback.service';

@Controller()
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post('feedback')
  @UseGuards(JwtAuthGuard)
  async createFeedback(
    @CurrentUserId() userId: number,
    @Body()
    body: {
      category?: string;
      content?: string;
      contact?: string;
      contextJson?: unknown;
    },
  ) {
    return this.feedbackService.createFeedback(userId, body);
  }

  @Post('client-errors')
  @UseGuards(OptionalJwtAuthGuard)
  async reportClientErrors(
    @Req() req: { userId?: number },
    @Body() body: { events?: any[] },
  ) {
    return this.feedbackService.reportClientErrors(
      req.userId ?? null,
      body?.events || [],
    );
  }

  @Get('admin/feedback')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async listFeedback(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.feedbackService.listFeedback(
      search,
      status,
      category,
      page,
      limit,
    );
  }

  @Put('admin/feedback/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async updateFeedback(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUserId() adminId: number,
    @Body() body: { status?: string; adminNote?: string },
  ) {
    return this.feedbackService.updateFeedback(id, adminId, body);
  }

  @Get('admin/client-errors')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async listClientErrors(
    @Query('search') search?: string,
    @Query('userId') userId?: string,
    @Query('statusCode') statusCode?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.feedbackService.listClientErrors(
      search,
      userId,
      statusCode,
      source,
      page,
      limit,
    );
  }

  @Get('admin/unsupported-formats')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async listUnsupportedFormats(
    @Query('search') search?: string,
    @Query('fileExt') fileExt?: string,
    @Query('reason') reason?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.feedbackService.listUnsupportedFormats(
      search,
      fileExt,
      reason,
      status,
      page,
      limit,
    );
  }

  @Put('admin/unsupported-formats/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async updateUnsupportedFormat(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status?: string; adminNote?: string },
  ) {
    return this.feedbackService.updateUnsupportedFormat(id, body);
  }

  @Get('admin/users/:id/diagnostics')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getUserDiagnostics(@Param('id', ParseIntPipe) id: number) {
    return this.feedbackService.getUserDiagnostics(id);
  }
}
