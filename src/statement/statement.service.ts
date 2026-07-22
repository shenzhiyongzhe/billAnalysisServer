import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PasswordException } from 'pdf-parse';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as ExcelJS from 'exceljs';
import { PdfTextExtractor } from './pdf-text-extractor';

const DEFAULT_QUERY_SERVER_BASE = 'https://www.xinde8888.com/api/query_info';

function resolveQueryServerBaseUrl(): string {
  const explicit = process.env.QUERY_SERVER_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  return DEFAULT_QUERY_SERVER_BASE;
}

const QUERY_SERVER_BASE_URL = resolveQueryServerBaseUrl();

function queryServerUrl(path: string, searchParams?: URLSearchParams): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${QUERY_SERVER_BASE_URL}${normalizedPath}`;
  const query = searchParams?.toString();
  return query ? `${url}?${query}` : url;
}

export interface StatementSummary {
  id: string;
  source: string;
  name: string;
  idNumber: string;
  cardNumber?: string;
  startDate: string;
  endDate: string;
  totalIncome: number;
  totalExpenditure: number;
  selfIncome: number;
  selfExpenditure: number;
  maskedIdNumber?: string;
  maskedCardNumber?: string;
  maskedPhoneNumber?: string;
  nativePlace?: string;
  genderText?: string;
  age?: number;
  phoneNumber?: string;
}

export interface Transaction {
  date: string;
  month: string;
  type: '收入' | '支出' | '不计收支';
  amount: number;
  counterparty: string;
  bizType?: string;
  product?: string;
  category?: string;
}

export interface StatementData {
  summary: StatementSummary;
  transactions: Transaction[];
}

export interface StatementResultMeta {
  id: string;
  source: string;
  name: string;
  startDate: string;
  endDate: string;
  maskedIdNumber?: string;
  maskedCardNumber?: string;
  maskedPhoneNumber?: string;
  nativePlace?: string;
  genderText?: string;
  age?: number;
  firstQueryTime?: string | null;
  queryCount?: number;
  isHighRisk?: boolean;
}

export interface StatementResultBundle {
  summary: StatementResultMeta;
  raw: Transaction[];
}

@Injectable()
export class StatementService implements OnModuleInit, OnModuleDestroy {
  private uploadsDir = path.join(process.cwd(), 'uploads');
  private readonly logger = new Logger(StatementService.name);
  private progressStore = new Map<
    number,
    { progress: number; stage: string; detail: string }
  >();
  private readonly pdfExtractor = new PdfTextExtractor();

  constructor(private prisma: PrismaService) {
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
  }

  onModuleInit() {
    this.pdfExtractor.onModuleInit();
  }

  onModuleDestroy() {
    this.pdfExtractor.onModuleDestroy();
  }

  private async parsePdfText(
    buffer: Buffer,
    password?: string,
    onProgress?: (progress: number, stage: string, detail: string) => void,
  ): Promise<string> {
    return this.pdfExtractor.extract(buffer, password, onProgress);
  }

  async extractPdfTextForBenchmark(
    buffer: Buffer,
    password: string | undefined,
    onProgress?: (progress: number, stage: string, detail: string) => void,
  ): Promise<string> {
    return this.pdfExtractor.extract(buffer, password, onProgress);
  }

  async processAndSaveFile(
    userId: number,
    buffer: Buffer,
    originalname: string,
  ): Promise<{ id: number; isDuplicate: boolean }> {
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // 0. Check if a duplicate record exists in the last 3 days
    const existing = await this.prisma.queryRecord.findFirst({
      where: {
        userId,
        filePath: {
          startsWith: md5,
        },
        createdAt: { gte: threeDaysAgo },
      },
    });

    if (existing) {
      const isFormatError =
        existing.status === 'failed' &&
        existing.summaryJson &&
        typeof existing.summaryJson === 'object' &&
        (existing.summaryJson as any).error?.includes('格式');

      if (
        existing.status === 'done' ||
        existing.status === 'password_required' ||
        isFormatError
      ) {
        this.logger.log(
          `Found duplicate statement upload by hash for user ${userId}, reusing record ${existing.id}`,
        );
        return { id: existing.id, isDuplicate: true };
      }
    }

    // ① 校验用户并根据月卡状态决定是否扣减次数
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
      select: { id: true, remainingQueries: true, monthlyCardExpiry: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    const hasMonthlyCard =
      user.monthlyCardExpiry != null && user.monthlyCardExpiry > now;

    if (hasMonthlyCard) {
      // 月卡有效：仅累加 totalQueries，不扣减 remainingQueries
      await this.prisma.wechatUser.update({
        where: { id: userId },
        data: { totalQueries: { increment: 1 } },
      });
    } else {
      // 无月卡：原子扣减次数
      const updated = await this.prisma.wechatUser.updateMany({
        where: { id: userId, remainingQueries: { gt: 0 } },
        data: {
          remainingQueries: { decrement: 1 },
          totalQueries: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new BadRequestException('剩余分析次数不足');
      }
    }

    // ② 从文件名快速判断来源（不解析 PDF），用于立即建记录
    let source = '未知';
    if (originalname.includes('微信')) source = '微信';
    else if (originalname.includes('支付宝')) source = '支付宝';
    else if (originalname.includes('招商')) source = '招商银行';
    else if (originalname.includes('交通')) source = '交通银行';
    else if (originalname.includes('工商') || originalname.includes('工行'))
      source = '工商银行';
    else if (originalname.includes('农商') || originalname.includes('农村商业'))
      source = '农商银行';

    // ③ 写文件 + 立即创建 pending 记录，同步返回 id
    const fileName = `${md5}_${originalname}`;
    const filePath = path.join(this.uploadsDir, fileName);
    await fs.promises.writeFile(filePath, buffer);

    const record = await this.prisma.queryRecord.create({
      data: { userId, filePath: fileName, source, status: 'pending' },
    });
    const recordId = record.id;

    // ④ 后台异步解析 PDF（不阻塞当前请求）
    setImmediate(() => {
      void this.parseAndUpdateRecord(
        recordId,
        userId,
        buffer,
        fileName,
        undefined,
        originalname,
        source,
      );
    });

    return { id: recordId, isDuplicate: false };
  }
  private async parseAndUpdateRecord(
    recordId: number,
    userId: number,
    buffer: Buffer,
    fileName: string,
    password?: string,
    originalFileName?: string,
    guessedSource?: string,
  ): Promise<void> {
    let headerExcerpt = '';
    let detectedSourceHint: string | undefined = guessedSource;
    const resolvedOriginalName =
      originalFileName || this.extractOriginalFileName(fileName);

    try {
      let source: string;
      let parsedData: StatementData;

      if (
        fileName.toLowerCase().endsWith('.xlsx') ||
        fileName.toLowerCase().endsWith('.xls')
      ) {
        source = '微信';
        this.progressStore.set(recordId, {
          progress: 20,
          stage: 'parsing_xlsx',
          detail: '正在读取 Excel 账单数据...',
        });
        parsedData = await this.parseXlsxFile(buffer);
      } else if (fileName.toLowerCase().endsWith('.csv')) {
        this.progressStore.set(recordId, {
          progress: 20,
          stage: 'parsing_csv',
          detail: '正在读取 CSV 账单数据...',
        });
        parsedData = await this.parseCsvFile(buffer);
        source = parsedData.summary.source;
        detectedSourceHint = source;
      } else {
        this.progressStore.set(recordId, {
          progress: 5,
          stage: 'parsing_pdf',
          detail: '正在读取 PDF 结构...',
        });

        const text = await this.parsePdfText(
          buffer,
          password,
          (progress, stage, detail) => {
            this.progressStore.set(recordId, { progress, stage, detail });
          },
        );
        headerExcerpt = this.buildHeaderExcerpt(text);

        this.progressStore.set(recordId, {
          progress: 90,
          stage: 'detecting_source',
          detail: '正在识别账单来源...',
        });

        const detected = this.detectSourceFromText(text);

        if (!detected) {
          const errorMessage =
            '不支持的账单格式，请上传正确的微信、支付宝、招商银行、交通银行、工商银行或农商银行交易流水。';
          await this.safeLogUnsupportedFormat({
            userId,
            queryRecordId: recordId,
            reason: 'undetected_source',
            originalFileName: resolvedOriginalName,
            storedFileName: fileName,
            fileSize: buffer.length,
            guessedSource,
            headerExcerpt,
            errorMessage,
          });
          throw new BadRequestException(errorMessage);
        }

        source = detected;
        detectedSourceHint = source;

        this.progressStore.set(recordId, {
          progress: 92,
          stage: 'extracting_data',
          detail: '正在进行智能数据 analysis...',
        });

        parsedData = this.extractData(text, source);
      }

      this.progressStore.set(recordId, {
        progress: 95,
        stage: 'saving',
        detail: '正在安全导入并生成分析报告...',
      });

      if (parsedData.transactions.length === 0) {
        const errorMessage =
          '该账单文件解析出的交易流水为空，可能由于账单内容格式不受支持。目前支持标准的微信、支付宝及主流银行借记卡交易流水。';
        await this.safeLogUnsupportedFormat({
          userId,
          queryRecordId: recordId,
          reason: 'empty_transactions',
          originalFileName: resolvedOriginalName,
          storedFileName: fileName,
          fileSize: buffer.length,
          guessedSource: detectedSourceHint || source,
          headerExcerpt,
          errorMessage,
        });
        throw new BadRequestException(errorMessage);
      } else {
        this.logger.log(
          `Parsed ${parsedData.transactions.length} transactions for record ${recordId} (${source})`,
        );
      }

      // upsert statementUser
      let statementUserId: number | null = null;
      if (parsedData.summary.name !== '未知') {
        const idNumber = parsedData.summary.idNumber || null;
        const cardNumber = parsedData.summary.cardNumber || null;
        const phoneNumber = parsedData.summary.phoneNumber || null;

        if (idNumber || cardNumber || phoneNumber) {
          let su;
          if (idNumber) {
            su = await this.prisma.statementUser.upsert({
              where: { idNumber },
              update: { queryCount: { increment: 1 } },
              create: {
                name: parsedData.summary.name,
                idNumber,
                cardNumber,
                phoneNumber,
                queryCount: 1,
              },
              select: { id: true },
            });
          } else if (cardNumber) {
            su = await this.prisma.statementUser.upsert({
              where: { cardNumber },
              update: { queryCount: { increment: 1 } },
              create: {
                name: parsedData.summary.name,
                idNumber,
                cardNumber,
                phoneNumber,
                queryCount: 1,
              },
              select: { id: true },
            });
          } else {
            const existingUser = await this.prisma.statementUser.findFirst({
              where: { phoneNumber: phoneNumber! },
              select: { id: true },
            });
            if (existingUser) {
              su = await this.prisma.statementUser.update({
                where: { id: existingUser.id },
                data: { queryCount: { increment: 1 } },
                select: { id: true },
              });
            } else {
              su = await this.prisma.statementUser.create({
                data: {
                  name: parsedData.summary.name,
                  idNumber,
                  cardNumber,
                  phoneNumber,
                  queryCount: 1,
                },
                select: { id: true },
              });
            }
          }
          statementUserId = su.id;
        }
      }

      // 将生成的记录 ID 写入 summary，以便持久化数据包含真实 ID
      parsedData.summary.id = recordId.toString();

      // 更新记录为 done
      await this.prisma.queryRecord.update({
        where: { id: recordId },
        data: {
          source,
          statementUserId,
          summaryJson: parsedData.summary as any,
          transactionsJson: parsedData.transactions as any,
          startDate: this.parseDateOnlyToDate(parsedData.summary.startDate),
          endDate: this.parseDateOnlyToDate(parsedData.summary.endDate),
          status: 'done',
        },
      });

      // 将解析数据同步传到另一个服务器上
      try {
        const wechatUser = await this.prisma.wechatUser.findUnique({
          where: { id: userId },
          select: { nickname: true, openid: true },
        });

        const response = await fetch(queryServerUrl('/persons/query-record'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'bill_query_record_secret_key_2026',
          },
          body: JSON.stringify({
            name: parsedData.summary.name,
            end_of_id: parsedData.summary.idNumber
              ? parsedData.summary.idNumber.slice(-6)
              : null,
            first_querior: wechatUser?.nickname,
            first_querior_id: wechatUser?.openid,
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          this.logger.error(
            `Failed to send query record to external server: ${response.status} ${text}`,
          );
        } else {
          this.logger.log(
            `Successfully sent query record for user ${userId} to external server`,
          );
        }
      } catch (apiErr) {
        this.logger.error(
          'Error sending query record to external server:',
          apiErr,
        );
      }
    } catch (err) {
      if (err instanceof PasswordException) {
        this.logger.warn(`PDF is password protected for record ${recordId}`);
        await this.prisma.queryRecord.update({
          where: { id: recordId },
          data: { status: 'password_required' },
        });
        return;
      }
      this.logger.error(`Background parse failed for record ${recordId}:`, err);
      // 解析失败：标记 failed，并视月卡状态决定是否退还次数
      const failedUser = await this.prisma.wechatUser.findUnique({
        where: { id: userId },
        select: { monthlyCardExpiry: true },
      });
      const failNow = new Date();
      const userHadMonthlyCard =
        failedUser?.monthlyCardExpiry != null &&
        failedUser.monthlyCardExpiry > failNow;
      const errorMsg = this.extractErrorMessage(err);

      const alreadyLogged =
        errorMsg.includes('不支持的账单格式') ||
        errorMsg.includes('交易流水为空');
      if (!alreadyLogged) {
        const reason = this.classifyUnsupportedReason(errorMsg);
        if (reason) {
          await this.safeLogUnsupportedFormat({
            userId,
            queryRecordId: recordId,
            reason,
            originalFileName: resolvedOriginalName,
            storedFileName: fileName,
            fileSize: buffer.length,
            guessedSource: detectedSourceHint,
            headerExcerpt,
            errorMessage: errorMsg,
          });
        }
      }

      await Promise.all([
        this.prisma.queryRecord.update({
          where: { id: recordId },
          data: {
            status: 'failed',
            summaryJson: { error: errorMsg } as any,
          },
        }),
        this.prisma.wechatUser.update({
          where: { id: userId },
          data: userHadMonthlyCard
            ? { totalQueries: { decrement: 1 } } // 月卡用户：只回退计数
            : {
                remainingQueries: { increment: 1 },
                totalQueries: { decrement: 1 },
              }, // 普通用户：退还次数
        }),
      ]);
    } finally {
      this.progressStore.delete(recordId);
    }
  }
  async getRecordStatus(recordId: number, userId: number) {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
      select: { userId: true, status: true, summaryJson: true },
    });
    if (!record) throw new NotFoundException('Record not found');
    if (!(await this.isOwnerOrAdmin(record.userId, userId))) {
      throw new ForbiddenException('无权访问该记录');
    }

    let progress = 0;
    let stage = record.status;
    let detail = '正在初始化解析任务...';

    if (record.status === 'done') {
      progress = 100;
      detail = '解析完成';
    } else if (record.status === 'failed') {
      progress = 100;
      detail = '解析失败';
    } else if (record.status === 'password_required') {
      progress = 100;
      detail = '账单文件受密码保护，请输入解压密码';
    } else {
      const activeProgress = this.progressStore.get(recordId);
      if (activeProgress) {
        progress = activeProgress.progress;
        stage = activeProgress.stage;
        detail = activeProgress.detail;
      }
    }

    const tips = [
      '账单上传后将采用银行级加密存储，仅供您本人查看。',
      '分析完成后，可生成多维度分类统计图表，方便记账与对账。',
      '系统支持微信、支付宝、招商、交通、工商及顺德农商银行账单。',
      '大体积账单解析可能会消耗较多时间，请耐心等待。',
      '如果解析失败，请检查账单文件是否完整或密码是否正确。',
    ];

    let error: string | null = null;
    if (record.status === 'failed' && record.summaryJson) {
      const summary = record.summaryJson as any;
      error = summary.error || null;
    }

    return {
      status: record.status,
      ready: record.status === 'done',
      progress,
      stage,
      detail,
      tips,
      error,
    };
  }

  async getHistory(userId: number) {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const records = await this.prisma.queryRecord.findMany({
      where: {
        userId,
        createdAt: { gte: threeDaysAgo },
      },
      include: { statementUser: true },
      orderBy: { createdAt: 'desc' },
    });

    return records.map((r) => {
      const summaryName =
        r.summaryJson && typeof r.summaryJson === 'object'
          ? (r.summaryJson as any).name
          : undefined;
      return {
        id: r.id,
        source: r.source,
        name: r.statementUser?.name || summaryName || '未知',
        createdAt: r.createdAt,
      };
    });
  }

  async deleteRecord(userId: number, recordId: number) {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
    });
    if (!record) {
      throw new NotFoundException('Record not found');
    }
    if (!(await this.isOwnerOrAdmin(record.userId, userId))) {
      throw new ForbiddenException('无权删除该记录');
    }

    const filePath = path.join(this.uploadsDir, record.filePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await this.prisma.queryRecord.delete({ where: { id: recordId } });
    return { success: true };
  }

  async retryWithPassword(
    userId: number,
    recordId: number,
    password?: string,
  ): Promise<void> {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
    });
    if (!record) throw new NotFoundException('Record not found');
    if (!(await this.isOwnerOrAdmin(record.userId, userId))) {
      throw new ForbiddenException('无权访问该记录');
    }
    if (record.status !== 'password_required' && record.status !== 'failed') {
      throw new BadRequestException('记录状态不满足重试条件');
    }

    const filePath = path.join(this.uploadsDir, record.filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('账单源文件不存在或已被清理');
    }

    // 更新状态回 pending
    await this.prisma.queryRecord.update({
      where: { id: recordId },
      data: { status: 'pending' },
    });

    const buffer = fs.readFileSync(filePath);
    const storedName = path.basename(filePath);
    // 异步执行解析，带上密码
    setImmediate(() => {
      void this.parseAndUpdateRecord(
        recordId,
        userId,
        buffer,
        storedName,
        password,
        this.extractOriginalFileName(storedName),
        record.source,
      );
    });
  }

  private extractErrorMessage(err: unknown): string {
    if (err instanceof BadRequestException) {
      const res = err.getResponse();
      if (typeof res === 'string') return res;
      if (res && typeof res === 'object' && 'message' in res) {
        const m = (res as { message?: string | string[] }).message;
        if (Array.isArray(m)) return m.join('; ');
        if (typeof m === 'string') return m;
      }
    }
    if (err instanceof Error) return err.message;
    return String(err);
  }

  private extractOriginalFileName(storedFileName: string): string {
    const idx = storedFileName.indexOf('_');
    if (idx > 0 && idx < storedFileName.length - 1) {
      return storedFileName.slice(idx + 1);
    }
    return storedFileName;
  }

  /** PDF 文本常含 \\0 等非法 UTF-8 字节，PostgreSQL text 会拒绝 */
  private sanitizeDbText(input: string, maxLen = 2000): string {
    return input
      .replace(/\u0000/g, '')
      .replace(/[\uD800-\uDFFF]/g, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
      .slice(0, maxLen);
  }

  private buildHeaderExcerpt(text: string): string {
    const headerText = this.sanitizeDbText(text, 8000)
      .split(/\r?\n/)
      .slice(0, 30)
      .join('\n');
    const redacted = headerText
      .replace(/\b\d{15,18}[\dXx]\b/g, '[ID]')
      .replace(/\b1[3-9]\d{9}\b/g, '[PHONE]')
      .replace(/\b\d{10,19}\b/g, '[NUM]');
    return this.sanitizeDbText(redacted, 2000);
  }

  private classifyUnsupportedReason(
    errorMsg: string,
  ):
    | 'undetected_source'
    | 'empty_transactions'
    | 'csv_unsupported'
    | 'other_parse'
    | null {
    if (
      errorMsg.includes('不支持的账单格式') ||
      errorMsg.includes('未能在 CSV') ||
      errorMsg.includes('Excel 账单缺少') ||
      errorMsg.includes('Excel 工作表为空')
    ) {
      if (
        errorMsg.includes('CSV') ||
        errorMsg.includes('记账本') ||
        errorMsg.includes('Excel')
      ) {
        return errorMsg.includes('记账本') || errorMsg.includes('CSV')
          ? 'csv_unsupported'
          : 'other_parse';
      }
      return 'undetected_source';
    }
    if (errorMsg.includes('交易流水为空') || errorMsg.includes('格式不受支持')) {
      return 'empty_transactions';
    }
    if (errorMsg.includes('记账本') || errorMsg.includes('暂不支持解析')) {
      return 'csv_unsupported';
    }
    if (
      errorMsg.includes('格式') ||
      errorMsg.includes('不支持') ||
      errorMsg.includes('表头')
    ) {
      return 'other_parse';
    }
    return null;
  }

  private async safeLogUnsupportedFormat(data: {
    userId: number;
    queryRecordId: number;
    reason:
      | 'undetected_source'
      | 'empty_transactions'
      | 'csv_unsupported'
      | 'other_parse';
    originalFileName: string;
    storedFileName: string;
    fileSize: number;
    guessedSource?: string;
    headerExcerpt?: string;
    errorMessage: string;
  }): Promise<void> {
    try {
      const extMatch = data.originalFileName
        .toLowerCase()
        .match(/(\.[a-z0-9]+)$/);
      const fileExt = extMatch?.[1] || '.unknown';
      await this.prisma.unsupportedFormatLog.create({
        data: {
          userId: data.userId,
          queryRecordId: data.queryRecordId,
          reason: data.reason,
          originalFileName: this.sanitizeDbText(data.originalFileName, 500),
          storedFileName: this.sanitizeDbText(data.storedFileName, 500),
          fileExt: this.sanitizeDbText(fileExt, 32),
          fileSize: data.fileSize,
          guessedSource: data.guessedSource
            ? this.sanitizeDbText(data.guessedSource, 64)
            : null,
          headerExcerpt: this.sanitizeDbText(data.headerExcerpt || '', 2000),
          errorMessage: this.sanitizeDbText(data.errorMessage, 2000),
        },
      });
    } catch (e) {
      this.logger.error('Failed to write UnsupportedFormatLog', e as Error);
    }
  }

  private async assertRecordOwnership(recordId: number, userId: number) {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
      select: { userId: true },
    });
    if (!record) throw new NotFoundException('Record not found');
    if (!(await this.isOwnerOrAdmin(record.userId, userId))) {
      throw new ForbiddenException('无权访问该记录');
    }
  }

  private async isOwnerOrAdmin(
    recordUserId: number,
    userId: number,
  ): Promise<boolean> {
    if (recordUserId === userId) return true;
    const requestingUser = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
      select: { level: true },
    });
    return requestingUser?.level === 999;
  }

  private async getPersistedData(recordId: number): Promise<StatementData> {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
      select: {
        id: true,
        source: true,
        filePath: true,
        summaryJson: true,
        transactionsJson: true,
      },
    });
    if (!record) throw new NotFoundException('Record not found');

    if (!record.summaryJson || !record.transactionsJson) {
      return this.backfillLegacyRecord(
        record.id,
        record.source,
        record.filePath,
      );
    }

    const summary = {
      ...(record.summaryJson as any),
      id: record.id.toString(),
      source: (record.summaryJson as any)?.source || record.source,
    } as StatementSummary;

    const transactions = (record.transactionsJson as any[]).map((t) => ({
      date: t.date,
      month: t.month,
      type: t.type,
      amount: Number(t.amount) || 0,
      counterparty: t.counterparty || '未知',
    })) as Transaction[];

    return {
      summary: this.enrichSummary(summary),
      transactions,
    };
  }

  private async backfillLegacyRecord(
    recordId: number,
    source: string,
    fileName: string,
  ): Promise<StatementData> {
    const filePath = path.join(this.uploadsDir, fileName);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('文件已过期被清理或不存在');
    }

    const buffer = fs.readFileSync(filePath);
    let parsedData: StatementData;

    if (
      fileName.toLowerCase().endsWith('.xlsx') ||
      fileName.toLowerCase().endsWith('.xls')
    ) {
      parsedData = await this.parseXlsxFile(buffer);
    } else if (fileName.toLowerCase().endsWith('.csv')) {
      parsedData = await this.parseCsvFile(buffer);
    } else {
      const text = await this.parsePdfText(buffer);
      parsedData = this.extractData(text, source);
    }

    await this.prisma.queryRecord.update({
      where: { id: recordId },
      data: {
        source: parsedData.summary.source,
        summaryJson: parsedData.summary as any,
        transactionsJson: parsedData.transactions as any,
        startDate: this.parseDateOnlyToDate(parsedData.summary.startDate),
        endDate: this.parseDateOnlyToDate(parsedData.summary.endDate),
      },
    });

    this.logger.log(`Backfilled cached payload for legacy record ${recordId}`);

    return {
      summary: this.enrichSummary({
        ...parsedData.summary,
        id: recordId.toString(),
      }),
      transactions: parsedData.transactions,
    };
  }

  private enrichSummary(summary: StatementSummary): StatementSummary {
    const result = { ...summary };

    if (result.idNumber) {
      const idNum = result.idNumber;
      result.maskedIdNumber =
        idNum.length > 8
          ? idNum.slice(0, 4) + '*'.repeat(idNum.length - 8) + idNum.slice(-4)
          : idNum;

      try {
        const idcard = require('idcard');
        const info = idcard.info(idNum);
        if (info && info.valid) {
          result.nativePlace = info.address;
          result.genderText =
            info.gender === 'M' ? '男' : info.gender === 'F' ? '女' : '-';
          result.age = info.age;
        }
      } catch (e) {
        this.logger.error('Failed to parse ID card:', e);
      }
    }

    if (result.cardNumber) {
      const cardNum = result.cardNumber;
      result.maskedCardNumber =
        cardNum.length > 8
          ? cardNum.slice(0, 4) +
            '*'.repeat(cardNum.length - 8) +
            cardNum.slice(-4)
          : cardNum;
    }

    if (result.phoneNumber) {
      const phone = result.phoneNumber;
      result.maskedPhoneNumber =
        phone.length > 7
          ? phone.slice(0, 3) + '*'.repeat(phone.length - 7) + phone.slice(-4)
          : phone;
    }

    return result;
  }

  private pickResultMeta(summary: StatementSummary): StatementResultMeta {
    const {
      totalIncome: _ti,
      totalExpenditure: _te,
      selfIncome: _si,
      selfExpenditure: _se,
      idNumber: _id,
      cardNumber: _card,
      phoneNumber: _phone,
      ...meta
    } = summary;

    return meta;
  }

  private extractEndOfId(summary: StatementSummary): string | null {
    if (summary.idNumber) return summary.idNumber.slice(-6);
    if (summary.cardNumber) return summary.cardNumber.slice(-4);
    return null;
  }

  private async checkHighRisk(summary: StatementSummary): Promise<boolean> {
    if (!summary.name || summary.name === '未知') return false;

    const endOfId = this.extractEndOfId(summary);
    const params = new URLSearchParams({ name: summary.name });
    if (endOfId) params.set('end_of_id', endOfId);

    const url = queryServerUrl('/web-api/records/check-high-risk', params);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        this.logger.warn(`check-high-risk failed: ${response.status} ${text}`);
        return false;
      }

      const data = await response.json();
      return data?.result?.isHighRisk === true;
    } catch (err) {
      this.logger.warn('check-high-risk request error:', err);
      return false;
    }
  }

  async getRiskStatus(
    id: number,
    userId: number,
  ): Promise<{ isHighRisk: boolean }> {
    await this.assertRecordOwnership(id, userId);
    const record = await this.prisma.queryRecord.findUnique({
      where: { id },
      select: { summaryJson: true },
    });
    if (!record?.summaryJson) {
      return { isHighRisk: false };
    }
    const summary = record.summaryJson as unknown as StatementSummary;
    const isHighRisk = await this.checkHighRisk(summary);
    return { isHighRisk };
  }

  async getResultBundle(
    id: number,
    userId: number,
  ): Promise<StatementResultBundle> {
    await this.assertRecordOwnership(id, userId);
    const data = await this.getPersistedData(id);
    const summary = this.pickResultMeta(data.summary);

    let firstQueryTime: Date | null = null;
    let queryCount = 1;

    const record = await this.prisma.queryRecord.findUnique({
      where: { id },
      select: { statementUserId: true, createdAt: true },
    });

    if (record?.statementUserId) {
      const statementUser = await this.prisma.statementUser.findUnique({
        where: { id: record.statementUserId },
        select: { queryCount: true, createdAt: true },
      });
      if (statementUser) {
        queryCount = statementUser.queryCount;
        firstQueryTime = statementUser.createdAt;
      }
    }

    if (!firstQueryTime && record) {
      firstQueryTime = record.createdAt;
    }

    const classifiedTransactions = await this.classifyTransactionsForUser(
      userId,
      data.transactions,
    );

    return {
      summary: {
        ...summary,
        firstQueryTime: firstQueryTime ? firstQueryTime.toISOString() : null,
        queryCount,
      },
      raw: classifiedTransactions,
    };
  }

  async getCounterparties(id: number, userId: number) {
    await this.assertRecordOwnership(id, userId);
    const data = await this.getPersistedData(id);
    const map = new Map<string, { count: number; total: number }>();
    let grandTotal = 0;

    data.transactions.forEach((t) => {
      if (t.type !== '不计收支') {
        const entry = map.get(t.counterparty) || { count: 0, total: 0 };
        entry.count++;
        entry.total += t.amount;
        grandTotal += t.amount;
        map.set(t.counterparty, entry);
      }
    });

    const result = Array.from(map.entries()).map(([name, stats]) => ({
      name,
      count: stats.count,
      amount: stats.total,
      percentage:
        grandTotal > 0 ? ((stats.total / grandTotal) * 100).toFixed(2) : '0.00',
    }));

    result.sort((a, b) => b.amount - a.amount);
    return result;
  }

  private parseDateOnlyToDate(dateOnly: string) {
    if (!dateOnly) return null;
    const parsed = new Date(`${dateOnly}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCron() {
    this.logger.debug('Running daily cleanup job for old records and files.');
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

    const oldRecords = await this.prisma.queryRecord.findMany({
      where: { createdAt: { lt: sixtyDaysAgo } },
    });

    for (const record of oldRecords) {
      const filePath = path.join(this.uploadsDir, record.filePath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await this.prisma.queryRecord.deleteMany({
      where: { createdAt: { lt: sixtyDaysAgo } },
    });
    this.logger.debug(`Cleaned up ${oldRecords.length} old records.`);
  }

  // --- Parsing logic ---
  private detectSourceFromText(text: string): string | null {
    const headerText = text.split(/\r?\n/).slice(0, 30).join('\n');

    if (headerText.includes('微信支付交易明细证明')) {
      return '微信';
    }

    if (headerText.includes('招商银行交易流水')) {
      return '招商银行';
    }

    if (headerText.includes('交通银行个人客户交易清单')) {
      return '交通银行';
    }

    if (headerText.includes('中国工商银行借记账户历史明细')) {
      return '工商银行';
    }

    if (/农村商业银行股份有限公司\s+账户\/卡明细信息/.test(headerText)) {
      return '农商银行';
    }

    if (/支付宝支付科技有限公司\s+交易流水证明/.test(headerText)) {
      return '支付宝';
    }

    return null;
  }

  private extractData(text: string, source: string): StatementData {
    let name = '未知';
    let idNumber = '';
    let cardNumber = '';
    const transactions: Transaction[] = [];
    let startDate = '';
    let endDate = '';

    if (source === '微信') {
      const nameMatch = text.match(/兹证明：(.*?)\（居民身份证：(.*?)\）/);
      if (nameMatch) {
        name = nameMatch[1];
        idNumber = nameMatch[2];
      }

      const parsedTxs = this.parseWechatTransactions(text);
      transactions.push(...parsedTxs);
    } else if (source === '支付宝') {
      const nameMatch = text.match(/兹证明:(.*?)\(证件号码:(.*?)\)/);
      if (nameMatch) {
        name = nameMatch[1];
        idNumber = nameMatch[2];
      }
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const txs: string[][] = [];
      let currentTx: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          line.startsWith('支出 ') ||
          line.startsWith('收入 ') ||
          line === '不计' ||
          line.startsWith('不计 ')
        ) {
          if (currentTx.length > 0) txs.push(currentTx);
          currentTx = [line];
        } else {
          if (currentTx.length > 0) currentTx.push(line);
        }
      }
      if (currentTx.length > 0) txs.push(currentTx);

      for (const txLines of txs) {
        const fullText = txLines.join(' ');
        const typeMatch = fullText.match(/^(支出|收入|不计\s*收支)/);
        if (!typeMatch) continue;

        const typeStr = typeMatch[1].replace(/\s+/g, '');
        const type: '收入' | '支出' | '不计收支' = typeStr as any;

        const amountMatch = fullText.match(/\s([0-9]+\.[0-9]{2})\s/);
        if (!amountMatch) continue;

        const amount = parseFloat(amountMatch[1]);

        const dateMatch = fullText.match(
          /(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}:\d{2}))?/,
        );
        if (!dateMatch) continue;

        const date = dateMatch[2]
          ? `${dateMatch[1]} ${dateMatch[2]}`
          : dateMatch[1];
        const month = dateMatch[1].substring(0, 7);

        const counterparty =
          fullText.substring(typeMatch[0].length).trim().split(/\s+/)[0] ||
          '支付宝商户';

        const startIdx = fullText.indexOf(counterparty) + counterparty.length;
        const endIdx = fullText.indexOf(amountMatch[0]);
        let product = '';
        if (startIdx >= 0 && endIdx > startIdx) {
          product = fullText.substring(startIdx, endIdx).trim();
          product = product
            .replace(
              /(?:招商银行|交通银行|工商银行|建设银行|农业银行|中国银行|邮储银行|中信银行|光大银行|华夏银行|民生银行|广发银行|深发银行|招商|交行|工行|建行|农行|中行|网商银行|网商|花呗|余额宝|账户余额|余额|红包|储蓄卡|信用卡|借记卡)\(?[0-9]*\)?&?/g,
              '',
            )
            .trim();
        }

        transactions.push({ date, month, type, amount, counterparty, product });
      }
    } else if (source === '招商银行') {
      const nameMatch = text.match(/户\s*名[：:]\s*([^\s\n]+)/);
      if (nameMatch) {
        name = nameMatch[1];
      }
      const cardMatch = text.match(/账号[：:]\s*([\d*]+)/);
      if (cardMatch) {
        cardNumber = cardMatch[1];
      }
      const rangeMatch = text.match(
        /(\d{4}-\d{2}-\d{2})\s*--\s*(\d{4}-\d{2}-\d{2})/,
      );
      if (rangeMatch) {
        startDate = rangeMatch[1];
        endDate = rangeMatch[2];
      }
      transactions.push(...this.parseCmbTransactions(text));
    } else if (source === '交通银行') {
      const nameMatch = text.match(/Account Name:\s*([^\s\n]+)/);
      if (nameMatch) {
        name = nameMatch[1];
      }
      const cardMatch = text.match(/交通银行个人客户交易清单\s*\n\s*(\d{10,})/);
      if (cardMatch) {
        cardNumber = cardMatch[1];
      }
      const headerDates = text.match(/(\d{4}-\d{2}-\d{2})/g) || [];
      const queryDates = headerDates
        .slice(0, 20)
        .filter((d, i, arr) => arr.indexOf(d) === i)
        .sort();
      if (queryDates.length >= 2) {
        startDate = queryDates[0];
        endDate = queryDates[queryDates.length - 1];
      }
      transactions.push(...this.parseBocomTransactions(text));
    } else if (source === '工商银行') {
      const nameMatch = text.match(/户名：(.*?)\s+/);
      if (nameMatch) {
        name = nameMatch[1];
      }
      const cardMatch = text.match(/卡号\s+(\d+)/);
      if (cardMatch) {
        cardNumber = cardMatch[1];
      }
      const rangeMatch = text.match(
        /起止日期：(\d{4}-\d{2}-\d{2})\s*—\s*(\d{4}-\d{2}-\d{2})/,
      );
      if (rangeMatch) {
        startDate = rangeMatch[1];
        endDate = rangeMatch[2];
      }

      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      let currentDate = '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\d{4}-\d{2}-\d{2}$/.test(line)) {
          currentDate = line;
          continue;
        }

        const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2})/);
        if (timeMatch && currentDate) {
          const match = line.match(
            /^(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([+-][0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s*(.*?)$/,
          );
          if (match) {
            const time = match[1];
            const date = `${currentDate} ${time}`;
            const month = currentDate.substring(0, 7);
            const abstract = match[7];
            const amountStr = match[9].replace(/,/g, '');
            const amountNum = parseFloat(amountStr);
            const type = amountNum < 0 ? '支出' : '收入';
            const amount = Math.abs(amountNum);
            const channel = match[11] || '';
            const counterparty = channel ? `${abstract}-${channel}` : abstract;

            transactions.push({ date, month, type, amount, counterparty });
          }
        }
      }
    } else if (source === '农商银行') {
      const nameMatch = text.match(/户名：(.*?)\s+/);
      if (nameMatch) {
        name = nameMatch[1];
      }
      const cardMatch = text.match(/账号\/卡号：(.*?)\s+/);
      if (cardMatch) {
        cardNumber = cardMatch[1];
      }
      const rangeMatch = text.match(/起止日期:(.*?)\s+到\s+(.*?)\s+/);
      if (rangeMatch) {
        startDate = rangeMatch[1];
        endDate = rangeMatch[2];
      }

      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const blocks: Array<{ date: string; lines: string[] }> = [];
      let currentBlock: { date: string; lines: string[] } | null = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/^\d{4}-\d{2}-\d{2}$/.test(line)) {
          const nextLine = lines[i + 1] || '';
          if (/^\d{2}:\d{2}:\d{2}\b/.test(nextLine)) {
            if (currentBlock) blocks.push(currentBlock);
            currentBlock = {
              date: line,
              lines: [],
            };
            continue;
          }
        }

        if (currentBlock) {
          if (
            line.includes('广东顺德农村商业银行') ||
            line.includes('账户/卡明细信息') ||
            line.includes('起止日期') ||
            line.includes('交易时间') ||
            line.startsWith('————') ||
            line.startsWith('累计存入笔数') ||
            line.startsWith('总交易笔数') ||
            line.startsWith('END') ||
            line.startsWith('打印机构')
          ) {
            continue;
          }
          currentBlock.lines.push(line);
        }
      }
      if (currentBlock) blocks.push(currentBlock);

      for (const block of blocks) {
        const dateOnly = block.date;
        const blockText = block.lines.join(' ');

        const match = blockText.match(
          /^(\d{2}:\d{2}:\d{2})\s+(\S+)\s+([+-][0-9,]+\.[0-9]{2})\s+(.*?)$/,
        );
        if (match) {
          const time = match[1];
          const date = `${dateOnly} ${time}`;
          const month = dateOnly.substring(0, 7);
          const amountStr = match[3].replace(/,/g, '');
          const amountNum = parseFloat(amountStr);
          const type = amountNum < 0 ? '支出' : '收入';
          const amount = Math.abs(amountNum);
          const remainder = match[4].trim();

          const balanceMatch = remainder.match(
            /\s([0-9,]+\.[0-9]{2})\s+(\S+渠道|核心渠道|网上渠道|快捷渠道|自助渠道|柜面渠道|其他渠道)\s+(\S+)\s*(.*?)$/,
          );

          let counterparty = '';
          if (balanceMatch) {
            const balance = balanceMatch[1];
            const channel = balanceMatch[2];
            const summary = balanceMatch[3];
            const memo = balanceMatch[4];
            const opponentText = remainder
              .substring(0, remainder.indexOf(balanceMatch[0]))
              .trim();
            const nameAndBank = opponentText
              .replace(/\b\d+(\s+\d+)?\b/g, '')
              .trim()
              .replace(/\s+/g, ' ');

            counterparty = nameAndBank || opponentText || summary;
            if (channel && channel !== '核心渠道') {
              counterparty += ` (${channel})`;
            }
          } else {
            counterparty = remainder.split(/\s+/)[0] || '未知';
          }

          counterparty = counterparty.replace(/\s*\/\s*$/, '').trim();
          transactions.push({ date, month, type, amount, counterparty });
        }
      }
    }

    transactions.sort((a, b) => a.date.localeCompare(b.date));
    if (transactions.length > 0) {
      const toDateOnly = (d: string) =>
        d.length >= 10 ? d.substring(0, 10) : d;
      if (!startDate) startDate = toDateOnly(transactions[0].date);
      if (!endDate)
        endDate = toDateOnly(transactions[transactions.length - 1].date);
    }

    // 按降序排列记录
    transactions.reverse();

    let totalIncome = 0;
    let totalExpenditure = 0;
    let selfIncome = 0;
    let selfExpenditure = 0;

    transactions.forEach((t) => {
      if (t.type === '收入') {
        totalIncome += t.amount;
        if (
          t.counterparty.includes(name) ||
          t.counterparty.includes('转入到余利宝')
        )
          selfIncome += t.amount;
      } else if (t.type === '支出') {
        totalExpenditure += t.amount;
        if (
          t.counterparty.includes(name) ||
          t.counterparty.includes('转入到余利宝')
        )
          selfExpenditure += t.amount;
      }
    });

    totalIncome = Number(totalIncome.toFixed(2));
    totalExpenditure = Number(totalExpenditure.toFixed(2));
    selfIncome = Number(selfIncome.toFixed(2));
    selfExpenditure = Number(selfExpenditure.toFixed(2));

    return {
      summary: {
        id: '',
        source,
        name,
        idNumber,
        cardNumber,
        startDate,
        endDate,
        totalIncome,
        totalExpenditure,
        selfIncome,
        selfExpenditure,
      },
      transactions,
    };
  }

  private isCmbTransactionLine(line: string): boolean {
    return /^\d{4}-\d{2}-\d{2}\s+CNY\s+/.test(line);
  }

  private shouldSkipCmbNoiseLine(line: string): boolean {
    return (
      line.startsWith('--') ||
      /^\d+\/\d+$/.test(line) ||
      line.includes('记账日期') ||
      line.includes('Transaction Statement') ||
      line.includes('招商银行交易流水') ||
      line.includes('Transaction Statement of China Merchants Bank') ||
      line.includes('Date Currency') ||
      line.includes('Amount Balance') ||
      line.includes('Transaction Type') ||
      line.includes('Counter Party') ||
      line.includes('温馨提示') ||
      line.includes('www.cmbchina') ||
      line.includes('Verification Code') ||
      line.includes('Account Type') ||
      line.includes('Account No') ||
      line.includes('Sub Branch') ||
      line === 'Name' ||
      line === 'Date' ||
      line.startsWith('Account ')
    );
  }

  private dedupeTransactions(transactions: Transaction[]): Transaction[] {
    const seen = new Set<string>();
    const result: Transaction[] = [];
    for (const tx of transactions) {
      const key = `${tx.date}|${tx.type}|${tx.amount}|${tx.counterparty}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(tx);
    }
    return result;
  }

  private parseCmbTransactions(text: string): Transaction[] {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const mergedLines: string[] = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!this.isCmbTransactionLine(line)) {
        i++;
        continue;
      }

      let merged = line;
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (
          this.isCmbTransactionLine(next) ||
          this.shouldSkipCmbNoiseLine(next)
        ) {
          break;
        }
        merged += next;
        i++;
      }
      mergedLines.push(merged);
    }

    const rowRe =
      /^(\d{4}-\d{2}-\d{2})\s+CNY\s+(-?[0-9,]+\.[0-9]{2})\s+[0-9,]+\.[0-9]{2}\s+(.+)$/;

    const transactions: Transaction[] = [];
    for (const line of mergedLines) {
      const match = line.match(rowRe);
      if (!match) continue;

      const date = match[1];
      const month = date.substring(0, 7);
      const amountNum = parseFloat(match[2].replace(/,/g, ''));
      const type: '收入' | '支出' = amountNum < 0 ? '支出' : '收入';
      const amount = Math.abs(amountNum);

      const remainder = match[3].trim();
      const spaceIdx = remainder.indexOf(' ');
      const counterparty =
        spaceIdx >= 0 ? remainder.slice(spaceIdx + 1).trim() : remainder;

      transactions.push({
        date,
        month,
        type,
        amount,
        counterparty: counterparty || '未知',
      });
    }

    return this.dedupeTransactions(transactions);
  }

  private parseBocomTransactions(text: string): Transaction[] {
    const transactions: Transaction[] = [];
    const lines = text.split('\n');
    let buffer = '';

    const tryParseBuffer = (raw: string) => {
      const line = raw.replace(/\s+/g, ' ').trim();
      const match = line.match(
        /^(\d{4}-\d{2}-\d{2})\s+(.+)\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s+(.+?)\s+(贷\s*Cr|借\s*Dr)\s*$/i,
      );
      if (!match) return false;

      const date = match[1];
      const month = date.substring(0, 7);
      const counterparty = match[2].trim();
      const amount = Math.abs(parseFloat(match[4].replace(/,/g, '')));
      const summary = match[5].trim();
      const dcFlag = match[6];
      const type: '收入' | '支出' = /贷/.test(dcFlag) ? '收入' : '支出';

      transactions.push({
        date,
        month,
        type,
        amount,
        counterparty: counterparty || summary || '未知',
      });
      return true;
    };

    const isSkippableLine = (line: string) =>
      !line ||
      line.startsWith('--') ||
      line.includes('Trans Date') ||
      line.includes('交易日期') ||
      line.includes('Bank of Communications') ||
      line.includes('交通银行个人客户交易清单') ||
      line.includes('Query Result') ||
      line.includes('Account Name') ||
      line.includes('Account/Card No') ||
      /^\d{10,}$/.test(line);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (isSkippableLine(line)) continue;

      if (/^\d{4}-\d{2}-\d{2}\s/.test(line)) {
        if (buffer && tryParseBuffer(buffer)) {
          buffer = '';
        }
        buffer = line;
        if (tryParseBuffer(buffer)) {
          buffer = '';
        }
        continue;
      }

      if (buffer) {
        buffer += line;
        if (tryParseBuffer(buffer)) {
          buffer = '';
        }
      }
    }

    if (buffer) {
      tryParseBuffer(buffer);
    }

    return transactions;
  }

  private parseWechatTransactions(text: string): Transaction[] {
    const transactions: Transaction[] = [];
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // 1. Find all transaction anchors (ID start index, date index, time index)
    const anchors: Array<{
      idStartIdx: number;
      dateIdx: number;
      timeIdx: number;
      date: string;
      time: string;
      transactionId: string;
    }> = [];

    for (let idx = 0; idx < lines.length; idx++) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(lines[idx])) {
        if (
          idx + 1 < lines.length &&
          /^\d{2}:\d{2}:\d{2}$/.test(lines[idx + 1])
        ) {
          const txDate = lines[idx];
          const txTime = lines[idx + 1];

          // Find preceding transaction ID lines
          let idStartIdx = idx;
          let combinedId = '';
          for (let k = 1; k <= 3; k++) {
            const prevIdx = idx - k;
            if (prevIdx >= 0 && /^[0-9]+$/.test(lines[prevIdx])) {
              combinedId = lines[prevIdx] + combinedId;
              idStartIdx = prevIdx;
            } else {
              if (combinedId.length > 0) break;
            }
          }

          // Validate transaction ID matches the date (allowing 1 day tolerance)
          const isMatchedId = this.validateWechatTxId(combinedId, txDate);

          anchors.push({
            idStartIdx: isMatchedId ? idStartIdx : idx,
            dateIdx: idx,
            timeIdx: idx + 1,
            date: txDate,
            time: txTime,
            transactionId: isMatchedId ? combinedId : '',
          });
        }
      }
    }

    // 2. Extract transaction blocks based on adjacent anchor boundaries
    for (let idx = 0; idx < anchors.length; idx++) {
      const anchor = anchors[idx];
      const nextAnchor = anchors[idx + 1];
      const blockEndIdx = nextAnchor ? nextAnchor.idStartIdx : lines.length;

      // Extract raw lines after the time index and before the next transaction starts
      const rawBlockLines = lines.slice(anchor.timeIdx + 1, blockEndIdx);

      // Filter out footer/header noise
      const blockLines = rawBlockLines.filter((line) => {
        if (line.startsWith('-- ')) return false;
        if (line.includes('微信支付交易明细证明')) return false;
        if (line.includes('兹证明')) return false;
        if (line.includes('具体交易明细')) return false;
        if (line.includes('交易单号 交易时间')) return false;
        if (line.startsWith('说明：')) return false;
        return true;
      });

      const blockText = blockLines.join(' ');
      const amountLineIdx = blockLines.findIndex((l) => /\d+\.\d{2}/.test(l));

      if (amountLineIdx >= 0) {
        const amountLine = blockLines[amountLineIdx];
        const hasOther = /(?:^|\s|\/)其他(?:\s|\/|$)/.test(blockText);
        const hasIncome =
          /\s收入(?:\s|\/)/.test(amountLine) || /\s收入\s/.test(blockText);
        const hasExpense =
          /\s支出\s/.test(amountLine) || /\s支出\s/.test(blockText);
        const isOtherType = hasOther && !hasIncome && !hasExpense;

        let type: '收入' | '支出' | '不计收支' = '支出';
        if (isOtherType) type = '不计收支';
        else if (hasIncome) type = '收入';
        else if (hasExpense) type = '支出';
        else if (/不计/.test(blockText)) type = '不计收支';

        const amountMatch = amountLine.match(/(\d+\.\d{2})/);
        if (amountMatch) {
          const amount = parseFloat(amountMatch[1]);
          const dateTime = `${anchor.date} ${anchor.time}`;
          const month = anchor.date.substring(0, 7);

          let counterparty = '';
          let bizType = '';
          let product = '';
          if (isOtherType) {
            const parts = blockText.split(/(?:^|\s|\/)其他(?:\s|\/|$)/);
            counterparty = parts[0].replace(/\s+/g, '').trim();
            if (!counterparty) counterparty = '/';
            bizType = '其他';
            product = blockLines.slice(0, amountLineIdx).join('').trim();
          } else {
            bizType = this.extractWechatBizType(amountLine);
            product = blockLines.slice(0, amountLineIdx).join('').trim();
            counterparty = this.extractWechatCounterparty(
              amountLine
                .slice(
                  amountLine.indexOf(amountMatch[0]) + amountMatch[0].length,
                )
                .trim(),
              blockLines.slice(amountLineIdx + 1),
            );
          }

          transactions.push({
            date: dateTime,
            month,
            type,
            amount,
            counterparty,
            bizType,
            product,
          });
        }
      }
    }

    return transactions;
  }

  private validateWechatTxId(id: string, dateStr: string): boolean {
    if (id.length < 24 || id.length > 40) return false;

    const dates = [dateStr];
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const prev = new Date(d);
      prev.setDate(d.getDate() - 1);
      dates.push(prev.toISOString().split('T')[0]);

      const next = new Date(d);
      next.setDate(d.getDate() + 1);
      dates.push(next.toISOString().split('T')[0]);
    }

    return dates.some((dt) => {
      const yyyymmdd = dt.replace(/-/g, '');
      const yymmdd = yyyymmdd.substring(2);
      return id.includes(yyyymmdd) || id.includes(yymmdd);
    });
  }

  private extractWechatBizType(amountLine: string): string {
    const match = amountLine.match(/^(.+?)\s+(?:收入|支出|其他|不计收支)/);
    if (match) {
      return match[1].replace(/\s+/g, '').trim();
    }
    const fallback = amountLine.match(
      /^(商户消费|微信红包(?:\(单发\))?|转账|扫二维码付款|二维码收款|零钱通|提现|退款)/,
    );
    return fallback ? fallback[1].replace(/\s+/g, '').trim() : '';
  }

  private extractWechatCounterparty(
    sameLine: string,
    nextLines: string[],
  ): string {
    const parts: string[] = [];

    // Process the same line as the amount — split by whitespace, stop at first merchant-ID token
    if (sameLine) {
      const tokens = sameLine.split(/\s+/);
      for (const token of tokens) {
        if (token && this.isWechatMerchantId(token)) break;
        if (token) parts.push(token);
      }
    }

    // Process subsequent block lines
    for (const line of nextLines) {
      if (!line) continue;
      if (line === '/') break;
      if (this.isWechatMerchantId(line)) break;
      if (line.startsWith('--') || line.startsWith('说明')) break;
      parts.push(line);
    }

    return parts.join('').trim() || '未知';
  }

  private isWechatMerchantId(str: string): boolean {
    return str === '/' || (str.length >= 10 && /^[0-9a-zA-Z_\-]+$/.test(str));
  }

  // --- Dynamic Classification Engine ---
  async saveUserCustomCategory(
    userId: number,
    counterparty: string,
    category: string,
  ) {
    return this.prisma.userCustomCategory.upsert({
      where: {
        userId_counterparty: {
          userId,
          counterparty,
        },
      },
      update: {
        category,
      },
      create: {
        userId,
        counterparty,
        category,
      },
    });
  }

  async getUserCustomCategories(userId: number) {
    return this.prisma.userCustomCategory.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getCategories() {
    const dbCategories = await this.prisma.globalCategoryKeyword.findMany({
      distinct: ['category'],
      select: { category: true },
    });

    const dbSet = new Set(dbCategories.map((c) => c.category));
    const coreCategories = [
      '餐饮',
      '购物',
      '交通',
      '娱乐',
      '服务',
      '转账',
      '收入',
      '其他',
    ];

    const allCategories = [...coreCategories];
    for (const cat of dbSet) {
      if (cat && !allCategories.includes(cat)) {
        const otherIndex = allCategories.indexOf('其他');
        if (otherIndex !== -1) {
          allCategories.splice(otherIndex, 0, cat);
        } else {
          allCategories.push(cat);
        }
      }
    }

    return allCategories;
  }

  async classifyTransactionsForUser(
    userId: number,
    transactions: Transaction[],
  ): Promise<Transaction[]> {
    // 1. Fetch user custom categories
    const userCustomList = await this.prisma.userCustomCategory.findMany({
      where: { userId },
    });
    const userCustomMap = new Map<string, string>();
    for (const uc of userCustomList) {
      userCustomMap.set(uc.counterparty.trim(), uc.category);
    }

    // 2. Fetch global keywords
    const globalKeywordsList =
      await this.prisma.globalCategoryKeyword.findMany();

    const globalKeywordsMap = new Map<string, string[]>();
    for (const gk of globalKeywordsList) {
      const list = globalKeywordsMap.get(gk.category) || [];
      list.push(gk.keyword.trim());
      globalKeywordsMap.set(gk.category, list);
    }

    // 3. Classify transactions
    return transactions.map((t) => {
      const category = this.determineCategory(
        t,
        userCustomMap,
        globalKeywordsMap,
      );
      return {
        ...t,
        category,
      };
    });
  }

  private determineCategory(
    tx: Transaction,
    userCustomMap: Map<string, string>,
    globalKeywordsMap: Map<string, string[]>,
  ): string {
    const counterparty = (tx.counterparty || '').trim();
    const product = (tx.product || '').trim();
    const bizType = (tx.bizType || '').trim();
    const type = tx.type; // '收入' | '支出' | '不计收支'
    const combined = `${counterparty}${product}`;

    // 1. User custom override has highest priority
    if (userCustomMap.has(counterparty)) {
      return userCustomMap.get(counterparty)!;
    }

    // 2. Income rule
    if (type === '收入') {
      return '收入';
    }

    // 3. Transfer rule
    const isTransferType =
      bizType === '转账' ||
      bizType.includes('转账') ||
      bizType.includes('朋友转账');
    const transferKeywords = globalKeywordsMap.get('转账') || [];
    const matchesTransferKeyword = transferKeywords.some((kw) =>
      combined.includes(kw),
    );

    if (isTransferType || matchesTransferKeyword) {
      return '转账';
    }

    // 4. Global keywords match for other categories
    const categories = ['餐饮', '购物', '交通', '娱乐', '服务'];
    for (const cat of categories) {
      const kws = globalKeywordsMap.get(cat) || [];
      if (kws.some((kw) => combined.includes(kw) || bizType.includes(kw))) {
        return cat;
      }
    }

    return '其他';
  }

  private async parseXlsxFile(buffer: Buffer): Promise<StatementData> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new BadRequestException('Excel 工作表为空');
    }

    let name = '未知';
    let startDate = '';
    let endDate = '';
    let headerRowIndex = -1;

    // 扫描前 50 行以寻找元数据和表头所在行
    const limit = Math.min(50, worksheet.rowCount);
    for (let i = 1; i <= limit; i++) {
      const row = worksheet.getRow(i);
      const firstCellVal = row.getCell(1).value;
      if (typeof firstCellVal === 'string') {
        if (firstCellVal.includes('微信昵称：')) {
          const nameMatch = firstCellVal.match(/微信昵称：\[?(.*?)\]?$/);
          if (nameMatch) {
            name = nameMatch[1].replace(/^\[|\]$/g, '');
          }
        }
        if (firstCellVal.includes('起始时间：')) {
          const rangeMatch = firstCellVal.match(
            /起始时间：\[?(.*?)\]?\s+终止时间：\[?(.*?)\]?$/,
          );
          if (rangeMatch) {
            const startClean = rangeMatch[1].replace(/^\[|\]$/g, '');
            const endClean = rangeMatch[2].replace(/^\[|\]$/g, '');
            startDate = startClean.split(' ')[0];
            endDate = endClean.split(' ')[0];
          }
        }
        if (firstCellVal.trim() === '交易时间') {
          headerRowIndex = i;
        }
      }
    }

    if (headerRowIndex === -1) {
      throw new BadRequestException(
        '未能在 Excel 文件中找到包含“交易时间”的表头行',
      );
    }

    // 动态映射列
    const headerRow = worksheet.getRow(headerRowIndex);
    const colMap: { [key: string]: number } = {};
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const val = cell.value;
      if (typeof val === 'string') {
        colMap[val.trim()] = colNumber;
      }
    });

    const requiredHeaders = ['交易时间', '收/支', '金额(元)', '交易对方'];
    for (const req of requiredHeaders) {
      if (!colMap[req]) {
        throw new BadRequestException(`Excel 账单缺少必要的列: ${req}`);
      }
    }

    const formatWechatExcelDate = (
      cellVal: any,
    ): { dateStr: string; monthStr: string } => {
      let dateObj: Date;
      if (cellVal instanceof Date) {
        dateObj = cellVal;
      } else if (typeof cellVal === 'string') {
        dateObj = new Date(cellVal);
      } else if (
        cellVal &&
        typeof cellVal === 'object' &&
        cellVal.result instanceof Date
      ) {
        dateObj = cellVal.result;
      } else {
        return { dateStr: '', monthStr: '' };
      }

      if (Number.isNaN(dateObj.getTime())) {
        return { dateStr: '', monthStr: '' };
      }

      // 微信账单为 UTC+08:00 时间。增加 8 小时偏移量，使用 UTC 方法格式化以保证时区无关性
      const tzOffsetMs = 8 * 60 * 60 * 1000;
      const localTime = new Date(dateObj.getTime() + tzOffsetMs);
      const pad = (num: number) => String(num).padStart(2, '0');

      const year = localTime.getUTCFullYear();
      const month = pad(localTime.getUTCMonth() + 1);
      const day = pad(localTime.getUTCDate());
      const hours = pad(localTime.getUTCHours());
      const minutes = pad(localTime.getUTCMinutes());
      const seconds = pad(localTime.getUTCSeconds());

      const dateStr = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
      const monthStr = `${year}-${month}`;
      return { dateStr, monthStr };
    };

    const transactions: Transaction[] = [];
    for (let i = headerRowIndex + 1; i <= worksheet.rowCount; i++) {
      const row = worksheet.getRow(i);
      const dateCellVal = row.getCell(colMap['交易时间']).value;
      if (!dateCellVal) continue; // 跳过空行

      const { dateStr, monthStr } = formatWechatExcelDate(dateCellVal);
      if (!dateStr) continue;

      const bizType = String(
        row.getCell(colMap['交易类型'] || 2).value || '',
      ).trim();
      const counterparty = String(
        row.getCell(colMap['交易对方'] || 3).value || '未知',
      ).trim();
      const product = String(
        row.getCell(colMap['商品'] || 4).value || '',
      ).trim();
      const typeStr = String(
        row.getCell(colMap['收/支'] || 5).value || '',
      ).trim();

      let type: '收入' | '支出' | '不计收支' = '不计收支';
      if (typeStr === '收入') type = '收入';
      else if (typeStr === '支出') type = '支出';

      const amountVal = row.getCell(colMap['金额(元)'] || 6).value;
      const amount = Number(amountVal) || 0;

      transactions.push({
        date: dateStr,
        month: monthStr,
        type,
        amount,
        counterparty,
        bizType,
        product,
      });
    }

    // 按交易时间排序
    transactions.sort((a, b) => a.date.localeCompare(b.date));

    if (transactions.length > 0) {
      if (!startDate) startDate = transactions[0].date.substring(0, 10);
      if (!endDate)
        endDate = transactions[transactions.length - 1].date.substring(0, 10);
    }

    // 倒序排列（新交易在最上面）
    transactions.reverse();

    let totalIncome = 0;
    let totalExpenditure = 0;
    let selfIncome = 0;
    let selfExpenditure = 0;

    transactions.forEach((t) => {
      if (t.type === '收入') {
        totalIncome += t.amount;
        if (
          t.counterparty.includes(name) ||
          t.counterparty.includes('转入到余利宝')
        )
          selfIncome += t.amount;
      } else if (t.type === '支出') {
        totalExpenditure += t.amount;
        if (
          t.counterparty.includes(name) ||
          t.counterparty.includes('转入到余利宝')
        )
          selfExpenditure += t.amount;
      }
    });

    totalIncome = Number(totalIncome.toFixed(2));
    totalExpenditure = Number(totalExpenditure.toFixed(2));
    selfIncome = Number(selfIncome.toFixed(2));
    selfExpenditure = Number(selfExpenditure.toFixed(2));

    return {
      summary: {
        id: '',
        source: '微信',
        name,
        idNumber: '',
        cardNumber: '',
        startDate,
        endDate,
        totalIncome,
        totalExpenditure,
        selfIncome,
        selfExpenditure,
      },
      transactions,
    };
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  private formatDateStr(str: string): { dateStr: string; monthStr: string } {
    const clean = str.trim().replace(/\//g, '-');
    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(clean)) {
      return { dateStr: clean, monthStr: clean.substring(0, 7) };
    }
    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(clean)) {
      return { dateStr: `${clean}:00`, monthStr: clean.substring(0, 7) };
    }
    const d = new Date(clean);
    if (Number.isNaN(d.getTime())) {
      return { dateStr: '', monthStr: '' };
    }
    const pad = (num: number) => String(num).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return { dateStr, monthStr: dateStr.substring(0, 7) };
  }

  private async parseCsvFile(buffer: Buffer): Promise<StatementData> {
    let text = '';
    try {
      const decoder = new TextDecoder('gbk');
      text = decoder.decode(buffer);
      if (
        !text.includes('特别提示') &&
        !text.includes('支付宝') &&
        !text.includes('记录时间')
      ) {
        const utf8Decoder = new TextDecoder('utf-8');
        text = utf8Decoder.decode(buffer);
      }
    } catch (e) {
      const utf8Decoder = new TextDecoder('utf-8');
      text = utf8Decoder.decode(buffer);
    }

    // Check if it is Alipay Cashbook and reject it
    if (
      text.includes('本记账单内容可表明') ||
      text.includes('记录时间,分类,收支类型') ||
      text.includes('支付宝受理了相应记账明细申请')
    ) {
      throw new BadRequestException(
        '暂不支持解析支付宝记账本流水，请上传正确的支付宝交易明细CSV文件。',
      );
    }

    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let name = '匿名';
    let phoneNumber = '';
    let startDate = '';
    let endDate = '';
    let headerIndex = -1;

    // Scan up to 50 lines for metadata and header row
    const limit = Math.min(50, lines.length);
    for (let i = 0; i < limit; i++) {
      const line = lines[i];
      if (line.includes('姓名：') || line.includes('姓名:')) {
        const parts = line.split(/：|:/);
        if (parts.length > 1) {
          name = parts[1].trim().replace(/^\[|\]$/g, '');
        }
      }
      if (line.includes('支付宝账户：') || line.includes('支付宝账户:')) {
        const parts = line.split(/：|:/);
        if (parts.length > 1) {
          phoneNumber = parts[1].trim().replace(/^\[|\]$/g, '');
        }
      }
      if (line.includes('起始时间：') || line.includes('起始时间:')) {
        const rangeMatch =
          line.match(
            /(?:起始时间)：\s*\[?(.*?)\]?\s+(?:终止时间)：\s*\[?(.*?)\]?$/,
          ) ||
          line.match(
            /(?:起始时间):\s*\[?(.*?)\]?\s+(?:终止时间):\s*\[?(.*?)\]?$/,
          );
        if (rangeMatch) {
          const startClean = rangeMatch[1].replace(/^\[|\]$/g, '');
          const endClean = rangeMatch[2].replace(/^\[|\]$/g, '');
          startDate = startClean.split(' ')[0];
          endDate = endClean.split(' ')[0];
        }
      }
      if (
        line.includes('交易时间') &&
        line.includes('金额') &&
        (line.includes('收/支') || line.includes('收支'))
      ) {
        headerIndex = i;
        break;
      }
    }

    if (headerIndex === -1) {
      throw new BadRequestException(
        '未能在 CSV 文件中找到包含“交易时间”与“金额”的表头行',
      );
    }

    const headerRow = lines[headerIndex];
    const headers = this.parseCsvLine(headerRow);
    const colMap: { [key: string]: number } = {};
    headers.forEach((h, colNumber) => {
      const cleanVal = h.trim();
      if (
        cleanVal === '交易时间' ||
        cleanVal === '记录时间' ||
        cleanVal === '时间'
      ) {
        colMap['交易时间'] = colNumber;
      } else if (
        cleanVal === '收/支' ||
        cleanVal === '收支' ||
        cleanVal === '收支类型'
      ) {
        colMap['收/支'] = colNumber;
      } else if (
        cleanVal === '金额' ||
        cleanVal === '金额(元)' ||
        cleanVal === '金额（元）'
      ) {
        colMap['金额(元)'] = colNumber;
      } else if (
        cleanVal === '交易对方' ||
        cleanVal === '商户' ||
        cleanVal === '对方'
      ) {
        colMap['交易对方'] = colNumber;
      } else if (
        cleanVal === '商品说明' ||
        cleanVal === '商品' ||
        cleanVal === '商品名称'
      ) {
        colMap['商品'] = colNumber;
      } else if (
        cleanVal === '交易分类' ||
        cleanVal === '分类' ||
        cleanVal === '交易类型'
      ) {
        colMap['交易类型'] = colNumber;
      } else if (cleanVal === '备注') {
        colMap['备注'] = colNumber;
      } else if (
        cleanVal === '收/付款方式' ||
        cleanVal === '账户' ||
        cleanVal === '资金渠道' ||
        cleanVal === '付款方式'
      ) {
        colMap['支付方式'] = colNumber;
      }
    });

    const getVal = (rowCells: string[], headerKey: string): string => {
      const idx = colMap[headerKey];
      if (idx === undefined || idx >= rowCells.length) return '';
      return rowCells[idx].trim();
    };

    const transactions: Transaction[] = [];
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (line.startsWith('---') || line.startsWith('===')) continue;

      const cells = this.parseCsvLine(line);
      const timeStr = getVal(cells, '交易时间');
      if (!timeStr) continue;

      const { dateStr, monthStr } = this.formatDateStr(timeStr);
      if (!dateStr) continue;

      const bizType = getVal(cells, '交易类型');
      const typeStr = getVal(cells, '收/支');
      let type: '收入' | '支出' | '不计收支' = '不计收支';
      if (typeStr === '收入') type = '收入';
      else if (typeStr === '支出') type = '支出';

      const amountStr = getVal(cells, '金额(元)').replace(/，|,/g, '');
      const amount = parseFloat(amountStr) || 0;

      let counterparty = getVal(cells, '交易对方');
      const product = getVal(cells, '商品') || getVal(cells, '备注') || '';

      if (!counterparty) {
        counterparty = '支付宝商户';
      }

      transactions.push({
        date: dateStr,
        month: monthStr,
        type,
        amount,
        counterparty,
        bizType,
        product,
      });
    }

    // 按交易时间排序
    transactions.sort((a, b) => a.date.localeCompare(b.date));

    if (transactions.length > 0) {
      if (!startDate) startDate = transactions[0].date.substring(0, 10);
      if (!endDate)
        endDate = transactions[transactions.length - 1].date.substring(0, 10);
    }

    // 倒序排列（新交易在最上面）
    transactions.reverse();

    let totalIncome = 0;
    let totalExpenditure = 0;
    let selfIncome = 0;
    let selfExpenditure = 0;

    transactions.forEach((t) => {
      if (t.type === '收入') {
        totalIncome += t.amount;
        if (
          t.counterparty.includes(name) ||
          t.counterparty.includes('转入到余利宝') ||
          t.counterparty.includes('余额宝')
        )
          selfIncome += t.amount;
      } else if (t.type === '支出') {
        totalExpenditure += t.amount;
        if (
          t.counterparty.includes(name) ||
          t.counterparty.includes('转入到余利宝') ||
          t.counterparty.includes('余额宝')
        )
          selfExpenditure += t.amount;
      }
    });

    totalIncome = Number(totalIncome.toFixed(2));
    totalExpenditure = Number(totalExpenditure.toFixed(2));
    selfIncome = Number(selfIncome.toFixed(2));
    selfExpenditure = Number(selfExpenditure.toFixed(2));

    return {
      summary: {
        id: '',
        source: '支付宝',
        name,
        idNumber: '',
        cardNumber: '',
        phoneNumber,
        startDate,
        endDate,
        totalIncome,
        totalExpenditure,
        selfIncome,
        selfExpenditure,
      },
      transactions,
    };
  }
}
