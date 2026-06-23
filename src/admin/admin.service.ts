import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getUsers() {
    return this.prisma.wechatUser.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async updateUserQueries(userId: number, remainingQueries: number, adminId?: number, reason?: string) {
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
          oldQueries,
          newQueries: remainingQueries,
          changeAmount,
          reason: reason || '手动充值',
        },
      });

      return updatedUser;
    });
  }

  async getQueryRecords(pageStr?: string, limitStr?: string) {
    const page = pageStr ? parseInt(pageStr, 10) : 1;
    const limit = limitStr ? parseInt(limitStr, 10) : 20;
    const skip = (page - 1) * limit;

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const records = await this.prisma.queryRecord.findMany({
      where: {
        createdAt: {
          gte: sevenDaysAgo,
        },
      },
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
        idNumber: summary?.idNumber || null,
        createdAt: record.createdAt,
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
}
