import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class SystemConfigService {
  constructor(private prisma: PrismaService) {}

  async getPublicConfig() {
    const notice = await this.prisma.systemConfig.findUnique({
      where: { key: 'notice_text' },
    });
    return {
      noticeText: notice ? notice.value : '欢迎使用智能账单分析助手！',
    };
  }

  async getAdminConfig() {
    const defaultQueries = await this.prisma.systemConfig.findUnique({
      where: { key: 'default_remaining_queries' },
    });
    const notice = await this.prisma.systemConfig.findUnique({
      where: { key: 'notice_text' },
    });

    return {
      defaultRemainingQueries: defaultQueries ? parseInt(defaultQueries.value, 10) : 500,
      noticeText: notice ? notice.value : '欢迎使用智能账单分析助手！',
    };
  }

  async updateAdminConfig(defaultRemainingQueries: number, noticeText: string) {
    await this.prisma.systemConfig.upsert({
      where: { key: 'default_remaining_queries' },
      update: { value: String(defaultRemainingQueries) },
      create: { key: 'default_remaining_queries', value: String(defaultRemainingQueries) },
    });

    await this.prisma.systemConfig.upsert({
      where: { key: 'notice_text' },
      update: { value: noticeText },
      create: { key: 'notice_text', value: noticeText },
    });

    return { success: true };
  }
}
