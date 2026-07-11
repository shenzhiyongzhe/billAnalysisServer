import { Test, TestingModule } from '@nestjs/testing';
import { StatementService, Transaction } from './statement.service';
import { PrismaService } from '../prisma.service';

describe('StatementService', () => {
  let service: StatementService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StatementService, { provide: PrismaService, useValue: {} }],
    }).compile();

    service = module.get<StatementService>(StatementService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('parseWechatTransactions', () => {
    const parse = (text: string) =>
      (
        service as unknown as { parseWechatTransactions(t: string): unknown[] }
      ).parseWechatTransactions(text);

    it('parses 其他 type with counterparty / when both fields are /', () => {
      const text = [
        '10001073012026051201337011622559',
        '2026-05-12',
        '01:22:34',
        '零钱通转出-',
        '到零钱',
        '其他 零钱通 5.00 / /',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-05-12 01:22:34',
        type: '不计收支',
        amount: 5,
        counterparty: '零钱通转出-到零钱',
      });
    });

    it('parses 其他 type with counterparty / when merchant id follows on next lines', () => {
      const text = [
        '4200003106202605121867725259',
        '2026-05-12',
        '02:03:15',
        '转入零钱通-',
        '来自零钱',
        '其他 零钱 380.00 /',
        '18000073072605120562108684792687',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-05-12 02:03:15',
        type: '不计收支',
        amount: 380,
        counterparty: '转入零钱通-来自零钱',
      });
    });

    it('still parses income transfer when payment method is /', () => {
      const text = [
        '1000050001202605120234991344877',
        '2026-05-12',
        '19:55:09',
        '转账 收入 / 30.00 少风哥 /',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-05-12 19:55:09',
        type: '收入',
        amount: 30,
        counterparty: '少风哥',
        bizType: '转账',
      });
    });

    it('extracts bizType and product for merchant consumption', () => {
      const text = [
        '4200003106202605121867725259',
        '2026-05-12',
        '02:03:15',
        '京东商城',
        '商户消费 支出 128.50 京东 /',
      ].join('\n');

      const txs = parse(text) as Transaction[];
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 128.5,
        bizType: '商户消费',
        product: '京东商城',
      });
    });

    it('extracts bizType for wechat red packet', () => {
      const text = [
        '1000050001202605120234991344877',
        '2026-05-12',
        '20:00:00',
        '微信红包（单发） 支出 8.88 发给张三 /',
      ].join('\n');

      const txs = parse(text) as Transaction[];
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 8.88,
        bizType: '微信红包（单发）',
      });
    });

    it('extracts bizType 其他 and product for lingqiantong', () => {
      const text = [
        '10001073012026051201337011622559',
        '2026-05-12',
        '01:22:34',
        '零钱通转出-',
        '到零钱',
        '其他 零钱通 5.00 / /',
      ].join('\n');

      const txs = parse(text) as Transaction[];
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '不计收支',
        amount: 5,
        bizType: '其他',
        product: '零钱通转出-到零钱',
        counterparty: '零钱通转出-到零钱',
      });
    });

    it('parses 其他 type with counterparty on separate line and amount line starts with amount (e.g. withdrawal)', () => {
      const text = [
        '53110001222015202603063520602141',
        '2026-03-06',
        '05:39:04',
        '零钱提现 其他 工商银行储',
        '蓄卡(1338)',
        '39.04 工商银行(13',
        '38)',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-03-06 05:39:04',
        type: '不计收支',
        amount: 39.04,
        counterparty: '零钱提现',
      });
    });

    it('parses 其他 type with counterparty and details on the same line as amount (e.g. Fenfu repayment)', () => {
      const text = [
        '53010002485131202602253285192059',
        '2026-02-25',
        '17:30:56',
        '分付还款 其他 零钱 337.00 分付 41800008316202602',
        '251894802832217',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-02-25 17:30:56',
        type: '不计收支',
        amount: 337,
        counterparty: '分付还款',
      });
    });

    it('still parses normal income transfer when transaction type is 其他 (e.g. activity reward / refund)', () => {
      const text = [
        '4200003106202604043039652035',
        '2026-04-04',
        '22:21:47',
        '其他 收入 / 0.68 活动奖励_09_20404197',
      ].join('\n');

      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2026-04-04 22:21:47',
        type: '收入',
        amount: 0.68,
        counterparty: '活动奖励_09_20404197',
      });
    });
  });

  describe('detectSourceFromText', () => {
    const detect = (text: string) =>
      (
        service as unknown as { detectSourceFromText(t: string): string | null }
      ).detectSourceFromText(text);

    it('prefers CMB statement header over Alipay counterparty text', () => {
      const text = [
        '招商银行交易流水',
        'Transaction Statement of China Merchants Bank',
        '记账日期 货币 交易金额 联机余额 交易摘要 对手信息',
        '2025-07-16 CNY 800.00 927.54 银联代付 支付宝支付科技有限公司',
      ].join('\n');

      expect(detect(text)).toBe('招商银行');
    });

    it('detects Alipay from the statement title near the beginning', () => {
      const text = [
        '编号: 2026052000085004132820654681680069189554',
        '支付宝支付科技有限公司 交易流水证明',
        '兹证明:xx(证件号码:xxxx)在其支付宝账号xxxx中明细信息如下:',
      ].join('\n');

      expect(detect(text)).toBe('支付宝');
    });

    it('does not detect Alipay from counterparty text alone', () => {
      const text = [
        '未知账单',
        '记账日期 货币 交易金额 联机余额 交易摘要 对手信息',
        '2025-07-16 CNY 800.00 927.54 银联代付 支付宝支付科技有限公司',
      ].join('\n');

      expect(detect(text)).toBeNull();
    });

    it('detects rural commercial bank from the account detail title', () => {
      const text = [
        '广东顺德农村商业银行股份有限公司',
        '账户/卡明细信息',
        '账号/卡号：6223222020253306 户名：xxxx 币种：CNY',
      ].join('\n');

      expect(detect(text)).toBe('农商银行');
    });

    it('does not detect rural commercial bank from bank name alone', () => {
      const text = [
        '未知账单',
        '对方行 广东顺德农村商业银行股份有限公司',
        '2025-06-04 10:34:43 转账 -5000.00',
      ].join('\n');

      expect(detect(text)).toBeNull();
    });
  });

  describe('parseCmbTransactions', () => {
    const parse = (text: string) =>
      (
        service as unknown as { parseCmbTransactions(t: string): Transaction[] }
      ).parseCmbTransactions(text);

    it('parses CMB row and splits counterparty from transaction type', () => {
      const txs = parse(
        '2025-06-15 CNY -45.00 18,099.10 银联快捷支付 微信转账',
      );
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2025-06-15',
        type: '支出',
        amount: 45,
        counterparty: '微信转账',
      });
    });

    it('merges wrapped interest counterparty lines', () => {
      const text = [
        '2025-06-21 CNY 11.41 89.17 账户结息 应付利息-应付个人活期存款利',
        '息(自动计提)（新)',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '收入',
        amount: 11.41,
        counterparty: '应付利息-应付个人活期存款利息(自动计提)（新)',
      });
    });

    it('merges wrapped counterparty lines but not page footers', () => {
      const text = [
        '2025-07-16 CNY 800.00 927.54 银联代付 支付宝（中国）网络技术有限公',
        '司',
        '-- 1 of 3 --',
        '2/3',
        '记账日期 货币 交易金额 联机余额 交易摘要 对手信息',
        'Date Currency Transaction',
        'Amount Balance Transaction Type Counter Party',
        '2025-07-16 CNY -79.89 847.65 快捷支付 上海哈啰普惠科技有限公司',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(2);
      expect(txs[0]).toMatchObject({
        type: '收入',
        amount: 800,
        counterparty: '支付宝（中国）网络技术有限公司',
      });
      expect(txs[0].counterparty).not.toContain('Date Currency');
      expect(txs[1]).toMatchObject({
        type: '支出',
        amount: 79.89,
        counterparty: '上海哈啰普惠科技有限公司',
      });
    });

    it('deduplicates repeated rows across page breaks', () => {
      const text = [
        '2025-10-18 CNY -20.80 1,202.59 快捷支付 小杨生煎企业管理发展（上海）',
        '有限公司',
        '-- 2 of 3 --',
        '3/3',
        '记账日期 货币 交易金额 联机余额 交易摘要 对手信息',
        '2025-10-18 CNY -20.80 1,202.59 快捷支付 小杨生煎企业管理发展（上海）',
        '有限公司',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(1);
    });
  });

  describe('parseBocomTransactions', () => {
    const parse = (text: string) =>
      (
        service as unknown as { parseBocomTransactions(t: string): unknown[] }
      ).parseBocomTransactions(text);

    it('parses BOCOM tab-separated transaction row', () => {
      const txs = parse('2025-06-28 网络支付 96.85\t96.40\t银联跨行代发 贷 Cr');
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        date: '2025-06-28',
        type: '收入',
        amount: 96.4,
        counterparty: '网络支付',
      });
    });

    it('parses BOCOM debit row', () => {
      const txs = parse('2025-06-28 手机银行 7.82\t31,800.00\t转账汇款 借 Dr');
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 31800,
        counterparty: '手机银行',
      });
    });

    it('merges multiline merchant name', () => {
      const text = [
        '2025-07-10 上海市松江区广富林街道鼓陶餐饮店',
        '（个体工 4.51\t3.70\t二维码支付 借 Dr',
      ].join('\n');
      const txs = parse(text);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        type: '支出',
        amount: 3.7,
        counterparty: '上海市松江区广富林街道鼓陶餐饮店（个体工',
      });
    });
  });

  describe('parsePdfText', () => {
    it('should reject when parsing invalid pdf buffer', async () => {
      await expect(
        (service as any).parsePdfText(Buffer.from('invalid pdf')),
      ).rejects.toThrow();
    });
  });

  describe('parseCsvFile', () => {
    const parse = (buffer: Buffer) => (service as any).parseCsvFile(buffer);

    it('rejects Alipay Cashbook with BadRequestException', async () => {
      const cashbookContent = [
        '特别提示：',
        '1.本记账单内容可表明支付宝受理了相应记账明细申请',
        '记录时间,分类,收支类型,金额,备注,账户,来源,标签',
        '2026-06-28 11:19:26,转账,支出,5000.00,感谢老姐的照顾-小梅(梅昙),招商银行,账单同步',
      ].join('\n');

      const buffer = Buffer.from(cashbookContent, 'utf-8');
      await expect(parse(buffer)).rejects.toThrow(
        '暂不支持解析支付宝记账本流水',
      );
    });

    it('parses standard Alipay Transaction Details CSV', async () => {
      const csvContent = [
        '------------------------------------------------------------------------------------',
        '导出信息：',
        '姓名：梅XX',
        '支付宝账户：19232048628',
        '起始时间：[2026-04-01 00:00:00]    终止时间：[2026-07-01 23:59:59]',
        '------------------------支付宝支付科技有限公司  电子客户回单------------------------',
        '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
        '2026-06-28 11:19:26,转账红包,小梅(梅XX),gif***@qq.com,感谢梅XX的照顾,支出,"5,000.00",招商银行储蓄卡(8759),交易成功,20260628200040011100680018462283	,	,,',
        '2026-06-27 06:40:18,日用百货,念***w,183******45,RTX4090跑包,支出,19.89,网商银行储蓄卡(6617),支付成功,2026062723001154681441324980	,	,,',
      ].join('\n');

      const buffer = Buffer.from(csvContent, 'utf-8');
      const res = await parse(buffer);

      expect(res.summary).toMatchObject({
        source: '支付宝',
        name: '梅XX',
        phoneNumber: '19232048628',
        startDate: '2026-04-01',
        endDate: '2026-07-01',
        totalIncome: 0,
        totalExpenditure: 5019.89,
        selfIncome: 0,
        selfExpenditure: 5000,
      });

      expect(res.transactions).toHaveLength(2);
      expect(res.transactions[0]).toMatchObject({
        date: '2026-06-28 11:19:26',
        type: '支出',
        amount: 5000,
        counterparty: '小梅(梅XX)',
        bizType: '转账红包',
        product: '感谢梅XX的照顾',
      });
      expect(res.transactions[1]).toMatchObject({
        date: '2026-06-27 06:40:18',
        type: '支出',
        amount: 19.89,
        counterparty: '念***w',
        bizType: '日用百货',
        product: 'RTX4090跑包',
      });
    });

    it('falls back to 匿名 when name is missing', async () => {
      const csvContent = [
        '------------------------------------------------------------------------------------',
        '导出信息：',
        '起始时间：[2026-04-01 00:00:00]    终止时间：[2026-07-01 23:59:59]',
        '------------------------支付宝支付科技有限公司  电子客户回单------------------------',
        '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
        '2026-06-27 06:40:18,日用百货,念***w,183******45,RTX4090跑包,支出,19.89,网商银行储蓄卡(6617),支付成功,2026062723001154681441324980	,	,,',
      ].join('\n');

      const buffer = Buffer.from(csvContent, 'utf-8');
      const res = await parse(buffer);

      expect(res.summary.name).toBe('匿名');
      expect(res.summary.phoneNumber).toBe('');
    });
  });
});
