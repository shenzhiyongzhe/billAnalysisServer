import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class StatisticsService {
  private readonly logger = new Logger(StatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // 每天晚上23:59:59触发当天的统计
  @Cron('59 59 23 * * *')
  async handleCron() {
    this.logger.log('Starting daily statistics aggregation via cron job...');
    try {
      await this.aggregateDate(new Date());
      this.logger.log('Daily statistics aggregation completed successfully.');
    } catch (err) {
      this.logger.error('Failed to run daily statistics cron job:', err);
    }
  }

  async aggregateDate(date: Date) {
    // Start of the given date (00:00:00.000)
    const startOfDate = new Date(date);
    startOfDate.setHours(0, 0, 0, 0);

    // End of the given date (23:59:59.999)
    const endOfDate = new Date(date);
    endOfDate.setHours(23, 59, 59, 999);

    // 1. Today's total queries
    const todayQueries = await this.prisma.queryRecord.count({
      where: {
        createdAt: {
          gte: startOfDate,
          lte: endOfDate,
        },
      },
    });

    // 2. Today's recharges (operations where changeAmount > 0)
    const todayRecharges = await this.prisma.queryOperationRecord.count({
      where: {
        changeAmount: { gt: 0 },
        createdAt: {
          gte: startOfDate,
          lte: endOfDate,
        },
      },
    });

    // 3. Total queries overall up to now
    const totalQueries = await this.prisma.queryRecord.count();

    // 4. Total resets/operations overall up to now
    const totalRecharges = await this.prisma.queryOperationRecord.count();

    // 5. Average queries per day since first query
    const firstRecord = await this.prisma.queryRecord.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const firstDate = firstRecord?.createdAt || startOfDate;
    
    // Convert dates to absolute day numbers to avoid time offset errors
    const startOfFirstDate = new Date(firstDate);
    startOfFirstDate.setHours(0, 0, 0, 0);
    
    const diffMs = startOfDate.getTime() - startOfFirstDate.getTime();
    const diffDays = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1); // include the first day itself
    const avgQueriesPerDay = parseFloat((totalQueries / diffDays).toFixed(2));

    // Upsert the aggregated record
    return this.prisma.dailyStatistics.upsert({
      where: { date: startOfDate },
      update: {
        todayQueries,
        todayRecharges,
        totalQueries,
        totalRecharges,
        avgQueriesPerDay,
      },
      create: {
        date: startOfDate,
        todayQueries,
        todayRecharges,
        totalQueries,
        totalRecharges,
        avgQueriesPerDay,
      },
    });
  }

  async getDailyStatistics() {
    // Dynamically calculate and update today's statistics first
    await this.aggregateDate(new Date());

    // Fetch all aggregated statistics, ordered by date descending
    return this.prisma.dailyStatistics.findMany({
      orderBy: {
        date: 'desc',
      },
    });
  }
}
