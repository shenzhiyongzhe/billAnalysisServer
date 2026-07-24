import {
  Controller,
  Post,
  Get,
  Param,
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

  // Share-by-code read-only (before :id owner routes)

  @Get('statements/share/:code/reports')
  async listShareByCodeReports(@Param('code') code: string) {
    try {
      const reports = await this.aiService.listShareByCodeReports(code || '');
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

  @Get('statements/share/:code/reports/:reportId')
  async getShareByCodeReport(
    @Param('code') code: string,
    @Param('reportId') reportId: string,
  ) {
    try {
      return await this.aiService.getShareByCodeReport(
        code || '',
        parseInt(reportId, 10),
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
