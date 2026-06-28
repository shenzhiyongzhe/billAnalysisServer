import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  Query,
  Res,
  UnauthorizedException,
  NotFoundException,
  ParseIntPipe,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import * as fs from 'fs';
import * as path from 'path';

interface QueryItem {
  name: string;
  endOfId?: string | null;
}

@Controller('statements/external')
export class StatementExternalController {
  private uploadsDir = path.join(process.cwd(), 'uploads');

  constructor(private readonly prisma: PrismaService) {}

  private validateApiKey(headers: any, query?: any) {
    const apiKey = headers['x-api-key'] || query?.apiKey;
    const expectedKey = process.env.EXTERNAL_API_KEY || 'bill_query_record_secret_key_2026';
    if (apiKey !== expectedKey) {
      throw new UnauthorizedException('Invalid API Key');
    }
  }

  @Post('query-bulk')
  async queryBulk(
    @Headers() headers: any,
    @Body('queries') queries: QueryItem[],
  ) {
    this.validateApiKey(headers);

    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return { results: {} };
    }

    const names = queries.map((q) => q.name);

    // 查询所有匹配姓名并且状态为 done 的记录
    const records = await this.prisma.queryRecord.findMany({
      where: {
        status: 'done',
        statementUser: {
          name: { in: names },
        },
      },
      include: {
        statementUser: {
          select: {
            name: true,
            idNumber: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const results: Record<string, any[]> = {};
    const baseUrl = process.env.APP_BASE_URL || 'https://www.qkyfx.com';
    const apiKey = process.env.EXTERNAL_API_KEY || 'bill_query_record_secret_key_2026';

    // 根据 name 和 endOfId 分类匹配
    for (const q of queries) {
      const key = `${q.name}_${q.endOfId || ''}`;
      results[key] = [];

      const matchedRecords = records.filter((r) => {
        if (!r.statementUser) return false;
        if (r.statementUser.name !== q.name) return false;

        const idNum = r.statementUser.idNumber;
        if (!idNum || !q.endOfId) return false; // 严格要求二者均非空
        return idNum.endsWith(q.endOfId);
      });

      results[key] = matchedRecords.map((r) => ({
        id: r.id,
        source: r.source,
        createdAt: r.createdAt.toISOString(),
        downloadUrl: `${baseUrl}/api/bill-analysis/statements/external/download/${r.id}?apiKey=${apiKey}`,
      }));
    }

    return { results };
  }

  @Get('download/:id')
  async download(
    @Headers() headers: any,
    @Query() query: any,
    @Param('id', ParseIntPipe) id: number,
    @Res() res: any,
  ) {
    this.validateApiKey(headers, query);

    const record = await this.prisma.queryRecord.findUnique({
      where: { id },
      select: { filePath: true },
    });

    if (!record) {
      throw new NotFoundException('Record not found');
    }

    const filePath = path.join(this.uploadsDir, record.filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('账单源文件不存在或已被清理');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.download(filePath, record.filePath);
  }
}
