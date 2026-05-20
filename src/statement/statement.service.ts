import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import * as pdfParse from 'pdf-parse';
import * as fs from 'fs';
import * as path from 'path';

export interface StatementSummary {
  id: string;
  source: string;
  name: string;
  idNumber: string;
  startDate: string;
  endDate: string;
  totalIncome: number;
  totalExpenditure: number;
  selfIncome: number;
  selfExpenditure: number;
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

@Injectable()
export class StatementService {
  private memoryCache: Map<number, StatementData> = new Map();
  private uploadsDir = path.join(process.cwd(), 'uploads');

  constructor(private prisma: PrismaService) {
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
  }

  async processAndSaveFile(userId: number, buffer: Buffer, originalname: string): Promise<number> {
    const data = await pdfParse(buffer);
    const text = data.text;
    
    let source = '未知';
    if (text.includes('微信支付交易明细证明') || originalname.includes('微信')) {
      source = '微信';
    } else if (text.includes('支付宝支付科技有限公司') || originalname.includes('支付宝')) {
      source = '支付宝';
    } else if (text.includes('招商银行交易流水') || originalname.includes('招商')) {
      source = '招商银行';
    }

    const parsedData = this.extractData(text, source);
    
    // Save file
    const fileName = `${Date.now()}_${originalname}`;
    const filePath = path.join(this.uploadsDir, fileName);
    fs.writeFileSync(filePath, buffer);

    // DB Operations
    let statementUser = null;
    if (parsedData.summary.name !== '未知') {
      statementUser = await this.prisma.statementUser.create({
        data: {
          name: parsedData.summary.name,
          idNumber: parsedData.summary.idNumber,
        }
      });
    }

    const record = await this.prisma.queryRecord.create({
      data: {
        userId,
        statementUserId: statementUser ? statementUser.id : null,
        filePath: fileName,
        source,
      }
    });

    this.memoryCache.set(record.id, parsedData);
    return record.id;
  }

