import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ShareCodeService } from '../share-code/share-code.service';

const RESULT_SHARE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

@Injectable()
export class ShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shareCodeService: ShareCodeService,
  ) {}

  async recordShareOpen(code: string, openerId: number) {
    const payload = this.shareCodeService.decode(code);
    const sharer = await this.prisma.wechatUser.findUnique({
      where: { id: payload.sharerId },
      select: { id: true },
    });
    if (!sharer) {
      throw new NotFoundException('分享人不存在');
    }

    if (payload.queryRecordId != null) {
      const record = await this.prisma.queryRecord.findUnique({
        where: { id: payload.queryRecordId },
        select: { id: true, status: true, createdAt: true },
      });
      if (!record) {
        throw new NotFoundException('记录已被删除');
      }
      if (record.status !== 'done') {
        throw new NotFoundException('账单尚未解析完成');
      }
      if (record.createdAt.getTime() < Date.now() - RESULT_SHARE_TTL_MS) {
        throw new NotFoundException('分享链接已过期');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.shareRecord.create({
        data: {
          sharerId: payload.sharerId,
          openerId,
          queryRecordId: payload.queryRecordId,
        },
      });
      if (payload.sharerId !== openerId) {
        await tx.wechatUser.update({
          where: { id: payload.sharerId },
          data: { shareCount: { increment: 1 } },
        });
      }
    });

    return {
      kind: payload.queryRecordId == null ? 'index' : 'result',
      ...(payload.queryRecordId != null
        ? { queryRecordId: payload.queryRecordId }
        : {}),
    };
  }
}
