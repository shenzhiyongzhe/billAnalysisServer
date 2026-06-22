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

  async getQueryRecords() {
    const records = await this.prisma.queryRecord.findMany({
      orderBy: {
        createdAt: 'desc',
      },
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
      statementUserId: record.statementUserId,
      createdAt: record.createdAt,
    }));
  }
}
