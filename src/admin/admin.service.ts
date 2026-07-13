import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getUsers(
    search?: string,
    pageStr?: string,
    limitStr?: string,
    orderByStr?: string,
  ) {
    const page = pageStr ? Math.max(1, parseInt(pageStr, 10)) : 1;
    const limit = limitStr
      ? Math.min(100, Math.max(1, parseInt(limitStr, 10)))
      : 20;
    const skip = (page - 1) * limit;

    const ORDER_MAP: Record<string, any> = {
      createdAt_desc: { createdAt: 'desc' },
      createdAt_asc: { createdAt: 'asc' },
      remainingQueries_desc: { remainingQueries: 'desc' },
      remainingQueries_asc: { remainingQueries: 'asc' },
      totalQueries_desc: { totalQueries: 'desc' },
      totalQueries_asc: { totalQueries: 'asc' },
    };
    const orderBy = ORDER_MAP[orderByStr ?? ''] ?? { createdAt: 'desc' };

    const where: any = {};
    if (
      search &&
      search !== 'undefined' &&
      search !== 'null' &&
      search.trim() !== ''
    ) {
      where.OR = [
        { nickname: { contains: search, mode: 'insensitive' } },
        { displayId: search },
      ];
    }

    const [users, total] = await Promise.all([
      this.prisma.wechatUser.findMany({
        where,
        select: {
          id: true,
          openid: true,
          displayId: true,
          nickname: true,
          avatar: true,
          remainingQueries: true,
          totalQueries: true,
          shareCount: true,
          level: true,
          monthlyCardExpiry: true,
          lastLoginAt: true,
          lastLoginIp: true,
          createdAt: true,
        },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.wechatUser.count({ where }),
    ]);

    return {
      users,
      total,
      page,
      limit,
      hasMore: skip + users.length < total,
    };
  }

  async updateUserQueries(
    userId: number,
    remainingQueries: number,
    adminId?: number,
    reason?: string,
  ) {
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    const oldQueries = user.remainingQueries;
    const changeAmount = remainingQueries - oldQueries;

    return this.prisma.$transaction(async (tx) => {
      const updatedUser = await tx.wechatUser.update({
        where: { id: userId },
        data: { remainingQueries },
      });

      await tx.queryOperationRecord.create({
        data: {
          userId,
          adminId,
          operationType: 'queries',
          oldQueries,
          newQueries: remainingQueries,
          changeAmount,
          reason: reason || '手动充值',
        },
      });

      return updatedUser;
    });
  }

  async grantMonthlyCard(
    userId: number,
    months = 1,
    adminId?: number,
    reason?: string,
  ) {
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    const validMonths = [1, 3, 6].includes(months) ? months : 1;
    const days = validMonths * 30;

    const now = new Date();
    const existingExpiry = user.monthlyCardExpiry
      ? new Date(user.monthlyCardExpiry)
      : null;
    const base =
      existingExpiry && existingExpiry.getTime() > now.getTime()
        ? existingExpiry
        : now;
    const expiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    const monthLabel = validMonths === 6 ? '半年' : `${validMonths}个月`;

    return this.prisma.$transaction(async (tx) => {
      const updatedUser = await tx.wechatUser.update({
        where: { id: userId },
        data: { monthlyCardExpiry: expiry },
      });

      await tx.queryOperationRecord.create({
        data: {
          userId,
          adminId,
          operationType: 'monthly_card',
          oldQueries: user.remainingQueries,
          newQueries: user.remainingQueries, // 次数不变
          changeAmount: 0,
          reason: reason || `充值月卡${monthLabel}`,
        },
      });

      return updatedUser;
    });
  }

  async getQueryRecords(pageStr?: string, limitStr?: string, search?: string) {
    const page = pageStr ? parseInt(pageStr, 10) : 1;
    const limit = limitStr ? parseInt(limitStr, 10) : 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (
      search &&
      search !== 'undefined' &&
      search !== 'null' &&
      search.trim() !== ''
    ) {
      const orConditions: any[] = [
        {
          statementUser: {
            name: { contains: search, mode: 'insensitive' },
          },
        },
      ];

      const searchNum = parseInt(search, 10);
      if (!isNaN(searchNum)) {
        orConditions.push({ userId: searchNum });
      }

      orConditions.push({
        user: {
          displayId: { contains: search, mode: 'insensitive' },
        },
      });

      where.OR = orConditions;
    }

    const records = await this.prisma.queryRecord.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: limit,
      include: {
        statementUser: {
          select: {
            name: true,
          },
        },
        user: {
          select: {
            nickname: true,
            avatar: true,
          },
        },
      },
    });

    return records.map((record) => {
      let summary: any = null;
      if (record.summaryJson) {
        if (typeof record.summaryJson === 'string') {
          try {
            summary = JSON.parse(record.summaryJson);
          } catch (e) {
            summary = null;
          }
        } else {
          summary = record.summaryJson;
        }
      }
      return {
        id: record.id,
        statementUser: record.statementUser?.name || null,
        idNumber: summary?.idNumber ? String(summary.idNumber).slice(-4) : null,
        createdAt: record.createdAt,
        nickname: record.user?.nickname || null,
        avatar: record.user?.avatar || null,
      };
    });
  }

  async getQueryOperationRecords(pageStr?: string, limitStr?: string) {
    const page = pageStr ? parseInt(pageStr, 10) : 1;
    const limit = limitStr ? parseInt(limitStr, 10) : 20;
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      this.prisma.queryOperationRecord.findMany({
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
        include: {
          user: {
            select: {
              nickname: true,
              displayId: true,
            },
          },
          admin: {
            select: {
              nickname: true,
              displayId: true,
            },
          },
        },
      }),
      this.prisma.queryOperationRecord.count(),
    ]);

    return {
      records: records.map((record) => ({
        id: record.id,
        userId: record.userId,
        userNickname: record.user.nickname,
        userDisplayId: record.user.displayId,
        adminId: record.adminId,
        adminNickname: record.admin?.nickname || '系统',
        adminDisplayId: record.admin?.displayId || null,
        oldQueries: record.oldQueries,
        newQueries: record.newQueries,
        changeAmount: record.changeAmount,
        reason: record.reason,
        createdAt: record.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  async getUserRanking() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayQueriesGroup = await this.prisma.queryRecord.groupBy({
      by: ['userId'],
      _count: {
        id: true,
      },
      where: {
        createdAt: {
          gte: todayStart,
        },
      },
      orderBy: {
        _count: {
          id: 'desc',
        },
      },
      take: 10,
    });

    const todayUserIds = todayQueriesGroup.map((g) => g.userId);
    const todayCountsMap = new Map(
      todayQueriesGroup.map((g) => [g.userId, g._count.id]),
    );

    const todayUsers = await this.prisma.wechatUser.findMany({
      where: {
        id: { in: todayUserIds },
      },
      select: {
        id: true,
        nickname: true,
        avatar: true,
        displayId: true,
      },
    });

    const todayRanking = todayUsers
      .map((u) => ({
        id: u.id,
        nickname: u.nickname,
        avatar: u.avatar,
        displayId: u.displayId,
        queriesCount: todayCountsMap.get(u.id) || 0,
      }))
      .sort((a, b) => b.queriesCount - a.queriesCount);

    const historicalRanking = await this.prisma.wechatUser.findMany({
      orderBy: {
        totalQueries: 'desc',
      },
      take: 50,
      select: {
        id: true,
        nickname: true,
        avatar: true,
        displayId: true,
        totalQueries: true,
      },
    });

    return {
      today: todayRanking,
      historical: historicalRanking.map((u) => ({
        id: u.id,
        nickname: u.nickname,
        avatar: u.avatar,
        displayId: u.displayId,
        queriesCount: u.totalQueries,
      })),
    };
  }

  async getGlobalKeywords() {
    return this.prisma.globalCategoryKeyword.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async addGlobalKeyword(category: string, keyword: string) {
    return this.prisma.globalCategoryKeyword.upsert({
      where: { keyword: keyword.trim() },
      update: { category: category.trim() },
      create: { category: category.trim(), keyword: keyword.trim() },
    });
  }

  async deleteGlobalKeyword(id: number) {
    return this.prisma.globalCategoryKeyword.delete({
      where: { id },
    });
  }
}
