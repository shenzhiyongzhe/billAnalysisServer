import {
  Controller,
  Post,
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
  ) {
    try {
      const report = await this.aiService.analyzeStatement(
        parseInt(id, 10),
        userId,
        userNotes,
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
}
