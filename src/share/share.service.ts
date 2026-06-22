import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ShareService {
  constructor(private prisma: PrismaService) {}

  async recordShareOpen(sharerId: number, openerId: number) {
    const sharer = await this.prisma.wechatUser.findUnique({
      where: { id: sharerId },
    });
    if (!sharer) {
      throw new NotFoundException('分享人不存在');
    }

    // Create the ShareRecord
    const record = await this.prisma.shareRecord.create({
      data: {
        sharerId,
        openerId,
      },
    });

    // Increment shareCount of the sharer if they didn't open their own link
    if (sharerId !== openerId) {
      await this.prisma.wechatUser.update({
        where: { id: sharerId },
        data: {
          shareCount: { increment: 1 },
        },
      });
    }

    return record;
  }
}
