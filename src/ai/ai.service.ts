import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

const SYSTEM_PROMPT = `你是一位专业的借贷风控分析师，擅长通过分析微信支付账单识别客户的借贷风险、赌博行为和职业真实性。

## 核心分析能力

### 1. 借贷天退识别
- 识别固定金额（≥100元）连续还款行为
- 时间跨度≤60天，笔数≥5次
- 区分本金+利息模式（如100元=60本+40息）
- 追踪资方与收款方分离情况

### 2. 赌博行为识别
- 快进快出资金归集
- 凌晨（22点-6点）活跃交易
- 群红包频繁（尤其是红包局）
- 彩票/体彩大额支出
- 上下分渠道（如xyliu.、破茧成蝶、邂逅等）
- 手机充值频繁+群红包+大额转入后立即提现

### 3. 职业真实性判断
- 收入稳定性（对比口述工资）
- 消费地点与工作地匹配度
- 房租支出验证居住情况
- 工作年限与年龄匹配度
- 夜间交易模式判断工作性质

### 4. 高风险职业识别
- 厨师：95%+赌博，夜间工作、球赛期间大额支出
- 理发师：95%+赌博，群红包、棋牌室消费
- 服务员/酒吧员工：夜间工作、收入波动
- 快递员/外卖员：手机使用频繁、工作单调

### 5. 电审要点
- 核实工作单位、年限、收入
- 识别谎言（如手机摔坏、回老家等借口）
- 快进快出资金异常
- 多头借贷情况

你是一位专业的银行借贷风控分析师。请严格按下面 Markdown 格式回复，不要加额外文字。

## 基本信息
- 姓名、身份证后4位、性别、年龄、户籍地（根据消费城市推断）

## 账单概况
- 总记录数、总支出、总收入、净额
- 月均收支
- 主要消费城市

## 借贷分析
- 列出所有疑似借贷天退对象、金额范围、笔数、时间跨度
- 合计天退金额

## 赌博分析
- 列举赌博渠道（群红包、彩票、上下分渠道等）及估计亏损金额
- 凌晨交易占比、快进快出记录

## 职业判断
- 与口述职业对比（收入是否匹配、工作地是否一致）
- 收入稳定性评估
- 夜间交易模式是否符合作息

## 综合评级
- 给出 ✅/⚠️/🔴 评级并简述理由（诚信、多头借贷、赌博迹象、职业真实性）

## 关键原则
1. 诚信>还款能力>抵押
2. 多头借贷、以贷养赌坚决拒绝
3. 快进快出+凌晨活跃=高度疑似赌博
4. 职业造假、满嘴跑火车=高风险
5. 收入与口述严重不符=需核实`;

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

