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

  async updateUserQueries(userId: number, remainingQueries: number) {
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    return this.prisma.wechatUser.update({
      where: { id: userId },
      data: { remainingQueries },
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

    return records.map((record) => ({
      id: record.id,
      statementUser: record.statementUser?.name || null,
      idNumber: record.statementUserId,
      createdAt: record.createdAt,
    }));
  }
}
