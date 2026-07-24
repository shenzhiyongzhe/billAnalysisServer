import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  UseGuards,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StatementService } from './statement.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';

type UploadedStatementFile = {
  buffer: Buffer;
  originalname: string;
};

@Controller('statements')
@UseGuards(JwtAuthGuard)
export class StatementController {
  constructor(private readonly statementService: StatementService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @UploadedFile() file: UploadedStatementFile,
    @CurrentUserId() userId: number,
    @Body('fileName') fileName?: string,
    @Body('uploadRequestId') uploadRequestId?: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const name = fileName || file.originalname;
    const result = await this.statementService.processAndSaveFile(
      userId,
      file.buffer,
      name,
      uploadRequestId,
    );
    return { id: result.id, isDuplicate: result.isDuplicate };
  }

  @Get('history')
  getHistory(@CurrentUserId() userId: number) {
    return this.statementService.getHistory(userId);
  }

  @Post('custom-category')
  async saveCustomCategory(
    @CurrentUserId() userId: number,
    @Body('counterparty') counterparty: string,
    @Body('category') category: string,
  ) {
    if (!counterparty || !category) {
      throw new BadRequestException('Counterparty and category are required');
    }
    return this.statementService.saveUserCustomCategory(
      userId,
      counterparty.trim(),
      category.trim(),
    );
  }

  @Get('categories')
  async getCategories() {
    return this.statementService.getCategories();
  }

  @Get('custom-categories')
  async getCustomCategories(@CurrentUserId() userId: number) {
    return this.statementService.getUserCustomCategories(userId);
  }

  // --- Share-by-code read-only (must be before :id routes) ---

  @Get('share/:code/status')
  getShareByCodeStatus(
    @Param('code') code: string,
    @CurrentUserId() userId: number,
  ) {
    return this.statementService.getShareByCodeStatus(code || '', userId);
  }

  @Get('share/:code/result')
  getShareByCodeResult(
    @Param('code') code: string,
    @CurrentUserId() userId: number,
  ) {
    return this.statementService.getShareByCodeResult(code || '', userId);
  }

  @Get('share/:code/risk-status')
  getShareByCodeRiskStatus(@Param('code') code: string) {
    return this.statementService.getShareByCodeRiskStatus(code || '');
  }

  @Post(':id/retry')
  async retryWithPassword(
    @Param('id') id: string,
    @CurrentUserId() userId: number,
    @Body('password') password?: string,
  ) {
    await this.statementService.retryWithPassword(
      userId,
      parseInt(id, 10),
      password,
    );
    return { success: true };
  }

  @Delete(':id')
  deleteRecord(@Param('id') id: string, @CurrentUserId() userId: number) {
    return this.statementService.deleteRecord(userId, parseInt(id, 10));
  }

  @Get(':id/status')
  getStatus(@Param('id') id: string, @CurrentUserId() userId: number) {
    return this.statementService.getRecordStatus(parseInt(id, 10), userId);
  }

  @Get(':id/counterparties')
  getCounterparties(@Param('id') id: string, @CurrentUserId() userId: number) {
    return this.statementService.getCounterparties(parseInt(id, 10), userId);
  }

  @Get(':id/risk-status')
  getRiskStatus(@Param('id') id: string, @CurrentUserId() userId: number) {
    return this.statementService.getRiskStatus(parseInt(id, 10), userId);
  }

  @Get(':id/result')
  getResult(@Param('id') id: string, @CurrentUserId() userId: number) {
    return this.statementService.getResultBundle(parseInt(id, 10), userId);
  }
}
