import { Module } from '@nestjs/common';
import { StatementController } from './statement.controller';
import { StatementService } from './statement.service';

@Module({
  controllers: [StatementController],
  providers: [StatementService]
})
export class StatementModule {}
