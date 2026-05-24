import { Controller, Post, Get, Delete, Param, UseInterceptors, UploadedFile, BadRequestException, Body, Query } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StatementService } from './statement.service';

@Controller('statements')
export class StatementController {
  constructor(private readonly statementService: StatementService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File, @Body('userId') userIdStr: string) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const userId = parseInt(userIdStr, 10);
    if (!userId || isNaN(userId)) {
      throw new BadRequestException('userId is required');
    }
    const recordId = await this.statementService.processAndSaveFile(userId, file.buffer, file.originalname);
    return { id: recordId };
  }

  @Get('history')
  getHistory(@Query('userId') userIdStr: string) {
    const userId = parseInt(userIdStr, 10);
    if (!userId || isNaN(userId)) {
      throw new BadRequestException('userId is required');
    }
    return this.statementService.getHistory(userId);
  }

  @Delete(':id')
  deleteRecord(@Param('id') id: string, @Query('userId') userIdStr: string) {
    const userId = parseInt(userIdStr, 10);
    if (!userId || isNaN(userId)) {
      throw new BadRequestException('userId is required');
    }
    return this.statementService.deleteRecord(userId, parseInt(id, 10));
  }

  @Get(':id/counterparties')
  getCounterparties(@Param('id') id: string) {
    return this.statementService.getCounterparties(parseInt(id, 10));
  }

  @Get(':id/result')
  getResult(@Param('id') id: string) {
    return this.statementService.getResultBundle(parseInt(id, 10));
  }
}