interface LoanSequence {
  counterparty: string;
  amount: number;
  count: number;
  firstDate: string;
  lastDate: string;
  spanDays: number;
  totalAmount: number;
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
  loanSignals: {
    suspectedSequences: LoanSequence[];
    totalLoanAmount: number;
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
    occupation: string;
    monthlyIncome: string;
  };
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private prisma: PrismaService) {}

  private async assertOwnership(recordId: number, userId: number): Promise<void> {
    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
      select: { userId: true, status: true },
    });
    if (!record) throw new NotFoundException('Record not found');
    if (record.status !== 'done') throw new NotFoundException('账单尚未解析完成');

    const requestingUser = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
      select: { level: true },
    });
    const isAdmin = requestingUser?.level === 999;
    if (record.userId !== userId && !isAdmin) {
      throw new ForbiddenException('无权访问该记录');
    }
  }

  private extractRiskFeatures(
    summaryJson: Record<string, unknown>,
    transactions: Transaction[],
    userInput: { occupation: string; monthlyIncome: string },
  ): RiskFeatures {
    // --- Basic Info ---
    const basicInfo = {
      name: (summaryJson.name as string) || '未知',
      maskedIdNumber: summaryJson.maskedIdNumber as string | undefined,
      genderText: summaryJson.genderText as string | undefined,
      age: summaryJson.age as number | undefined,
      nativePlace: summaryJson.nativePlace as string | undefined,
      source: (summaryJson.source as string) || '未知',
      startDate: (summaryJson.startDate as string) || '',
      endDate: (summaryJson.endDate as string) || '',
    };

    // --- Monthly stats ---
    const monthMap = new Map<string, { income: number; expenditure: number; count: number }>();
    for (const t of transactions) {
      const month = t.month || (t.date ? t.date.substring(0, 7) : 'unknown');
      if (!monthMap.has(month)) monthMap.set(month, { income: 0, expenditure: 0, count: 0 });
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
    const totalExpenditure = monthlyDetails.reduce((s, m) => s + m.expenditure, 0);
    const monthCount = monthlyDetails.length || 1;

    const billOverview = {
      totalRecords: transactions.length,
      totalIncome: Math.round(totalIncome * 100) / 100,
      totalExpenditure: Math.round(totalExpenditure * 100) / 100,
      netAmount: Math.round((totalIncome - totalExpenditure) * 100) / 100,
      monthCount,
      avgMonthlyIncome: Math.round((totalIncome / monthCount) * 100) / 100,
      avgMonthlyExpenditure: Math.round((totalExpenditure / monthCount) * 100) / 100,
      monthlyDetails,
    };

    // --- Loan detection: fixed amount sequences ≥100, count ≥5, span ≤60 days ---
    const expenditures = transactions.filter((t) => t.type === '支出' && t.amount >= 100);

    type LoanGroup = { counterparty: string; amount: number; dates: Date[] };
    const loanGroupMap = new Map<string, LoanGroup>();
    for (const t of expenditures) {
      const key = `${t.counterparty}||${t.amount.toFixed(2)}`;
      if (!loanGroupMap.has(key)) {
        loanGroupMap.set(key, { counterparty: t.counterparty, amount: t.amount, dates: [] });
      }
      const dateObj = new Date(t.date.replace(/-/g, '/'));
      if (!isNaN(dateObj.getTime())) {
        loanGroupMap.get(key)!.dates.push(dateObj);
      }
    }

    const loanSequences: LoanSequence[] = [];
    for (const [, g] of loanGroupMap) {
      if (g.dates.length < 5) continue;
      g.dates.sort((a, b) => a.getTime() - b.getTime());
      const first = g.dates[0];
      const last = g.dates[g.dates.length - 1];
      const spanDays = Math.round((last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24));
      if (spanDays <= 60) {
        loanSequences.push({
          counterparty: g.counterparty,
          amount: g.amount,
          count: g.dates.length,
          firstDate: first.toISOString().substring(0, 10),
          lastDate: last.toISOString().substring(0, 10),
          spanDays,
          totalAmount: Math.round(g.amount * g.dates.length * 100) / 100,
        });
      }
    }

    const totalLoanAmount = loanSequences.reduce((s, l) => s + l.totalAmount, 0);

    // --- Gambling signals ---
    const GAMBLING_KEYWORDS = ['xyliu', '破茧成蝶', '邂逅', '上下分', '彩票', '体彩', '福彩', '快三', '时时彩'];
    let redPacketOutCount = 0;
    let redPacketOutAmount = 0;
    const gamblingCpMap = new Map<string, { out: number; inAmt: number }>();

    for (const t of transactions) {
      if (t.type === '支出' && (t.counterparty.includes('群红包') || t.counterparty.includes('红包'))) {
        redPacketOutCount++;
        redPacketOutAmount += t.amount;
      }
      const isGamble = GAMBLING_KEYWORDS.some((k) => t.counterparty.includes(k));
      if (isGamble) {
        if (!gamblingCpMap.has(t.counterparty)) gamblingCpMap.set(t.counterparty, { out: 0, inAmt: 0 });
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
    const incomeList = transactions.filter((t) => t.type === '收入' && t.amount >= 500);
    const outList = transactions.filter((t) => t.type === '支出' && t.amount >= 500);
    for (const inc of incomeList) {
      const incDate = new Date(inc.date.replace(/-/g, '/'));
      if (isNaN(incDate.getTime())) continue;
      const matchOut = outList.find((out) => {
        const outDate = new Date(out.date.replace(/-/g, '/'));
        if (isNaN(outDate.getTime())) return false;
        const diffH = Math.abs(outDate.getTime() - incDate.getTime()) / (1000 * 60 * 60);
        return diffH <= 24 && Math.abs(out.amount - inc.amount) / inc.amount < 0.1;
      });
      if (matchOut) fastInFastOutEvents++;
    }

    const suspectedGamblingCounterparties: GamblingCounterparty[] = Array.from(gamblingCpMap.entries())
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
    const cpAmountMap = new Map<string, { totalAmount: number; count: number; type: string }>();
    for (const t of transactions) {
      if (t.type === '不计收支') continue;
      const key = `${t.counterparty}||${t.type}`;
      if (!cpAmountMap.has(key)) cpAmountMap.set(key, { totalAmount: 0, count: 0, type: t.type });
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

    return {
      basicInfo,
      billOverview,
      loanSignals: {
        suspectedSequences: loanSequences,
        totalLoanAmount: Math.round(totalLoanAmount * 100) / 100,
      },
      gamblingSignals,
      topCounterparties: { byAmount },
      userInput,
    };
  }

  private buildUserPrompt(features: RiskFeatures): string {
    const bi = features.basicInfo;
    const bo = features.billOverview;
    const ls = features.loanSignals;
    const gs = features.gamblingSignals;
    const ui = features.userInput;

    const monthlyText = bo.monthlyDetails
      .map(
        (m) =>
          `  ${m.month}: 收入¥${m.income} 支出¥${m.expenditure} 结余¥${m.balance} (${m.recordCount}笔)`,
      )
      .join('\n');

    const loanText =
      ls.suspectedSequences.length > 0
        ? ls.suspectedSequences
            .map(
              (s) =>
                `  - 对手方「${s.counterparty}」，固定金额¥${s.amount}，共${s.count}笔，` +
                `时间跨度${s.spanDays}天(${s.firstDate}~${s.lastDate})，合计¥${s.totalAmount}`,
            )
            .join('\n') + `\n  合计疑似天退金额：¥${ls.totalLoanAmount}`
        : '  未发现明显固定金额天退序列（不代表无借贷，请结合交易对手方综合判断）';

    const gamblingText = [
      `  凌晨(22-6点)交易：${gs.lateNightTransactionCount}笔，占比${gs.lateNightTransactionPct}`,
      `  群红包支出：${gs.redPacketOutCount}笔，共¥${gs.redPacketOutAmount}`,
      `  快进快出事件（同天同额±10%）：${gs.fastInFastOutEvents}次`,
      gs.suspectedGamblingCounterparties.length > 0
        ? '  疑似赌博渠道：\n' +
          gs.suspectedGamblingCounterparties
            .map((c) => `    - ${c.counterparty} 支出¥${c.totalOut} 收入¥${c.totalIn} 净亏损¥${c.netLoss}`)
            .join('\n')
        : '  未识别到已知赌博关键词渠道（不代表无赌博，请结合高频小额转账判断）',
    ].join('\n');

    const topCpText = features.topCounterparties.byAmount
      .slice(0, 10)
      .map((c) => `  - 【${c.type}】${c.counterparty}  ¥${c.totalAmount}（${c.count}笔）`)
      .join('\n');

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

==== 疑似借贷天退 ====
${loanText}

==== 赌博风险信号 ====
${gamblingText}

==== 高频交易对手方（Top 10）====
${topCpText}

==== 用户口述信息 ====
口述职业：${ui.occupation || '未提供'}
口述月收入：${ui.monthlyIncome ? '¥' + ui.monthlyIncome : '未提供'}

请严格按系统提示中的 Markdown 格式输出风控分析报告。`;
  }

  async analyzeStatement(
    recordId: number,
    userId: number,
    occupation: string,
    monthlyIncome: string,
  ): Promise<string> {
    await this.assertOwnership(recordId, userId);

    const record = await this.prisma.queryRecord.findUnique({
      where: { id: recordId },
      select: { summaryJson: true, transactionsJson: true },
    });
    if (!record || !record.summaryJson || !record.transactionsJson) {
      throw new NotFoundException('账单数据不完整');
    }

    const transactions: Transaction[] = (record.transactionsJson as Record<string, unknown>[]).map(
      (t) => ({
        date: (t.date as string) || '',
        month: (t.month as string) || '',
        type: t.type as '收入' | '支出' | '不计收支',
        amount: Number(t.amount) || 0,
        counterparty: (t.counterparty as string) || '未知',
      }),
    );

    const features = this.extractRiskFeatures(
      record.summaryJson as Record<string, unknown>,
      transactions,
      { occupation, monthlyIncome },
    );

    const userPrompt = this.buildUserPrompt(features);

    const apiBase = (process.env.AI_API_BASE_URL || '').replace(/\/$/, '');
    const apiKey = process.env.AI_API_KEY || '';
    const model = process.env.AI_MODEL || 'qwen-plus';

    if (!apiBase || !apiKey || apiKey === 'your-api-key-here') {
      this.logger.warn('AI API not configured, returning placeholder response');
      return `> ⚠️ **AI 服务尚未配置**\n\n请在服务器 \`.env\` 文件中填写以下配置项，然后重启服务：\n\`\`\`\nAI_API_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1\nAI_API_KEY=your-real-api-key\nAI_MODEL=qwen-plus\n\`\`\``;
    }

    this.logger.log(`Calling AI API for record ${recordId}, model=${model}, transactions=${transactions.length}`);

    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
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

    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI 返回数据格式异常');
    }

    return content;
  }
}
