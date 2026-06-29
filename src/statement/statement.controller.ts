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

@Controller('statements')
@UseGuards(JwtAuthGuard)
export class StatementController {
  constructor(private readonly statementService: StatementService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUserId() userId: number,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const recordId = await this.statementService.processAndSaveFile(
      userId,
      file.buffer,
      file.originalname,
    );
    return { id: recordId };
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

  @Get('history')
  getHistory(@CurrentUserId() userId: number) {
    return this.statementService.getHistory(userId);
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
  getCounterparties(
    @Param('id') id: string,
    @CurrentUserId() userId: number,
  ) {
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
