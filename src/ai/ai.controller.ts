import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /**
   * POST /api/bill-analysis/ai/statements/:id/analyze
   * Body: { userNotes?: string }
   * Returns: { report: string }
   */
  @Post('statements/:id/analyze')
  async analyzeStatement(
    @Param('id') id: string,
    @CurrentUserId() userId: number,
    @Body('userNotes') userNotes = '',
    @Body('useTemplate') useTemplate = true,
  ) {
    try {
      const report = await this.aiService.analyzeStatement(
        parseInt(id, 10),
        userId,
        userNotes,
        useTemplate,
      );
      return { report };
    } catch (err: unknown) {
      const error = err as Error;
      throw new HttpException(
        { message: error.message || 'AI 分析失败，请稍后重试' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // Shared read-only routes (before :id owner routes for clarity)

  @Get('statements/shared/:id/reports')
  async listSharedReports(
    @Param('id') id: string,
    @Query('st') st: string,
    @Query('token') token: string,
  ) {
    try {
      const reports = await this.aiService.listSharedReports(
        parseInt(id, 10),
        st || token || '',
      );
      return { reports };
    } catch (err: unknown) {
      const error = err as Error & { status?: number; getStatus?: () => number };
      const status =
        typeof error.getStatus === 'function'
          ? error.getStatus()
          : error.status || HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(
        { message: error.message || '获取分析报告列表失败' },
        status,
      );
    }
  }

  @Get('statements/shared/:id/reports/:reportId')
  async getSharedReport(
    @Param('id') id: string,
    @Param('reportId') reportId: string,
    @Query('st') st: string,
    @Query('token') token: string,
  ) {
    try {
      return await this.aiService.getSharedReport(
        parseInt(id, 10),
        parseInt(reportId, 10),
        st || token || '',
      );
    } catch (err: unknown) {
      const error = err as Error & { status?: number; getStatus?: () => number };
      const status =
        typeof error.getStatus === 'function'
          ? error.getStatus()
          : error.status || HttpStatus.INTERNAL_SERVER_ERROR;
      throw new HttpException(
        { message: error.message || '获取分析报告失败' },
        status,
      );
    }
  }

  /**
   * GET /api/bill-analysis/ai/statements/:id/reports
   * Returns: { reports: Array<{ id, userNotes, model, createdAt }> }
   */
  @Get('statements/:id/reports')
  async listReports(@Param('id') id: string, @CurrentUserId() userId: number) {
    try {
      const reports = await this.aiService.listReports(
        parseInt(id, 10),
        userId,
      );
      return { reports };
    } catch (err: unknown) {
      const error = err as Error;
      throw new HttpException(
        { message: error.message || '获取分析报告列表失败' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/bill-analysis/ai/statements/:id/reports/:reportId
   * Returns: { id, userNotes, report, model, createdAt }
   */
  @Get('statements/:id/reports/:reportId')
  async getReport(
    @Param('id') id: string,
    @Param('reportId') reportId: string,
    @CurrentUserId() userId: number,
  ) {
    try {
      return await this.aiService.getReport(
        parseInt(id, 10),
        parseInt(reportId, 10),
        userId,
      );
    } catch (err: unknown) {
      const error = err as Error;
      throw new HttpException(
        { message: error.message || '获取分析报告失败' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
