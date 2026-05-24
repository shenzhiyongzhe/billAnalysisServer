import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    const pool = new Pool({ connectionString });
    const adapter = new PrismaPg(pool);
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
    await this.syncSerialSequences();
    this.logger.log('PostgreSQL 数据库连接成功');
  }

  /** 将 SERIAL 序列对齐到当前 MAX(id)，避免 P2002 QueryRecord_pkey */
  private async syncSerialSequences(): Promise<void> {
    const tables = ['WechatUser', 'StatementUser', 'QueryRecord'] as const;
    for (const table of tables) {
      await this.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX("id") FROM "${table}"), 1))`,
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
