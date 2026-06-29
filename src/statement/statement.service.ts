import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PDFParse, PasswordException } from 'pdf-parse';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const QUERY_SERVER_URL = process.env.QUERY_SERVER_URL || 'https://www.xinde8888.com/api/query_info/persons/query-record';

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
  nativePlace?: string;
  genderText?: string;
  age?: number;
}

export interface Transaction {
  date: string;
  month: string;
  type: '收入' | '支出' | '不计收支';
  amount: number;
  counterparty: string;
}

export interface StatementData {
  summary: StatementSummary;
  transactions: Transaction[];
}

export interface StatementResultMeta {
  id: string;
  source: string;
  name: string;
  idNumber: string;
  cardNumber?: string;
  startDate: string;
  endDate: string;
  maskedIdNumber?: string;
  maskedCardNumber?: string;
  nativePlace?: string;
  genderText?: string;
  age?: number;
  firstQueryTime?: string | null;
  queryCount?: number;
}

export interface StatementResultBundle {
  summary: StatementResultMeta;
  raw: Transaction[];
}

@Injectable()
export class StatementService {
  private uploadsDir = path.join(process.cwd(), 'uploads');
  private readonly logger = new Logger(StatementService.name);

  constructor(private prisma: PrismaService) {
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
  }

  private async parsePdfText(buffer: Buffer, password?: string): Promise<string> {
    const workerCode = `
      const { parentPort } = require('worker_threads');
      const { PDFParse } = require('pdf-parse');

      if (!parentPort) throw new Error('Must run as worker');

      parentPort.on('message', async (message) => {
        try {
          const { buffer, password } = message;
          const parser = new PDFParse({ data: Buffer.from(buffer), password });
          try {
            const result = await parser.getText();
            parentPort.postMessage({ success: true, text: result.text });
          } finally {
            await parser.destroy();
          }
        } catch (error) {
          parentPort.postMessage({
            success: false,
            error: {
              name: error.name || 'Error',
              message: error.message || String(error),
              stack: error.stack
            }
          });
        }
      });
    `;

    return new Promise<string>((resolve, reject) => {
      const worker = new Worker(workerCode, { eval: true });
      worker.postMessage({ buffer, password });

      worker.on('message', (res) => {
        worker.terminate();
        if (res.success) {
          resolve(res.text);
        } else {
          const errObj = res.error;
          if (errObj.name === 'PasswordException') {
            reject(new PasswordException(errObj.message));
          } else {
            const err = new Error(errObj.message);
            err.name = errObj.name;
            err.stack = errObj.stack;
            reject(err);
          }
        }
      });

      worker.on('error', (err) => {
        worker.terminate();
        reject(err);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error("Worker stopped with exit code " + code));
        }
      });
    });
  }

  async processAndSaveFile(userId: number, buffer: Buffer, originalname: string): Promise<number> {
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // 0. Check if a duplicate successful record exists in the last 3 days
    const existing = await this.prisma.queryRecord.findFirst({
      where: {
        userId,
        status: 'done',
        filePath: {
          startsWith: md5,
        },
        createdAt: { gte: threeDaysAgo },
      },
    });

    if (existing) {
      this.logger.log(`Found duplicate statement upload by hash for user ${userId}, reusing record ${existing.id}`);
      return existing.id;
    }

    // ① 校验用户并根据月卡状态决定是否扣减次数
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
      select: { id: true, remainingQueries: true, monthlyCardExpiry: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    const hasMonthlyCard = user.monthlyCardExpiry != null && user.monthlyCardExpiry > now;

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
    else if (originalname.includes('工商') || originalname.includes('工行')) source = '工商银行';
    else if (originalname.includes('农商') || originalname.includes('农村商业')) source = '农商银行';

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
      void this.parseAndUpdateRecord(recordId, userId, buffer, fileName);
    });

    return recordId;
  }
  private async parseWithPythonService(
    buffer: Buffer,
    fileName: string,
    password?: string,
  ): Promise<StatementData | null> {
    const parserUrl = process.env.PDF_PARSER_URL;
    if (!parserUrl) {
      this.logger.log('PDF_PARSER_URL is not configured, skipping Python parsing service.');
      return null;
    }

    const isSharedMode = process.env.PDF_PARSER_MODE === 'shared';

    try {
      const url = isSharedMode ? `${parserUrl}/parse-path` : `${parserUrl}/parse`;
      this.logger.log(`Calling Python parsing service at ${url} (mode: ${isSharedMode ? 'shared' : 'multipart'})...`);

      let response: Response;
      if (isSharedMode) {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filePath: fileName,
            password: password || null,
          }),
        });
      } else {
        const formData = new FormData();
        const fileBlob = new Blob([new Uint8Array(buffer)], { type: 'application/pdf' });
        formData.append('file', fileBlob, fileName);
        if (password) {
          formData.append('password', password);
        }

        response = await fetch(url, {
          method: 'POST',
          body: formData,
        });
      }

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        if (response.status === 400 && errJson.error === 'PasswordRequired') {
          throw new PasswordException('PDF is password protected');
        }
        throw new Error(errJson.detail || errJson.message || `HTTP error ${response.status}`);
      }

      const data = await response.json();
      return data as StatementData;
    } catch (err) {
      if (err instanceof PasswordException) {
        throw err;
      }
      this.logger.error(`Python parsing service failed for ${fileName}:`, err);
      return null;
    }
  }

  private async parseAndUpdateRecord(
    recordId: number,
    userId: number,
    buffer: Buffer,
    fileName: string,
    password?: string,
  ): Promise<void> {
    try {
      let parsedData: StatementData | null = null;
      let source = '未知';

      // 1. Try Python service first
      try {
        parsedData = await this.parseWithPythonService(buffer, fileName, password);
        if (parsedData && parsedData.summary) {
          source = parsedData.summary.source || '未知';
        }
      } catch (err) {
        if (err instanceof PasswordException) {
          throw err;
        }
        this.logger.warn(`Python parsing service threw an error, falling back to local parsing for record ${recordId}`);
      }

      // 2. Fallback to local JS parsing if Python returned null
      if (!parsedData) {
        const text = await this.parsePdfText(buffer, password);
        const detected = this.detectSourceFromText(text);

        if (!detected) {
          throw new BadRequestException('不支持的账单格式，请上传正确的微信、支付宝、招商银行、交通银行、工商银行或农商银行交易流水。');
        }

        source = detected;
        parsedData = this.extractData(text, source);
      }

      if (parsedData.transactions.length === 0) {
        this.logger.warn(
          `Parsed 0 transactions for record ${recordId} (${source}, ${fileName})`,
        );
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

        if (idNumber || cardNumber) {
          let su;
          if (idNumber) {
            su = await this.prisma.statementUser.upsert({
              where: { idNumber },
              update: { queryCount: { increment: 1 } },
              create: {
                name: parsedData.summary.name,
                idNumber,
                cardNumber,
                queryCount: 1,
              },
              select: { id: true },
            });
          } else {
            su = await this.prisma.statementUser.upsert({
              where: { cardNumber: cardNumber! },
              update: { queryCount: { increment: 1 } },
              create: {
                name: parsedData.summary.name,
                idNumber,
                cardNumber,
                queryCount: 1,
              },
              select: { id: true },
            });
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

        const response = await fetch(QUERY_SERVER_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'bill_query_record_secret_key_2026',
          },
          body: JSON.stringify({
            name: parsedData.summary.name,
            end_of_id: parsedData.summary.idNumber ? parsedData.summary.idNumber.slice(-6) : null,
            first_querior: wechatUser?.nickname,
            first_querior_id: wechatUser?.openid,
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          this.logger.error(`Failed to send query record to external server: ${response.status} ${text}`);
        } else {
          this.logger.log(`Successfully sent query record for user ${userId} to external server`);
        }
      } catch (apiErr) {
        this.logger.error('Error sending query record to external server:', apiErr);
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
      const userHadMonthlyCard = failedUser?.monthlyCardExpiry != null && failedUser.monthlyCardExpiry > failNow;

      await Promise.all([
        this.prisma.queryRecord.update({
          where: { id: recordId },
          data: { status: 'failed' },
        }),
        this.prisma.wechatUser.update({
          where: { id: userId },
          data: userHadMonthlyCard
            ? { totalQueries: { decrement: 1 } }                                       // 月卡用户：只回退计数
            : { remainingQueries: { increment: 1 }, totalQueries: { decrement: 1 } },  // 普通用户：退还次数
        }),
      ]);
    }
  }
  async getRecordStatus(recordId: number, userId: number): Promise<{ status: string; ready: boolean }> {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
      select: { userId: true, status: true },
    });
    if (!record) throw new NotFoundException('Record not found');
    if (record.userId !== userId) throw new ForbiddenException('无权访问该记录');
    return {
      status: record.status,
      ready: record.status === 'done',
    };
  }

  async getHistory(userId: number) {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const records = await this.prisma.queryRecord.findMany({
      where: {
        userId,
        createdAt: { gte: threeDaysAgo }
      },
      include: { statementUser: true },
      orderBy: { createdAt: 'desc' }
    });

    return records.map(r => ({
      id: r.id,
      source: r.source,
      name: r.statementUser?.name || '未知',
      createdAt: r.createdAt
    }));
  }

  async deleteRecord(userId: number, recordId: number) {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
    });
    if (!record) {
      throw new NotFoundException('Record not found');
    }
    if (record.userId !== userId) {
      throw new ForbiddenException('无权删除该记录');
    }

    const filePath = path.join(this.uploadsDir, record.filePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await this.prisma.queryRecord.delete({ where: { id: recordId } });
    return { success: true };
  }

  async retryWithPassword(userId: number, recordId: number, password?: string): Promise<void> {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
    });
    if (!record) throw new NotFoundException('Record not found');
    if (record.userId !== userId) throw new ForbiddenException('无权访问该记录');
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
    // 异步执行解析，带上密码
    setImmediate(() => {
      void this.parseAndUpdateRecord(recordId, userId, buffer, path.basename(filePath), password);
    });
  }

  private async assertRecordOwnership(recordId: number, userId: number) {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
      select: { userId: true },
    });
    if (!record) throw new NotFoundException('Record not found');
    if (record.userId !== userId) {
      throw new ForbiddenException('无权访问该记录');
    }
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
      return this.backfillLegacyRecord(record.id, record.source, record.filePath);
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
    const text = await this.parsePdfText(buffer);
    const parsedData = this.extractData(text, source);

    await this.prisma.queryRecord.update({
      where: { id: recordId },
      data: {
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
      result.maskedIdNumber = idNum.length > 8
        ? idNum.slice(0, 4) + '*'.repeat(idNum.length - 8) + idNum.slice(-4)
        : idNum;

      try {
        const idcard = require('idcard');
        const info = idcard.info(idNum);
        if (info && info.valid) {
          result.nativePlace = info.address;
          result.genderText = info.gender === 'M' ? '男' : info.gender === 'F' ? '女' : '-';
          result.age = info.age;
        }
      } catch (e) {
        this.logger.error('Failed to parse ID card:', e);
      }
    }

    if (result.cardNumber) {
      const cardNum = result.cardNumber;
      result.maskedCardNumber = cardNum.length > 8
        ? cardNum.slice(0, 4) + '*'.repeat(cardNum.length - 8) + cardNum.slice(-4)
        : cardNum;
    }

    return result;
  }

  private pickResultMeta(summary: StatementSummary): StatementResultMeta {
    const {
      totalIncome: _ti,
      totalExpenditure: _te,
      selfIncome: _si,
      selfExpenditure: _se,
      ...meta
    } = summary;
    return meta;
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
      select: { statementUserId: true },
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

    return {
      summary: {
        ...summary,
        firstQueryTime: firstQueryTime ? firstQueryTime.toISOString() : null,
        queryCount,
      },
      raw: data.transactions,
    };
  }

  async getCounterparties(id: number, userId: number) {
    await this.assertRecordOwnership(id, userId);
    const data = await this.getPersistedData(id);
    const map = new Map<string, { count: number, total: number }>();
    let grandTotal = 0;

    data.transactions.forEach(t => {
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
      percentage: grandTotal > 0 ? ((stats.total / grandTotal) * 100).toFixed(2) : '0.00'
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
      where: { createdAt: { lt: sixtyDaysAgo } }
    });

    for (const record of oldRecords) {
      const filePath = path.join(this.uploadsDir, record.filePath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await this.prisma.queryRecord.deleteMany({
      where: { createdAt: { lt: sixtyDaysAgo } }
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
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      let txs: string[][] = [];
      let currentTx: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('支出 ') || line.startsWith('收入 ') || line === '不计' || line.startsWith('不计 ')) {
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

        const dateMatch = fullText.match(/(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}:\d{2}))?/);
        if (!dateMatch) continue;

        const date = dateMatch[2] ? `${dateMatch[1]} ${dateMatch[2]}` : dateMatch[1];
        const month = dateMatch[1].substring(0, 7);

        const counterparty = fullText.substring(typeMatch[0].length).trim().split(/\s+/)[0] || '支付宝商户';

        transactions.push({ date, month, type, amount, counterparty });
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
      const rangeMatch = text.match(/(\d{4}-\d{2}-\d{2})\s*--\s*(\d{4}-\d{2}-\d{2})/);
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
      const rangeMatch = text.match(/起止日期：(\d{4}-\d{2}-\d{2})\s*—\s*(\d{4}-\d{2}-\d{2})/);
      if (rangeMatch) {
        startDate = rangeMatch[1];
        endDate = rangeMatch[2];
      }

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      let currentDate = '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\d{4}-\d{2}-\d{2}$/.test(line)) {
          currentDate = line;
          continue;
        }

        const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2})/);
        if (timeMatch && currentDate) {
          const match = line.match(/^(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([+-][0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s*(.*?)$/);
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

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
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
              lines: []
            };
            continue;
          }
        }

        if (currentBlock) {
          if (line.includes('广东顺德农村商业银行') || line.includes('账户/卡明细信息') || line.includes('起止日期') || line.includes('交易时间') || line.startsWith('————') || line.startsWith('累计存入笔数') || line.startsWith('总交易笔数') || line.startsWith('END') || line.startsWith('打印机构')) {
            continue;
          }
          currentBlock.lines.push(line);
        }
      }
      if (currentBlock) blocks.push(currentBlock);

      for (const block of blocks) {
        const dateOnly = block.date;
        const blockText = block.lines.join(' ');

        const match = blockText.match(/^(\d{2}:\d{2}:\d{2})\s+(\S+)\s+([+-][0-9,]+\.[0-9]{2})\s+(.*?)$/);
        if (match) {
          const time = match[1];
          const date = `${dateOnly} ${time}`;
          const month = dateOnly.substring(0, 7);
          const amountStr = match[3].replace(/,/g, '');
          const amountNum = parseFloat(amountStr);
          const type = amountNum < 0 ? '支出' : '收入';
          const amount = Math.abs(amountNum);
          const remainder = match[4].trim();

          const balanceMatch = remainder.match(/\s([0-9,]+\.[0-9]{2})\s+(\S+渠道|核心渠道|网上渠道|快捷渠道|自助渠道|柜面渠道|其他渠道)\s+(\S+)\s*(.*?)$/);

          let counterparty = '';
          if (balanceMatch) {
            const balance = balanceMatch[1];
            const channel = balanceMatch[2];
            const summary = balanceMatch[3];
            const memo = balanceMatch[4];
            const opponentText = remainder.substring(0, remainder.indexOf(balanceMatch[0])).trim();
            const nameAndBank = opponentText.replace(/\b\d+(\s+\d+)?\b/g, '').trim().replace(/\s+/g, ' ');

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
      const toDateOnly = (d: string) => (d.length >= 10 ? d.substring(0, 10) : d);
      if (!startDate) startDate = toDateOnly(transactions[0].date);
      if (!endDate) endDate = toDateOnly(transactions[transactions.length - 1].date);
    }

    // 按降序排列记录
    transactions.reverse();

    let totalIncome = 0;
    let totalExpenditure = 0;
    let selfIncome = 0;
    let selfExpenditure = 0;

    transactions.forEach(t => {
      if (t.type === '收入') {
        totalIncome += t.amount;
        if (t.counterparty.includes(name) || t.counterparty.includes('转入到余利宝')) selfIncome += t.amount;
      } else if (t.type === '支出') {
        totalExpenditure += t.amount;
        if (t.counterparty.includes(name) || t.counterparty.includes('转入到余利宝')) selfExpenditure += t.amount;
      }
    });

    totalIncome = Number(totalIncome.toFixed(2));
    totalExpenditure = Number(totalExpenditure.toFixed(2));
    selfIncome = Number(selfIncome.toFixed(2));
    selfExpenditure = Number(selfExpenditure.toFixed(2));

    return {
      summary: { id: '', source, name, idNumber, cardNumber, startDate, endDate, totalIncome, totalExpenditure, selfIncome, selfExpenditure },
      transactions
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
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
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
        if (this.isCmbTransactionLine(next) || this.shouldSkipCmbNoiseLine(next)) {
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
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    let i = 0;
    while (i < lines.length) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(lines[i])) {
        const date = lines[i];
        const month = date.substring(0, 7);
        let blockStart = i + 1;
        let dateTime = date;
        if (
          blockStart < lines.length &&
          /^\d{2}:\d{2}:\d{2}$/.test(lines[blockStart])
        ) {
          dateTime = `${date} ${lines[blockStart]}`;
          blockStart++;
        }

        // Collect block lines until next date or page marker
        const blockLines: string[] = [];
        let j = blockStart;
        while (
          j < lines.length &&
          !/^\d{4}-\d{2}-\d{2}$/.test(lines[j]) &&
          !lines[j].startsWith('-- ')
        ) {
          blockLines.push(lines[j]);
          j++;
        }

        const blockText = blockLines.join(' ');

        // Find the line that contains the amount
        const amountLineIdx = blockLines.findIndex(l => /\d+\.\d{2}/.test(l));
        if (amountLineIdx >= 0) {
          const amountLine = blockLines[amountLineIdx];
          const isOtherType = /^其他\s/.test(amountLine.trim());

          // 收/支/其他 在金额行；中文无法用 \b，故按金额行判断
          let type: '收入' | '支出' | '不计收支' = '支出';
          if (isOtherType) type = '不计收支';
          else if (/\s收入(?:\s|\/)/.test(amountLine) || /\s收入\s/.test(blockText)) type = '收入';
          else if (/\s支出\s/.test(amountLine) || /\s支出\s/.test(blockText)) type = '支出';
          else if (/不计/.test(blockText)) type = '不计收支';
          const amountMatch = amountLine.match(/(\d+\.\d{2})/);
          if (amountMatch) {
            const amount = parseFloat(amountMatch[1]);
            
            // Extract the original details from before the amount line if isOtherType is true
            const otherDetail = (isOtherType && amountLineIdx > 0)
              ? blockLines.slice(0, amountLineIdx).join('').replace(/\s+/g, '').trim()
              : '/';

            const counterparty = isOtherType
              ? (otherDetail || '/')
              : this.extractWechatCounterparty(
                amountLine
                  .slice(amountLine.indexOf(amountMatch[0]) + amountMatch[0].length)
                  .trim(),
                blockLines.slice(amountLineIdx + 1),
              );
            transactions.push({ date: dateTime, month, type, amount, counterparty });
          }
        }

        i = j;
      } else {
        i++;
      }
    }

    return transactions;
  }

  private extractWechatCounterparty(sameLine: string, nextLines: string[]): string {
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
}
