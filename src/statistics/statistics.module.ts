import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma.module';
import { StatisticsService } from './statistics.service';

@Module({
  imports: [PrismaModule],
  providers: [StatisticsService],
  exports: [StatisticsService],
})
export class StatisticsModule {}