  async getHistory(userId: number) {
    const records = await this.prisma.queryRecord.findMany({
      where: { userId },
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

  private async getOrParseData(recordId: number): Promise<StatementData> {
    if (this.memoryCache.has(recordId)) {
      return this.memoryCache.get(recordId);
    }
    
    const record = await this.prisma.queryRecord.findUnique({ where: { id: recordId }});
    if (!record) throw new NotFoundException('Record not found');

    const filePath = path.join(this.uploadsDir, record.filePath);
    if (!fs.existsSync(filePath)) throw new NotFoundException('File not found on server');

    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    const parsedData = this.extractData(data.text, record.source);
    
    this.memoryCache.set(recordId, parsedData);
    return parsedData;
  }

  async getSummary(id: number): Promise<StatementSummary | null> {
    const data = await this.getOrParseData(id);
    return { ...data.summary, id: id.toString() };
  }

  async getCounterparties(id: number) {
    const data = await this.getOrParseData(id);
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

  async getMonthly(id: number) {
    const data = await this.getOrParseData(id);
    const map = new Map<string, { income: number, expenditure: number }>();
    
    data.transactions.forEach(t => {
       if (t.type !== '不计收支') {
           const entry = map.get(t.month) || { income: 0, expenditure: 0 };
           if (t.type === '收入') entry.income += t.amount;
           if (t.type === '支出') entry.expenditure += t.amount;
           map.set(t.month, entry);
       }
    });

    const result = Array.from(map.entries()).map(([month, stats]) => ({
        month,
        income: stats.income,
        expenditure: stats.expenditure,
        balance: stats.income - stats.expenditure
    }));

    result.sort((a, b) => a.month.localeCompare(b.month));
    return result;
  }

  async getRawData(id: number) {
    const data = await this.getOrParseData(id);
    return data.transactions;
  }

  // --- Parsing logic from V1 ---
  private extractData(text: string, source: string): StatementData {
    let name = '未知';
    let idNumber = '';
    const transactions: Transaction[] = [];
    let startDate = '';
    let endDate = '';

    if (source === '微信') {
      const nameMatch = text.match(/兹证明：(.*?)\（居民身份证：(.*?)\）/);
      if (nameMatch) {
        name = nameMatch[1];
        idNumber = nameMatch[2];
      }
      
      const dateLines = text.match(/\d{4}-\d{2}-\d{2}/g);
      if (dateLines && dateLines.length >= 2) {
        dateLines.sort();
        startDate = dateLines[0];
        endDate = dateLines[dateLines.length - 1];
      }

      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(line)) {
          const date = line;
          const month = date.substring(0, 7);
          let amount = 0;
          let counterparty = '未知';
          let type: '收入' | '支出' | '不计收支' = '支出';

          const details = (lines[i+1] || '') + (lines[i+2] || '') + (lines[i+3] || '');
          const match = details.match(/(收入|支出|其他).*?(零钱|零钱通|银行卡)?([0-9]+\.[0-9]{2})(.*)/);
          
          if (match) {
             const tType = match[1];
             if (tType === '收入') type = '收入';
             else if (tType === '支出') type = '支出';
             else type = '不计收支';
             
             amount = parseFloat(match[3]);
             counterparty = match[4].trim() || '未知商户';
             transactions.push({ date, month, type, amount, counterparty });
          }
        }
      }
    } else if (source === '支付宝') {
       const nameMatch = text.match(/兹证明:(.*?)\(证件号码:(.*?)\)/);
       if (nameMatch) {
         name = nameMatch[1];
         idNumber = nameMatch[2];
       }
       const lines = text.split('\n');
       let currentType: any = '支出';
       for (let i = 0; i < lines.length; i++) {
           const line = lines[i].trim();
           if (line === '支出' || line === '收入' || line.includes('不计')) {
               if (line === '支出') currentType = '支出';
               else if (line === '收入') currentType = '收入';
               else currentType = '不计收支';
           }
           
           const dateMatch = line.match(/(\d{4}-\d{2}-\d{2})/);
           if (dateMatch) {
               const date = dateMatch[1];
               const month = date.substring(0, 7);
               const amountMatch = (lines[i] + lines[i-1] + lines[i-2]).match(/([0-9]+\.[0-9]{2})/);
               if (amountMatch) {
                   transactions.push({ date, month, type: currentType, amount: parseFloat(amountMatch[1]), counterparty: '支付宝商户' });
               }
           }
       }
    } else if (source === '招商银行') {
       const nameMatch = text.match(/户\s*名：(.*?)\s/);
       if (nameMatch) {
           name = nameMatch[1];
       }
       const lines = text.split('\n');
       for (let i = 0; i < lines.length; i++) {
           const line = lines[i].trim();
           const match = line.match(/^(\d{4}-\d{2}-\d{2})\s+[A-Z]+\s+(-?[0-9,]+\.[0-9]{2})\s+[0-9,]+\.[0-9]{2}(.*?)$/);
           if (match) {
               const date = match[1];
               const month = date.substring(0, 7);
               const amountStr = match[2].replace(/,/g, '');
               const amountNum = parseFloat(amountStr);
               const type = amountNum < 0 ? '支出' : '收入';
               const amount = Math.abs(amountNum);
               
               const remainder = match[3];
               const counterpartyMatch = remainder.match(/支付(.*?)$|收款(.*?)$|转账(.*?)$/);
               const counterparty = counterpartyMatch ? (counterpartyMatch[1] || counterpartyMatch[2] || counterpartyMatch[3] || '招行商户').trim() : remainder.trim();
               
               transactions.push({ date, month, type, amount, counterparty });
           }
       }
    }
    
    transactions.sort((a, b) => a.date.localeCompare(b.date));
    if (transactions.length > 0) {
        if (!startDate) startDate = transactions[0].date;
        if (!endDate) endDate = transactions[transactions.length - 1].date;
    }

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

    return {
      summary: { id: '', source, name, idNumber, startDate, endDate, totalIncome, totalExpenditure, selfIncome, selfExpenditure },
      transactions
    };
  }
}
