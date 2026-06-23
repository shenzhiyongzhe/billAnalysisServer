import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { StatisticsModule } from '../statistics/statistics.module';

@Module({
  imports: [AuthModule, StatisticsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
