import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Cron } from '@nestjs/schedule';
import {
  addShanghaiCalendarDays,
  getShanghaiDayBounds,
} from '../common/shanghai-day';

@Injectable()
export class StatisticsService {
  private readonly logger = new Logger(StatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // 每天上海时间 23:59:59 触发当天的统计
  @Cron('59 59 23 * * *', { timeZone: 'Asia/Shanghai' })
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
    const { dateKey, start, end } = getShanghaiDayBounds(date);

    // 1. Today's total queries
    const todayQueries = await this.prisma.queryRecord.count({
      where: {
        createdAt: {
          gte: start,
          lt: end,
        },
      },
    });

    // 2. Today's active users (distinct userId with at least one query)
    const todayActiveGroups = await this.prisma.queryRecord.groupBy({
      by: ['userId'],
      where: {
        createdAt: {
          gte: start,
          lt: end,
        },
      },
    });
    const todayActiveUsers = todayActiveGroups.length;

    // 3. Total queries overall up to now (accumulated from yesterday's stats + today's queries)
    const yesterdayDateKey = addShanghaiCalendarDays(dateKey, -1);

    const yesterdayStats = await this.prisma.dailyStatistics.findUnique({
      where: { date: yesterdayDateKey },
      select: { totalQueries: true },
    });

    const yesterdayTotalQueries = yesterdayStats?.totalQueries || 0;
    const totalQueries = yesterdayTotalQueries + todayQueries;

    // 4. Average queries per day since first query
    // Since query records might be deleted periodically, find the true start date from historical stats first
    const firstStat = await this.prisma.dailyStatistics.findFirst({
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    const firstRecord = await this.prisma.queryRecord.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const firstDate = firstStat?.date || firstRecord?.createdAt || dateKey;

    const firstDayKey = getShanghaiDayBounds(firstDate).dateKey;
    const diffMs = dateKey.getTime() - firstDayKey.getTime();
    const diffDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1);
    const avgQueriesPerDay = parseFloat((totalQueries / diffDays).toFixed(2));

    // Upsert the aggregated record
    return this.prisma.dailyStatistics.upsert({
      where: { date: dateKey },
      update: {
        todayQueries,
        todayActiveUsers,
        totalQueries,
        avgQueriesPerDay,
      },
      create: {
        date: dateKey,
        todayQueries,
        todayActiveUsers,
        totalQueries,
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
