import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';

interface Transaction {
  date: string;
  month: string;
  type: '收入' | '支出' | '不计收支';
  amount: number;
  counterparty: string;
}

interface MonthlyDetail {
  month: string;
  income: number;
  expenditure: number;
  balance: number;
  recordCount: number;
}

interface GamblingCounterparty {
  counterparty: string;
  totalOut: number;
  totalIn: number;
  netLoss: number;
}

interface TopCounterparty {
  counterparty: string;
  totalAmount: number;
  count: number;
  type: string;
}

interface SuspectedInDbSummary {
  counterparty: string;
  amount: number;
  count: number;
  totalAmount: number;
  firstDate: string;
  lastDate: string;
}

interface SuspectedWithdrawDetail {
  date: string;
  amount: number;
  counterparty: string;
}

interface SuspectedInDbAndWithdraw {
  totalInDbCount: number;
  totalInDbAmount: number;
  totalWithdrawCount: number;
  totalWithdrawAmount: number;
  inDbSummaries: SuspectedInDbSummary[];
  withdrawDetails: SuspectedWithdrawDetail[];
}

interface RiskFeatures {
  basicInfo: {
    name: string;
    maskedIdNumber?: string;
    genderText?: string;
    age?: number;
    nativePlace?: string;
    source: string;
    startDate: string;
    endDate: string;
  };
  billOverview: {
    totalRecords: number;
    totalIncome: number;
    totalExpenditure: number;
    netAmount: number;
    monthCount: number;
    avgMonthlyIncome: number;
    avgMonthlyExpenditure: number;
    monthlyDetails: MonthlyDetail[];
  };
  gamblingSignals: {
    lateNightTransactionCount: number;
    lateNightTransactionPct: string;
    redPacketOutCount: number;
    redPacketOutAmount: number;
    fastInFastOutEvents: number;
    suspectedGamblingCounterparties: GamblingCounterparty[];
  };
  topCounterparties: {
    byAmount: TopCounterparty[];
  };
  userInput: {
    userNotes: string;
  };
  suspectedInDbAndWithdraw: SuspectedInDbAndWithdraw;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private prisma: PrismaService,
    private systemConfigService: SystemConfigService,
  ) {}

  private async assertOwnership(
    recordId: number,
    userId: number,
  ): Promise<void> {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
      select: { userId: true, status: true },
    });
    if (!record) throw new NotFoundException('Record not found');
    if (record.status !== 'done')
      throw new NotFoundException('账单尚未解析完成');

    const requestingUser = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
      select: { level: true },
    });
    const isAdmin = requestingUser?.level === 999;
    if (record.userId !== userId && !isAdmin) {
      throw new ForbiddenException('无权访问该记录');
    }
  }

  private async assertShareAccess(
    recordId: number,
    token: string,
  ): Promise<void> {
    if (!token || typeof token !== 'string' || token.length < 8) {
      throw new ForbiddenException('分享凭证无效');
    }
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
      select: { shareToken: true, status: true },
    });
    if (!record) throw new NotFoundException('记录已被删除');
    if (record.status !== 'done') {
      throw new NotFoundException('账单尚未解析完成');
    }
    if (!record.shareToken || record.shareToken !== token) {
      throw new ForbiddenException('分享凭证无效');
    }
  }

  private async findRecordByShareCode(sc: string) {
    const code = (sc || '').trim();
    if (!code || code.length < 8) {
      throw new ForbiddenException('分享凭证无效');
    }
    const record = await this.prisma.queryRecord.findUnique({
      where: { shareToken: code },
      select: { id: true, shareToken: true, status: true },
    });
    if (!record) throw new NotFoundException('记录已被删除');
    if (record.status !== 'done') {
      throw new NotFoundException('账单尚未解析完成');
    }
    return record;
  }

  /**
   * Enrich raw summaryJson with derived fields (maskedIdNumber, gender, age, nativePlace)
   * from idNumber, mirroring StatementService.enrichSummary logic.
   */
  private enrichSummaryJson(
    summaryJson: Record<string, unknown>,
  ): Record<string, unknown> {
    const enriched = { ...summaryJson };
    const idNumber = enriched.idNumber as string | undefined;

    if (idNumber && !enriched.maskedIdNumber) {
      enriched.maskedIdNumber =
        idNumber.length > 8
          ? idNumber.slice(0, 4) +
            '*'.repeat(idNumber.length - 8) +
            idNumber.slice(-4)
          : idNumber;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const idcard = require('idcard');
        const info = idcard.info(idNumber);
        if (info && info.valid) {
          if (!enriched.nativePlace) enriched.nativePlace = info.address;
          if (!enriched.genderText)
            enriched.genderText =
              info.gender === 'M' ? '男' : info.gender === 'F' ? '女' : '-';
          if (!enriched.age) enriched.age = info.age;
        }
      } catch (e) {
        this.logger.error('Failed to parse ID card in AI service:', e);
      }
    }
    return enriched;
  }

  private extractRiskFeatures(
    summaryJson: Record<string, unknown>,
    transactions: Transaction[],
    userInput: { userNotes: string },
  ): RiskFeatures {
    // --- Enrich summary with id card derived fields ---
    const enriched = this.enrichSummaryJson(summaryJson);

    // --- Basic Info ---
    const basicInfo = {
      name: (enriched.name as string) || '未知',
      maskedIdNumber: enriched.maskedIdNumber as string | undefined,
      genderText: enriched.genderText as string | undefined,
      age: enriched.age as number | undefined,
      nativePlace: enriched.nativePlace as string | undefined,
      source: (enriched.source as string) || '未知',
      startDate: (enriched.startDate as string) || '',
      endDate: (enriched.endDate as string) || '',
    };

    // --- Monthly stats ---
    const monthMap = new Map<
      string,
      { income: number; expenditure: number; count: number }
    >();
    for (const t of transactions) {
      const month = t.month || (t.date ? t.date.substring(0, 7) : 'unknown');
      if (!monthMap.has(month))
        monthMap.set(month, { income: 0, expenditure: 0, count: 0 });
      const m = monthMap.get(month)!;
      m.count += 1;
      if (t.type === '收入') m.income += t.amount;
      else if (t.type === '支出') m.expenditure += t.amount;
    }
    const monthlyDetails: MonthlyDetail[] = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, d]) => ({
        month,
        income: Math.round(d.income * 100) / 100,
        expenditure: Math.round(d.expenditure * 100) / 100,
        balance: Math.round((d.income - d.expenditure) * 100) / 100,
        recordCount: d.count,
      }));

    const totalIncome = monthlyDetails.reduce((s, m) => s + m.income, 0);
    const totalExpenditure = monthlyDetails.reduce(
      (s, m) => s + m.expenditure,
      0,
    );
    const monthCount = monthlyDetails.length || 1;

    const billOverview = {
      totalRecords: transactions.length,
      totalIncome: Math.round(totalIncome * 100) / 100,
      totalExpenditure: Math.round(totalExpenditure * 100) / 100,
      netAmount: Math.round((totalIncome - totalExpenditure) * 100) / 100,
      monthCount,
      avgMonthlyIncome: Math.round((totalIncome / monthCount) * 100) / 100,
      avgMonthlyExpenditure:
        Math.round((totalExpenditure / monthCount) * 100) / 100,
      monthlyDetails,
    };

    // --- Gambling signals ---
    const GAMBLING_KEYWORDS = [
      'xyliu',
      '破茧成蝶',
      '邂逅',
      '上下分',
      '彩票',
      '体彩',
      '福彩',
      '快三',
      '时时彩',
    ];
    let redPacketOutCount = 0;
    let redPacketOutAmount = 0;
    const gamblingCpMap = new Map<string, { out: number; inAmt: number }>();

    for (const t of transactions) {
      if (
        t.type === '支出' &&
        (t.counterparty.includes('群红包') || t.counterparty.includes('红包'))
      ) {
        redPacketOutCount++;
        redPacketOutAmount += t.amount;
      }
      const isGamble = GAMBLING_KEYWORDS.some((k) =>
        t.counterparty.includes(k),
      );
      if (isGamble) {
        if (!gamblingCpMap.has(t.counterparty))
          gamblingCpMap.set(t.counterparty, { out: 0, inAmt: 0 });
        const entry = gamblingCpMap.get(t.counterparty)!;
        if (t.type === '支出') entry.out += t.amount;
        else if (t.type === '收入') entry.inAmt += t.amount;
      }
    }

    // Late night count
    const lateNightCount = transactions.filter((t) => {
      const m = t.date.match(/(\d{2}):\d{2}/);
      if (!m) return false;
      const h = parseInt(m[1], 10);
      return h >= 22 || h < 6;
    }).length;

    // Fast in fast out
    let fastInFastOutEvents = 0;
    const incomeList = transactions.filter(
      (t) => t.type === '收入' && t.amount >= 500,
    );
    const outList = transactions.filter(
      (t) => t.type === '支出' && t.amount >= 500,
    );
    for (const inc of incomeList) {
      const incDate = new Date(inc.date.replace(/-/g, '/'));
      if (isNaN(incDate.getTime())) continue;
      const matchOut = outList.find((out) => {
        const outDate = new Date(out.date.replace(/-/g, '/'));
        if (isNaN(outDate.getTime())) return false;
        const diffH =
          Math.abs(outDate.getTime() - incDate.getTime()) / (1000 * 60 * 60);
        return (
          diffH <= 24 && Math.abs(out.amount - inc.amount) / inc.amount < 0.1
        );
      });
      if (matchOut) fastInFastOutEvents++;
    }

    const suspectedGamblingCounterparties: GamblingCounterparty[] = Array.from(
      gamblingCpMap.entries(),
    )
      .map(([cp, v]) => ({
        counterparty: cp,
        totalOut: Math.round(v.out * 100) / 100,
        totalIn: Math.round(v.inAmt * 100) / 100,
        netLoss: Math.round((v.out - v.inAmt) * 100) / 100,
      }))
      .sort((a, b) => b.netLoss - a.netLoss);

    const gamblingSignals = {
      lateNightTransactionCount: lateNightCount,
      lateNightTransactionPct:
        transactions.length > 0
          ? ((lateNightCount / transactions.length) * 100).toFixed(1) + '%'
          : '0%',
      redPacketOutCount,
      redPacketOutAmount: Math.round(redPacketOutAmount * 100) / 100,
      fastInFastOutEvents,
      suspectedGamblingCounterparties,
    };

    // --- Top counterparties ---
    const cpAmountMap = new Map<
      string,
      { totalAmount: number; count: number; type: string }
    >();
    for (const t of transactions) {
      if (t.type === '不计收支') continue;
      const key = `${t.counterparty}||${t.type}`;
      if (!cpAmountMap.has(key))
        cpAmountMap.set(key, { totalAmount: 0, count: 0, type: t.type });
      const entry = cpAmountMap.get(key)!;
      entry.totalAmount += t.amount;
      entry.count += 1;
    }

    const byAmount: TopCounterparty[] = Array.from(cpAmountMap.entries())
      .map(([key, v]) => ({
        counterparty: key.split('||')[0],
        totalAmount: Math.round(v.totalAmount * 100) / 100,
        count: v.count,
        type: v.type,
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 20);

    // --- Suspected In DB & Withdraw detection ---
    const SUSPECTED_MIN_AMOUNT = 30;
    const SUSPECTED_MIN_CONSECUTIVE_DAYS = 4;
    const SUSPECTED_WITHDRAW_WINDOW_DAYS = 7;
    const GROUP_KEY_SEP = '\0';

    const extractDateKey = (dateStr: string) => {
      if (!dateStr) return '';
      const normalized = dateStr.replace('T', ' ').trim();
      const match = normalized.match(/(\d{4}-\d{2}-\d{2})/);
      return match ? match[1] : '';
    };

    const parseDateKeyToUtc = (dateKey: string) => {
      const [y, m, d] = dateKey.split('-').map(Number);
      return Date.UTC(y, m - 1, d);
    };

    const getMaxConsecutiveDays = (dateKeys: string[]) => {
      const unique = [...new Set(dateKeys.filter(Boolean))].sort();
      if (unique.length === 0) return 0;
      let maxStreak = 1;
      let streak = 1;
      for (let i = 1; i < unique.length; i++) {
        const diffDays =
          (parseDateKeyToUtc(unique[i]) - parseDateKeyToUtc(unique[i - 1])) /
          (1000 * 60 * 60 * 24);
        if (diffDays === 1) {
          streak++;
          maxStreak = Math.max(maxStreak, streak);
        } else if (diffDays > 1) {
          streak = 1;
        }
      }
      return maxStreak;
    };

    const getRecentWindowStartKey = () => {
      const today = new Date();
      const start = new Date(
        Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
      );
      start.setUTCDate(
        start.getUTCDate() - (SUSPECTED_WITHDRAW_WINDOW_DAYS - 1),
      );
      const y = start.getUTCFullYear();
      const m = String(start.getUTCMonth() + 1).padStart(2, '0');
      const d = String(start.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    };

    const getSuspectedPatternKey = (t: {
      counterparty: string;
      amount: number;
    }) => `${t.counterparty}${GROUP_KEY_SEP}${t.amount.toFixed(2)}`;

    // Group dates by patternKey
    const patternDates = new Map<string, string[]>();
    for (const t of transactions) {
      if (t.type !== '支出') continue;
      if (t.amount < SUSPECTED_MIN_AMOUNT) continue;
      const patternKey = getSuspectedPatternKey(t);
      const dateKey = extractDateKey(t.date);
      if (!dateKey) continue;
      if (!patternDates.has(patternKey)) {
        patternDates.set(patternKey, []);
      }
      patternDates.get(patternKey)!.push(dateKey);
    }

    // Identify matched patternKeys
    const suspectedPatternKeys = new Set<string>();
    for (const [patternKey, dates] of patternDates.entries()) {
      if (getMaxConsecutiveDays(dates) >= SUSPECTED_MIN_CONSECUTIVE_DAYS) {
        suspectedPatternKeys.add(patternKey);
      }
    }

    // Filter transaction items matching suspected patternKeys
    const inDbTransactions = transactions.filter((t) => {
      if (t.type !== '支出') return false;
      const patternKey = getSuspectedPatternKey(t);
      return suspectedPatternKeys.has(patternKey);
    });

    // Group In DB transactions by pattern to build summaries
    const inDbGroups = new Map<
      string,
      { counterparty: string; amount: number; dates: string[] }
    >();
    for (const t of inDbTransactions) {
      const patternKey = getSuspectedPatternKey(t);
      if (!inDbGroups.has(patternKey)) {
        inDbGroups.set(patternKey, {
          counterparty: t.counterparty,
          amount: t.amount,
          dates: [],
        });
      }
      const dateKey = extractDateKey(t.date);
      if (dateKey) {
        inDbGroups.get(patternKey)!.dates.push(dateKey);
      }
    }

    const inDbSummaries: SuspectedInDbSummary[] = [];
    for (const [, g] of inDbGroups.entries()) {
      g.dates.sort();
      inDbSummaries.push({
        counterparty: g.counterparty,
        amount: g.amount,
        count: g.dates.length,
        totalAmount: Math.round(g.amount * g.dates.length * 100) / 100,
        firstDate: g.dates[0] || '',
        lastDate: g.dates[g.dates.length - 1] || '',
      });
    }
    inDbSummaries.sort((a, b) => b.totalAmount - a.totalAmount);

    const totalInDbCount = inDbTransactions.length;
    const totalInDbAmount =
      Math.round(inDbTransactions.reduce((s, t) => s + t.amount, 0) * 100) /
      100;

    // Filter suspected withdraw transactions
    const recentWindowStart = getRecentWindowStartKey();
    const withdrawTransactions = inDbTransactions.filter((t) => {
      const dateKey = extractDateKey(t.date);
      return dateKey && dateKey >= recentWindowStart;
    });

    const withdrawDetails: SuspectedWithdrawDetail[] = withdrawTransactions
      .map((t) => ({
        date: t.date,
        amount: t.amount,
        counterparty: t.counterparty,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    const totalWithdrawCount = withdrawTransactions.length;
    const totalWithdrawAmount =
      Math.round(withdrawTransactions.reduce((s, t) => s + t.amount, 0) * 100) /
      100;

    const suspectedInDbAndWithdraw: SuspectedInDbAndWithdraw = {
      totalInDbCount,
      totalInDbAmount,
      totalWithdrawCount,
      totalWithdrawAmount,
      inDbSummaries,
      withdrawDetails,
    };

    return {
      basicInfo,
      billOverview,
      gamblingSignals,
      topCounterparties: { byAmount },
      userInput,
      suspectedInDbAndWithdraw,
    };
  }

  private buildUserPrompt(features: RiskFeatures, useTemplate = true): string {
    const bi = features.basicInfo;
    const bo = features.billOverview;
    const gs = features.gamblingSignals;
    const ui = features.userInput;
    const ws = features.suspectedInDbAndWithdraw;

    const monthlyText = bo.monthlyDetails
      .map(
        (m) =>
          `  ${m.month}: 收入¥${m.income} 支出¥${m.expenditure} 结余¥${m.balance} (${m.recordCount}笔)`,
      )
      .join('\n');

    const gamblingText = [
      `  凌晨(22-6点)交易：${gs.lateNightTransactionCount}笔，占比${gs.lateNightTransactionPct}`,
      `  群红包支出：${gs.redPacketOutCount}笔，共¥${gs.redPacketOutAmount}`,
      `  快进快出事件（同天同额±10%）：${gs.fastInFastOutEvents}次`,
      gs.suspectedGamblingCounterparties.length > 0
        ? '  疑似赌博渠道：\n' +
          gs.suspectedGamblingCounterparties
            .map(
              (c) =>
                `    - ${c.counterparty} 支出¥${c.totalOut} 收入¥${c.totalIn} 净亏损¥${c.netLoss}`,
            )
            .join('\n')
        : '  未识别到已知赌博关键词渠道（不代表无赌博，请结合高频小额转账判断）',
    ].join('\n');

    const topCpText = features.topCounterparties.byAmount
      .slice(0, 10)
      .map(
        (c) =>
          `  - 【${c.type}】${c.counterparty}  ¥${c.totalAmount}（${c.count}笔）`,
      )
      .join('\n');

    const withdrawText =
      ws.withdrawDetails.length > 0
        ? ws.withdrawDetails
            .map((d) => `  - ${d.date}: ${d.counterparty} 支出¥${d.amount}`)
            .join('\n')
        : '  近7天内未发现明显疑似在退交易';

    const inDbText =
      ws.inDbSummaries.length > 0
        ? ws.inDbSummaries
            .map(
              (s) =>
                `  - 对手方「${s.counterparty}」，固定金额¥${s.amount}，共${s.count}笔，累计¥${s.totalAmount} (${s.firstDate} ~ ${s.lastDate})`,
            )
            .join('\n')
        : '  未发现明显疑似在库固定金额序列';

    if (!useTemplate) {
      return `请根据以下结构化账单特征数据，认真回答用户的补充信息/提问：

==== 补充信息/用户提问 ====
${ui.userNotes || '（未提供具体提问，请对账单进行自由分析）'}

==== 结构化账单数据 ====
==== 基本信息 ====
姓名：${bi.name}
身份证后4位：${bi.maskedIdNumber ? bi.maskedIdNumber.slice(-4) : '未知'}
性别：${bi.genderText || '未知'}
年龄：${bi.age ? bi.age + '岁' : '未知'}
户籍地：${bi.nativePlace || '未知'}
账单来源：${bi.source}
账单时间段：${bi.startDate} 至 ${bi.endDate}

==== 账单概况 ====
总记录数：${bo.totalRecords}笔
总收入：¥${bo.totalIncome}
总支出：¥${bo.totalExpenditure}
净额：¥${bo.netAmount}
账单跨度：${bo.monthCount}个月
月均收入：¥${bo.avgMonthlyIncome}
月均支出：¥${bo.avgMonthlyExpenditure}

==== 疑似在库与疑似在退 ====
疑似在库交易（连续4天及以上固定金额支出，金额>=30）：
${inDbText}

疑似在退交易（属于疑似在库且时间在近7天内）：
${withdrawText}

==== 赌博风险信号 ====
${gamblingText}

==== 高频交易对手方（Top 10）====
${topCpText}`;
    }

    return `请根据以下结构化账单特征数据，以专业风控视角生成分析报告。

==== 基本信息 ====
姓名：${bi.name}
身份证后4位：${bi.maskedIdNumber ? bi.maskedIdNumber.slice(-4) : '未知'}
性别：${bi.genderText || '未知'}
年龄：${bi.age ? bi.age + '岁' : '未知'}
户籍地：${bi.nativePlace || '未知（请从消费城市推断）'}
账单来源：${bi.source}
账单时间段：${bi.startDate} 至 ${bi.endDate}

==== 账单概况 ====
总记录数：${bo.totalRecords}笔
总收入：¥${bo.totalIncome}
总支出：¥${bo.totalExpenditure}
净额：¥${bo.netAmount}
账单跨度：${bo.monthCount}个月
月均收入：¥${bo.avgMonthlyIncome}
月均支出：¥${bo.avgMonthlyExpenditure}

月度明细：
${monthlyText}

==== 疑似在库与疑似在退 ====
疑似在库交易（连续4天及以上固定金额支出，金额>=30）：
${inDbText}

疑似在退交易（属于疑似在库且时间在近7天内）：
${withdrawText}

==== 赌博风险信号 ====
${gamblingText}

==== 高频交易对手方（Top 10）====
${topCpText}

==== 补充信息 ====
${ui.userNotes ? ui.userNotes : '未提供补充信息'}

请严格按系统提示中的 Markdown 格式输出风控分析报告。`;
  }

  async analyzeStatement(
    recordId: number,
    userId: number,
    userNotes: string,
    useTemplate = true,
  ): Promise<string> {
    await this.assertOwnership(recordId, userId);

    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
      select: { summaryJson: true, transactionsJson: true },
    });
    if (!record || !record.summaryJson || !record.transactionsJson) {
      throw new NotFoundException('账单数据不完整');
    }

    const transactions: Transaction[] = (
      record.transactionsJson as Record<string, unknown>[]
    ).map((t) => ({
      date: (t.date as string) || '',
      month: (t.month as string) || '',
      type: t.type as '收入' | '支出' | '不计收支',
      amount: Number(t.amount) || 0,
      counterparty: (t.counterparty as string) || '未知',
    }));

    const features = this.extractRiskFeatures(
      record.summaryJson as Record<string, unknown>,
      transactions,
      { userNotes },
    );

    const userPrompt = this.buildUserPrompt(features, useTemplate);

    const apiBase = (process.env.AI_API_BASE_URL || '').replace(/\/$/, '');
    const apiKey = process.env.AI_API_KEY || '';
    const model = process.env.AI_MODEL || 'qwen-plus';

    if (!apiBase || !apiKey || apiKey === 'your-api-key-here') {
      this.logger.warn('AI API not configured, returning placeholder response');
      const placeholder = `> ⚠️ **AI 服务尚未配置**\n\n请在服务器 \`.env\` 文件中填写以下配置项，然后重启服务：\n\`\`\`\nAI_API_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1\nAI_API_KEY=your-real-api-key\nAI_MODEL=qwen-plus\n\`\`\``;
      await this.saveReport(recordId, userId, userNotes, placeholder, model);
      return placeholder;
    }

    this.logger.log(
      `Calling AI API for record ${recordId}, model=${model}, transactions=${transactions.length}`,
    );

    let systemPrompt: string;
    if (useTemplate) {
      systemPrompt =
        await this.systemConfigService.getUserOrSystemAiPrompt(userId);
    } else {
      systemPrompt =
        '你是一个专业的账单分析与风控助手。请根据提供的结构化账单数据，认真回答用户的提问或执行用户的指令。回答时要专业、准确、有条理。';
    }

    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 3000,
        stream: false,
      }),
      signal: AbortSignal.timeout(55000),
    });

    if (!response.ok) {
      const errText = await response.text();
      this.logger.error(`AI API error ${response.status}: ${errText}`);
      throw new Error(`AI 服务调用失败（状态码 ${response.status}）`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI 返回数据格式异常');
    }

    await this.saveReport(recordId, userId, userNotes, content, model);
    return content;
  }

  private async saveReport(
    recordId: number,
    userId: number,
    userNotes: string,
    report: string,
    model: string,
  ): Promise<void> {
    await this.prisma.aiAnalysisReport.create({
      data: {
        queryRecordId: recordId,
        userId,
        userNotes: userNotes.trim(),
        report,
        model,
      },
    });
  }

  async listReports(recordId: number, userId: number) {
    await this.assertOwnership(recordId, userId);
    return this.findReportList(recordId);
  }

  async listSharedReports(recordId: number, token: string) {
    await this.assertShareAccess(recordId, token);
    return this.findReportList(recordId);
  }

  async listShareByCodeReports(sc: string) {
    const record = await this.findRecordByShareCode(sc);
    return this.findReportList(record.id);
  }

  private async findReportList(recordId: number) {
    return this.prisma.aiAnalysisReport.findMany({
      where: { queryRecordId: recordId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userNotes: true,
        model: true,
        createdAt: true,
      },
    });
  }

  async getReport(recordId: number, reportId: number, userId: number) {
    await this.assertOwnership(recordId, userId);
    return this.findReport(recordId, reportId);
  }

  async getSharedReport(recordId: number, reportId: number, token: string) {
    await this.assertShareAccess(recordId, token);
    return this.findReport(recordId, reportId);
  }

  async getShareByCodeReport(sc: string, reportId: number) {
    const record = await this.findRecordByShareCode(sc);
    return this.findReport(record.id, reportId);
  }

  private async findReport(recordId: number, reportId: number) {
    const report = await this.prisma.aiAnalysisReport.findFirst({
      where: {
        id: reportId,
        queryRecordId: recordId,
      },
      select: {
        id: true,
        userNotes: true,
        report: true,
        model: true,
        createdAt: true,
      },
    });

    if (!report) {
      throw new NotFoundException('分析报告不存在');
    }

    return report;
  }
}
