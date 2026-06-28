import { Module } from '@nestjs/common';
import { StatementController } from './statement.controller';
import { StatementExternalController } from './statement-external.controller';
import { StatementService } from './statement.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [StatementController, StatementExternalController],
  providers: [StatementService],
})
export class StatementModule {}
